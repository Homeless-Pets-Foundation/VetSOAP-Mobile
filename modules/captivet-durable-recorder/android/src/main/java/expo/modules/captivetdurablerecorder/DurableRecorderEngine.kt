package expo.modules.captivetdurablerecorder

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.os.Process
import android.os.StatFs
import android.os.SystemClock
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The durable capture pipeline: AudioRecord -> MediaCodec (AAC-LC) -> ADTS
 * frames appended to one growing audio.aac, plus a bounded manifest sidecar
 * committed on a native timer. A process singleton (object) so getStatus /
 * getLiveStats / events survive a JS reload while native keeps recording.
 *
 * Threading model (durability-critical — see plan: Capture Pipeline / On-Disk
 * Durability):
 *  - capture thread (URGENT_AUDIO): reads small PCM buffers, computes peak +
 *    captured duration, polls free space / file size, feeds the encoder input.
 *    If no encoder input buffer is free it DROPS that PCM (bounded gap) and
 *    reports a capture-drop rather than blocking the mic (which would overrun).
 *  - drain thread: dequeues encoder output, skips the codec-config (CSD)
 *    buffer, derives ADTS fields from the ACTUAL output format, prepends a
 *    7-byte ADTS header, and hands complete frames to a bounded writer queue.
 *  - writer thread: appends frames to audio.aac, maintains the complete-frame
 *    byte/count anchors, and drives the ~commitIntervalMs manifest commit
 *    (flush + fsync + atomic temp+rename + recordingProgress event) so the
 *    commit marker runs on a native thread, never a JS timer.
 *  - liveStats scheduler: pushes the high-frequency UI feed independent of the
 *    durable commit cadence.
 *
 * NEVER stop/restart the mic or encoder on a timer for durability: one
 * continuous pipeline for uninterrupted recording. Only user pause/stop, slot
 * switch, interruption, low-space, or max-size release the mic. All native
 * errors become typed error events + rejected promises; nothing crashes.
 */
internal object DurableRecorderEngine {
  // ---- Tunables ----
  private const val WRITER_QUEUE_CAPACITY = 128 // frames; ceiling before last-resort drop
  private const val INPUT_DEQUEUE_TIMEOUT_US = 20_000L
  private const val OUTPUT_DEQUEUE_TIMEOUT_US = 10_000L
  private const val WRITER_OFFER_TIMEOUT_MS = 100L
  private const val WRITER_POLL_MS = 200L
  private const val STORAGE_POLL_INTERVAL_MS = 1_000L
  private const val LIVE_STATS_INTERVAL_MS = 250L
  private const val DROP_EMIT_THROTTLE_MS = 2_000L
  private const val THREAD_JOIN_TIMEOUT_MS = 5_000L
  private const val DEFAULT_COMMIT_INTERVAL_MS = 2_000L

  private const val LOW_SPACE_BYTES = 100L * 1024 * 1024 // 100 MiB
  private const val MAX_FILE_BYTES_STOP = 240L * 1024 * 1024 // graceful stop before 250MB server cap
  private const val WARN_FILE_BYTES = 225L * 1024 * 1024
  private const val MIN_DB = -120.0

  // ---- Event names (mirror modules/captivet-durable-recorder/index.ts) ----
  private const val EVENT_PROGRESS = "recordingProgress"
  private const val EVENT_LIVE = "liveStats"
  private const val EVENT_STATE = "stateChanged"
  private const val EVENT_INTERRUPTION = "interruption"
  private const val EVENT_ERROR = "error"

  private val RECOVERABLE_STATES = setOf(
    DurableState.STARTING,
    DurableState.RECORDING,
    DurableState.PAUSED,
    DurableState.INTERRUPTED,
    DurableState.STOPPED,
    DurableState.ERROR,
  )

  // ---- Wiring ----
  @Volatile private var appContext: Context? = null
  @Volatile private var eventSink: ((String, Map<String, Any?>) -> Unit)? = null

  // ---- Active session identity / locked format ----
  @Volatile private var manifest: DurableManifest? = null
  @Volatile private var stateStr: String = DurableState.IDLE
  private var userId: String = ""
  private var recordingId: String = ""
  private var slotId: String = ""
  private var sampleRate: Int = 16000
  private var bitrate: Int = 48000
  private val channelCount: Int = 1
  private var commitIntervalMs: Long = DEFAULT_COMMIT_INTERVAL_MS

  // ---- Native components ----
  private var audioRecord: AudioRecord? = null
  private var codec: MediaCodec? = null
  private var rawFos: FileOutputStream? = null
  private var outStream: BufferedOutputStream? = null
  private var pcmBufferSize: Int = 0

  // ADTS fields derived from the actual encoder output format.
  @Volatile private var adtsObjectType = 2 // AAC-LC
  @Volatile private var adtsRateIndex = -1
  @Volatile private var adtsChannelConfig = 1

  // ---- Threads / timers ----
  private var captureThread: Thread? = null
  private var drainThread: Thread? = null
  private var writerThread: Thread? = null
  private var scheduler: ScheduledExecutorService? = null
  @Volatile private var writerQueue: ArrayBlockingQueue<ByteArray>? = null
  @Volatile private var running = false
  @Volatile private var drainFinished = false
  private val tearingDown = AtomicBoolean(false)
  private val ioLock = Any() // serializes all audio.aac writes/flushes

  // ---- Counters / metrics ----
  private val frameBoundaryBytes = AtomicLong(0) // bytes through last complete frame
  private val frameCount = AtomicLong(0)
  @Volatile private var totalSamplesRead = 0L // for capturedDurationMs
  private var totalInputSamples = 0L // for encoder PTS
  private var capturedBaseMs = 0L // seed on resume
  @Volatile private var sessionPeakDb = MIN_DB
  @Volatile private var liveMeterDb = MIN_DB
  private val droppedUnits = AtomicLong(0)
  @Volatile private var lastDropEmitMs = 0L
  @Volatile private var warnedSize = false
  @Volatile private var lastStoragePollMs = 0L
  @Volatile private var nextCommitAt = 0L

  // ---- Audio focus (folded in; do not double-handle with captivet-audio-focus
  //      for durable recordings — record.tsx consumes THIS module's interruption
  //      event for durable slots) ----
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null

  // ==========================================================================
  // Module lifecycle
  // ==========================================================================

  fun attach(sink: (String, Map<String, Any?>) -> Unit) {
    eventSink = sink
  }

  /** Module destroyed (e.g. JS reload). Keep any active recording alive; just
   *  stop emitting through a dead bridge and flush best-effort. */
  fun detach() {
    runCatching { flushBestEffort() }
    eventSink = null
  }

  // ==========================================================================
  // Public API (called from the Expo module on a background thread)
  // ==========================================================================

  @Synchronized
  fun start(ctx: Context, input: Map<String, Any?>): Map<String, Any?> {
    if (running || tearingDown.get()) {
      throw DurableRecorderException(DurableErrors.BUSY, "A durable recording is already active")
    }
    appContext = ctx.applicationContext

    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val sId = DurablePaths.requireValidId(input["slotId"] as? String, "slotId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")

    // Fail-safe defaults: 16 kHz mono 48 kbps. Only the documented options are
    // accepted; anything else snaps back to the safe profile.
    var reqRate = (input["sampleRate"] as? Number)?.toInt() ?: 16000
    if (reqRate != 16000 && reqRate != 24000) reqRate = 16000
    var reqBitrate = (input["bitrate"] as? Number)?.toInt() ?: 48000
    if (reqBitrate != 32000 && reqBitrate != 48000) reqBitrate = 48000
    commitIntervalMs = ((input["commitIntervalMs"] as? Number)?.toLong() ?: DEFAULT_COMMIT_INTERVAL_MS)
      .coerceIn(500L, 10_000L)

    userId = uId; slotId = sId; recordingId = rId
    sampleRate = reqRate; bitrate = reqBitrate
    resetSessionCounters()

    val context = appContext!!
    val dir = DurablePaths.recordingDir(context, uId, rId)
    val audio = DurablePaths.audioFile(context, uId, rId)
    val manifestFile = DurablePaths.manifestFile(context, uId, rId)

    // Pre-create dir + empty audio.aac + seed manifest BEFORE opening the mic so
    // a death immediately after Start still leaves recovery a seed manifest or an
    // orphan audio.aac to find (plan: On-Disk Durability).
    try {
      if (!dir.exists()) dir.mkdirs()
      if (!audio.exists()) audio.createNewFile()
    } catch (e: Exception) {
      throw DurableRecorderException(DurableErrors.IO, "Cannot create durable directory", e)
    }

    val nowIso = nowIso()
    val seed = DurableManifest(
      recordingId = rId,
      userId = uId,
      slotId = sId,
      state = DurableState.STARTING,
      startedAt = nowIso,
      updatedAt = nowIso,
      bitrate = bitrate,
      sampleRate = sampleRate,
      adtsFrameCount = 0,
      durationMs = 0,
      capturedDurationMs = 0,
      committedBytes = 0,
      completeFrameBytes = 0,
      peakDb = MIN_DB,
      appVersion = appVersion(context),
      buildNumber = buildNumber(context),
      audioUri = DurablePaths.fileUri(audio),
    )
    manifest = seed
    runCatching { DurableManifest.writeAtomic(manifestFile, seed) }
    setState(DurableState.STARTING)

    try {
      openPipeline(context, audio, append = audio.length() > 0, allowMicFallback = true)
      setState(DurableState.RECORDING)
      // sampleRate/bitrate may have changed via mic fallback (val fields), so copy
      // rather than mutate. This copy captures any counters the commit thread has
      // already advanced on `seed`.
      val recordingManifest = seed.copy(
        state = DurableState.RECORDING,
        updatedAt = nowIso(),
        bitrate = bitrate,
        sampleRate = sampleRate,
        audioUri = DurablePaths.fileUri(audio),
      )
      manifest = recordingManifest
      runCatching { DurableManifest.writeAtomic(manifestFile, recordingManifest) }
      return recordingManifest.toMap()
    } catch (e: Exception) {
      failStart(context, manifestFile, e)
      throw asDurable(DurableErrors.START, "Failed to start durable recording", e)
    }
  }

  @Synchronized
  fun pause(): Map<String, Any?> {
    val m = manifest ?: throw DurableRecorderException(DurableErrors.NO_SESSION, "No active recording to pause")
    if (stateStr == DurableState.PAUSED) return m.toMap()
    if (stateStr != DurableState.RECORDING) {
      throw DurableRecorderException(DurableErrors.STATE, "Cannot pause in state $stateStr")
    }
    return try {
      beginTeardown(DurableState.PAUSED, errorCode = null, async = false)
      (manifest ?: m).toMap()
    } catch (e: Exception) {
      // Rule 6: leave the file recoverable + manifest marked, but rethrow so JS
      // shows feedback. State cleanup already happened in teardown.
      manifest?.lastErrorCode = DurableErrors.PAUSE
      throw asDurable(DurableErrors.PAUSE, "Pause failed", e)
    }
  }

  @Synchronized
  fun resume(ctx: Context, input: Map<String, Any?>): Map<String, Any?> {
    if (running || tearingDown.get()) {
      throw DurableRecorderException(DurableErrors.BUSY, "A durable recording is already active")
    }
    appContext = ctx.applicationContext
    val context = appContext!!

    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")

    val manifestFile = DurablePaths.manifestFile(context, uId, rId)
    val existing = DurableManifest.read(manifestFile)
      ?: throw DurableRecorderException(DurableErrors.NO_MANIFEST, "No manifest to resume")
    if (existing.userId != uId) throw DurableRecorderException(DurableErrors.WRONG_USER, "User mismatch")
    if (existing.state == DurableState.UPLOADED || !existing.confirmedUploadAt.isNullOrEmpty()) {
      throw DurableRecorderException(DurableErrors.STATE, "Recording already uploaded")
    }
    if (existing.edited == true) {
      // Appending after an edit would produce a forbidden mixed edited/tail stream.
      throw DurableRecorderException(DurableErrors.EDITED, "Edited recordings cannot append in v1")
    }

    userId = uId; recordingId = rId; slotId = existing.slotId
    // Reopen with the LOCKED settings; never change format on resume (a different
    // sample rate would append a foreign stream into the same audio.aac).
    sampleRate = if (existing.sampleRate == 16000 || existing.sampleRate == 24000) existing.sampleRate else 16000
    bitrate = if (existing.bitrate == 32000 || existing.bitrate == 48000) existing.bitrate else 48000
    commitIntervalMs = DEFAULT_COMMIT_INTERVAL_MS
    manifest = existing
    resetSessionCounters()

    val audio = DurablePaths.audioFile(context, uId, rId)
    // Reconcile byte + frame counters and DROP any torn partial tail left by a
    // crash so append() starts exactly on a complete-frame boundary (mirrors the
    // iOS AdtsWriter.open(resumeFromByte:) behavior). Using audio.length() as the
    // boundary while seeding frameCount from the manifest would undercount frames
    // flushed since the last ~2s commit AND could append onto a partial frame.
    var resumeBoundary = 0L
    var resumeFrames = existing.adtsFrameCount
    if (audio.exists()) {
      val len = audio.length()
      val anchor = existing.completeFrameBytes.coerceIn(0L, len)
      // Prefer a bounded tail-parse from the manifest anchor (picks up frames
      // flushed since the last commit); fall back to a full header-walk if the
      // anchor is stale/torn.
      val tailAnchorOk = anchor > 0 && (anchor == len || AdtsWriter.hasSyncAt(audio, anchor))
      val parsed = if (tailAnchorOk) AdtsWriter.parseFromOffset(audio, anchor) else AdtsWriter.parseFromOffset(audio, 0)
      resumeBoundary = parsed.completeFrameBytes
      resumeFrames = if (tailAnchorOk) existing.adtsFrameCount + parsed.frameCount else parsed.frameCount
      if (len > resumeBoundary) {
        runCatching { java.io.RandomAccessFile(audio, "rw").use { it.setLength(resumeBoundary) } }
      }
    }
    frameBoundaryBytes.set(resumeBoundary)
    frameCount.set(resumeFrames)
    capturedBaseMs = existing.capturedDurationMs
    sessionPeakDb = existing.peakDb

    setState(DurableState.STARTING)
    try {
      openPipeline(context, audio, append = true, allowMicFallback = false)
      setState(DurableState.RECORDING)
      existing.state = DurableState.RECORDING
      existing.audioUri = DurablePaths.fileUri(audio)
      existing.updatedAt = nowIso()
      runCatching { DurableManifest.writeAtomic(manifestFile, existing) }
      return existing.toMap()
    } catch (e: Exception) {
      failStart(context, manifestFile, e)
      throw asDurable(DurableErrors.RESUME, "Failed to resume durable recording", e)
    }
  }

  @Synchronized
  fun stop(ctx: Context, input: Map<String, Any?>?): Map<String, Any?> {
    appContext = ctx.applicationContext
    val active = manifest
    val isActive = running || stateStr == DurableState.RECORDING ||
      stateStr == DurableState.PAUSED || stateStr == DurableState.STARTING ||
      stateStr == DurableState.INTERRUPTED

    if (active != null && isActive) {
      // Rule 6: stop() swallows native rejections; state/URI always cleaned and
      // a manifest is always returned.
      runCatching {
        if (running) {
          beginTeardown(DurableState.STOPPED, errorCode = null, async = false)
        } else {
          finalizeStateOnly(DurableState.STOPPED)
        }
      }
      return (manifest ?: active).toMap()
    }

    // No active session: return the requested manifest from disk if it exists.
    val uId = input?.get("userId") as? String
    val rId = input?.get("recordingId") as? String
    if (uId != null && rId != null && DurablePaths.isValidId(uId) && DurablePaths.isValidId(rId)) {
      val m = DurableManifest.read(DurablePaths.manifestFile(ctx, uId, rId))
      if (m != null && m.userId == uId) return m.toMap()
    }
    throw DurableRecorderException(DurableErrors.NO_SESSION, "No active recording to stop")
  }

  @Synchronized
  fun discard(ctx: Context, input: Map<String, Any?>) {
    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")
    deleteRecording(ctx.applicationContext, uId, rId)
  }

  @Synchronized
  fun purgeAfterUpload(ctx: Context, input: Map<String, Any?>) {
    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")
    deleteRecording(ctx.applicationContext, uId, rId)
  }

  fun getStatus(): Map<String, Any?>? {
    val m = manifest ?: return null
    if (stateStr == DurableState.RECORDING) {
      // Reflect the latest live counters in the snapshot (commit lags up to ~2s).
      m.capturedDurationMs = capturedDurationMs()
      m.peakDb = sessionPeakDb
    }
    return m.toMap()
  }

  fun getManifest(ctx: Context, input: Map<String, Any?>): Map<String, Any?>? {
    val uId = input["userId"] as? String ?: return null
    val rId = input["recordingId"] as? String ?: return null
    if (!DurablePaths.isValidId(uId) || !DurablePaths.isValidId(rId)) return null
    val m = DurableManifest.read(DurablePaths.manifestFile(ctx, uId, rId)) ?: return null
    if (m.userId != uId) return null
    return m.toMap()
  }

  /** Synchronous high-frequency live feed (the primary 500ms-poll path). */
  fun getLiveStats(): Map<String, Any?>? {
    if (stateStr != DurableState.RECORDING) return null
    return mapOf(
      "meteringDb" to liveMeterDb,
      "capturedDurationMs" to capturedDurationMs(),
    )
  }

  fun setServerRecordingId(ctx: Context, input: Map<String, Any?>) {
    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")
    val serverId = (input["serverRecordingId"] as? String)
      ?: throw DurableRecorderException(DurableErrors.STATE, "serverRecordingId is required")
    mutateManifest(ctx.applicationContext, uId, rId) { it.serverRecordingId = serverId }
  }

  fun setPendingConfirm(ctx: Context, input: Map<String, Any?>) {
    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")
    val pendingJson = input["pendingConfirmJson"] as? String
    if (pendingJson != null) {
      if (pendingJson.toByteArray(Charsets.UTF_8).size > 16 * 1024) {
        throw DurableRecorderException(DurableErrors.STATE, "pendingConfirmJson is too large")
      }
      runCatching { org.json.JSONObject(pendingJson) }.getOrNull()
        ?: throw DurableRecorderException(DurableErrors.STATE, "pendingConfirmJson is invalid")
    }
    mutateManifest(ctx.applicationContext, uId, rId) { it.pendingConfirmJson = pendingJson }
  }

  fun markUploaded(ctx: Context, input: Map<String, Any?>) {
    val uId = DurablePaths.requireValidId(input["userId"] as? String, "userId")
    val rId = DurablePaths.requireValidId(input["recordingId"] as? String, "recordingId")
    val confirmedAt = (input["confirmedUploadAt"] as? String)
      ?: throw DurableRecorderException(DurableErrors.STATE, "confirmedUploadAt is required")
    mutateManifest(ctx.applicationContext, uId, rId) {
      it.state = DurableState.UPLOADED
      it.confirmedUploadAt = confirmedAt
    }
  }

  /**
   * Native, incremental, bounded recovery enumeration (off the UI thread —
   * Expo runs AsyncFunction on a background thread). Returns every recoverable
   * manifest under the user's root with >=1 complete ADTS frame, EXCLUDING
   * uploaded/confirmed ones. Uses the manifest completeFrameBytes seek anchor
   * and only re-validates a bounded tail; falls back to a byte-0 incremental
   * parse only when forced (plan: Recovery enumeration).
   */
  fun listRecoverableSessions(ctx: Context, userId: String): List<Map<String, Any?>> {
    val out = ArrayList<Map<String, Any?>>()
    if (!DurablePaths.isValidId(userId)) return out
    val context = ctx.applicationContext
    val dirs = DurablePaths.userDir(context, userId).listFiles() ?: return out
    for (d in dirs) {
      if (!d.isDirectory) continue
      if (!DurablePaths.isValidId(d.name)) continue
      val recovered = runCatching { recoverOne(context, userId, d.name) }.getOrNull() ?: continue
      out.add(recovered)
    }
    return out
  }

  /** Best-effort flush invoked from Service.onTaskRemoved / module detach. */
  fun onAppTaskRemoved() {
    runCatching { flushBestEffort() }
  }

  // ==========================================================================
  // Pipeline open / teardown
  // ==========================================================================

  private fun openPipeline(context: Context, audio: File, append: Boolean, allowMicFallback: Boolean) {
    startForegroundService(context)
    openMic(allowMicFallback) // may adjust sampleRate ONLY when allowMicFallback
    openEncoder() // uses the (possibly fallback-adjusted) locked sampleRate/bitrate
    openOutputStream(audio, append)
    requestAudioFocus(context)
    running = true
    drainFinished = false
    startThreads()
    startTimers()
  }

  private fun openMic(allowFallback: Boolean) {
    audioRecord = tryOpenMic(sampleRate)
    if (audioRecord == null && allowFallback && sampleRate == 16000) {
      // Runtime fallback: 24 kHz / 48 kbps when 16 kHz is unsupported.
      sampleRate = 24000
      bitrate = 48000
      audioRecord = tryOpenMic(sampleRate)
    }
    val ar = audioRecord ?: throw DurableRecorderException(DurableErrors.MIC, "AudioRecord init failed")
    if (ar.state != AudioRecord.STATE_INITIALIZED) {
      runCatching { ar.release() }
      audioRecord = null
      throw DurableRecorderException(DurableErrors.MIC, "AudioRecord not initialized")
    }
    try {
      ar.startRecording()
    } catch (e: Exception) {
      throw DurableRecorderException(DurableErrors.MIC, "AudioRecord start failed", e)
    }
    if (ar.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      throw DurableRecorderException(DurableErrors.MIC, "AudioRecord did not enter recording state")
    }
  }

  private fun tryOpenMic(rate: Int): AudioRecord? = try {
    val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (min <= 0) {
      null
    } else {
      // Several x minBufferSize so transient writer/encoder stalls don't overrun
      // the mic ring buffer and silently drop PCM (plan: capture-side overrun).
      pcmBufferSize = min * 8
      val ar = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION, // matches today's recorder
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        pcmBufferSize,
      )
      if (ar.state != AudioRecord.STATE_INITIALIZED) {
        runCatching { ar.release() }
        null
      } else {
        ar
      }
    }
  } catch (e: Exception) {
    null
  }

  private fun openEncoder() {
    try {
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channelCount)
      format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, pcmBufferSize.coerceAtLeast(8192))
      val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      c.start()
      codec = c
      // Seed ADTS fields from config; refined when INFO_OUTPUT_FORMAT_CHANGED lands.
      adtsObjectType = 2
      adtsRateIndex = AdtsWriter.sampleRateIndex(sampleRate)
      adtsChannelConfig = channelCount
    } catch (e: Exception) {
      throw DurableRecorderException(DurableErrors.ENCODER, "AAC encoder init failed", e)
    }
  }

  private fun openOutputStream(audio: File, append: Boolean) {
    try {
      val fos = FileOutputStream(audio, append)
      rawFos = fos
      outStream = BufferedOutputStream(fos, 64 * 1024)
      frameBoundaryBytes.set(audio.length())
    } catch (e: Exception) {
      throw DurableRecorderException(DurableErrors.IO, "Cannot open audio file", e)
    }
  }

  private fun startThreads() {
    writerQueue = ArrayBlockingQueue(WRITER_QUEUE_CAPACITY)
    val w = Thread({ writerLoop() }, "durable-writer")
    writerThread = w
    w.start()
    val d = Thread({ drainLoop() }, "durable-drain")
    drainThread = d
    d.start()
    val c = Thread({ captureLoop() }, "durable-capture")
    captureThread = c
    c.start()
  }

  private fun startTimers() {
    nextCommitAt = SystemClock.elapsedRealtime() + commitIntervalMs
    val s = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "durable-livestats") }
    scheduler = s
    s.scheduleWithFixedDelay(
      { runCatching { emitLiveStatsTick() } },
      LIVE_STATS_INTERVAL_MS,
      LIVE_STATS_INTERVAL_MS,
      TimeUnit.MILLISECONDS,
    )
  }

  private fun stopTimers() {
    runCatching { scheduler?.shutdownNow() }
    scheduler = null
  }

  /**
   * Single teardown path. [async] = true is used from worker threads (which
   * cannot join themselves): it spawns a dedicated teardown thread. [async] =
   * false runs inline (from the synchronized pause/stop on the Expo worker).
   * Guarded by [tearingDown] so concurrent triggers (e.g. user pause racing an
   * audio-focus loss) only tear down once.
   */
  private fun beginTeardown(finalState: String, errorCode: String?, async: Boolean) {
    if (!tearingDown.compareAndSet(false, true)) return
    running = false
    if (async) {
      Thread({
        runCatching { doTeardown(finalState, errorCode) }
        tearingDown.set(false)
      }, "durable-teardown").start()
    } else {
      try {
        doTeardown(finalState, errorCode)
      } finally {
        tearingDown.set(false)
      }
    }
  }

  private fun doTeardown(finalState: String, errorCode: String?) {
    running = false
    // Wait for the pipeline to drain the encoder + flush the queue (bounded join
    // so a wedged native call cannot hang teardown forever; JS also watchdogs).
    joinThread(captureThread); captureThread = null
    joinThread(drainThread); drainThread = null
    joinThread(writerThread); writerThread = null
    stopTimers()
    releaseFocus()
    releaseMic()
    releaseEncoder()
    releaseOutput()
    setState(finalState)

    val ctx = appContext
    val m = manifest
    if (ctx != null && m != null) {
      val frames = frameCount.get()
      m.adtsFrameCount = frames
      m.durationMs = AdtsWriter.framesToDurationMs(frames, sampleRate)
      m.completeFrameBytes = frameBoundaryBytes.get()
      m.committedBytes = frameBoundaryBytes.get()
      m.capturedDurationMs = capturedDurationMs()
      m.peakDb = sessionPeakDb
      m.updatedAt = nowIso()
      m.state = finalState
      if (errorCode != null) m.lastErrorCode = errorCode
      runCatching { DurableManifest.writeAtomic(DurablePaths.manifestFile(ctx, m.userId, m.recordingId), m) }
    }
    stopForegroundService(ctx)
  }

  /** Paused/interrupted -> stopped without re-running the pipeline (already torn). */
  private fun finalizeStateOnly(finalState: String) {
    val ctx = appContext ?: return
    val m = manifest ?: return
    m.state = finalState
    m.updatedAt = nowIso()
    setState(finalState)
    runCatching { DurableManifest.writeAtomic(DurablePaths.manifestFile(ctx, m.userId, m.recordingId), m) }
  }

  private fun failStart(context: Context, manifestFile: File, e: Exception) {
    // Roll back a partial open; keep the file recoverable, mark manifest error.
    beginTeardown(DurableState.ERROR, (e as? DurableRecorderException)?.code ?: DurableErrors.START, async = false)
    emitError((e as? DurableRecorderException)?.code ?: DurableErrors.START, e.message ?: "start failed", recordingId)
  }

  // ==========================================================================
  // Capture / encode / write loops
  // ==========================================================================

  private fun captureLoop() {
    runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO) }
    val ar = audioRecord ?: return
    val c = codec ?: return
    val buf = ByteArray(pcmBufferSize.coerceAtLeast(2048))
    try {
      while (running) {
        val n = ar.read(buf, 0, buf.size)
        if (n < 0) {
          if (n == AudioRecord.ERROR_INVALID_OPERATION ||
            n == AudioRecord.ERROR_BAD_VALUE ||
            n == AudioRecord.ERROR_DEAD_OBJECT
          ) {
            handleFatalWorker(DurableErrors.MIC, "Microphone read error ($n)")
          }
          break
        }
        if (n == 0) continue
        updateMetrics(buf, n)
        maybePollStorage()
        feedEncoder(c, buf, n)
      }
      // Signal EOS so the encoder drains its primed frames on a clean stop/pause.
      signalEndOfStream(c)
    } catch (e: Exception) {
      handleFatalWorker(DurableErrors.CAPTURE, e.message ?: "capture failed")
    }
  }

  private fun feedEncoder(c: MediaCodec, buf: ByteArray, n: Int) {
    val inIndex = try {
      c.dequeueInputBuffer(INPUT_DEQUEUE_TIMEOUT_US)
    } catch (e: Exception) {
      -1
    }
    if (inIndex >= 0) {
      try {
        val ib = c.getInputBuffer(inIndex) ?: return
        ib.clear()
        ib.put(buf, 0, n)
        val pts = if (sampleRate > 0) totalInputSamples * 1_000_000L / sampleRate else 0L
        c.queueInputBuffer(inIndex, 0, n, pts, 0)
        totalInputSamples += (n / 2)
      } catch (e: Exception) {
        // encoder may be mid-teardown; best-effort.
      }
    } else {
      // No encoder input buffer -> pipeline backpressured -> this PCM is dropped.
      // The mic keeps running (never block read()); report a bounded gap.
      recordDrop("CAPTURE_DROP", "Encoder backpressured; dropped PCM")
    }
  }

  private fun drainLoop() {
    val c = codec ?: return
    val info = MediaCodec.BufferInfo()
    var idleTries = 0
    try {
      while (true) {
        val outIndex = try {
          c.dequeueOutputBuffer(info, OUTPUT_DEQUEUE_TIMEOUT_US)
        } catch (e: IllegalStateException) {
          // During a normal stop `running` is already false and the codec is
          // being released — expected. Mid-recording (running true) this is a
          // real encoder failure that must NOT die silently: surface it + mark
          // the manifest error + tear down (complete frames stay on disk).
          if (running) handleFatalWorker(DurableErrors.ENCODER, e.message ?: "encoder dequeue failed")
          break
        }
        when {
          outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> applyOutputFormat(c.outputFormat)
          outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
            if (!running) {
              // Drain until the queued EOS arrives; cap the wait so a missing EOS
              // can't spin forever.
              idleTries++
              if (idleTries > 200) break // ~2s
            }
          }
          outIndex >= 0 -> {
            idleTries = 0
            val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
            val isEos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
            // Skip the codec-config (CSD) buffer — ADTS carries config in-band.
            if (!isConfig && info.size > 0) {
              val ob = c.getOutputBuffer(outIndex)
              if (ob != null) {
                ob.position(info.offset)
                ob.limit(info.offset + info.size)
                val frame = ByteArray(AdtsWriter.HEADER_SIZE + info.size)
                AdtsWriter.writeHeader(frame, 0, adtsObjectType, adtsRateIndex, adtsChannelConfig, info.size)
                ob.get(frame, AdtsWriter.HEADER_SIZE, info.size)
                enqueueFrame(frame)
              }
            }
            runCatching { c.releaseOutputBuffer(outIndex, false) }
            if (isEos) break
          }
        }
      }
    } catch (e: Exception) {
      // Complete frames already enqueued stay on disk. A mid-recording drain
      // failure (running still true) must be surfaced, not swallowed — otherwise
      // the mic + wakelock + FGS stay held with no more frames and JS never
      // learns capture died (invariant 13). Normal teardown has running=false.
      if (running) handleFatalWorker(DurableErrors.ENCODER, e.message ?: "encoder drain failed")
    } finally {
      drainFinished = true
    }
  }

  private fun applyOutputFormat(fmt: MediaFormat) {
    runCatching {
      val rate = if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
        fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      } else {
        sampleRate
      }
      val ch = if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
        fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      } else {
        channelCount
      }
      val obj = if (fmt.containsKey(MediaFormat.KEY_AAC_PROFILE)) {
        fmt.getInteger(MediaFormat.KEY_AAC_PROFILE)
      } else {
        MediaCodecInfo.CodecProfileLevel.AACObjectLC
      }
      val idx = AdtsWriter.sampleRateIndex(rate)
      adtsRateIndex = if (idx >= 0) idx else AdtsWriter.sampleRateIndex(sampleRate)
      adtsChannelConfig = if (ch in 1..7) ch else channelCount
      // AACObjectLC == 2; map any LC-equivalent to object type 2.
      adtsObjectType = if (obj == MediaCodecInfo.CodecProfileLevel.AACObjectLC) 2 else obj
    }
  }

  private fun enqueueFrame(frame: ByteArray) {
    val q = writerQueue ?: return
    try {
      if (!q.offer(frame, WRITER_OFFER_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
        // Writer can't keep up: last-resort drop one COMPLETE ADTS frame. The
        // stream stays well-formed (frames are self-delimited) and decode
        // tolerates a sparse gap; report backpressure.
        recordDrop("WRITER_BACKPRESSURE", "Writer queue saturated; dropped encoded frame")
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun writerLoop() {
    val q = writerQueue ?: return
    try {
      while (true) {
        val frame = q.poll(WRITER_POLL_MS, TimeUnit.MILLISECONDS)
        if (frame != null) {
          writeFrame(frame)
        } else if (drainFinished && q.isEmpty()) {
          // Only exit once the drain thread is finished AND nothing remains, so
          // we never drop frames still queued during a stop.
          break
        }
        val now = SystemClock.elapsedRealtime()
        if (now >= nextCommitAt) {
          nextCommitAt = now + commitIntervalMs
          commitManifest()
        }
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (e: Exception) {
      handleFatalWorker(DurableErrors.IO, e.message ?: "write failed")
    }
    // Final flush so the last frames are durably on disk before release.
    synchronized(ioLock) {
      runCatching { outStream?.flush(); rawFos?.fd?.sync() }
    }
  }

  private fun writeFrame(frame: ByteArray) {
    synchronized(ioLock) {
      val os = outStream ?: return
      os.write(frame)
    }
    frameBoundaryBytes.addAndGet(frame.size.toLong())
    frameCount.incrementAndGet()
  }

  private fun signalEndOfStream(c: MediaCodec) {
    runCatching {
      val idx = c.dequeueInputBuffer(200_000L)
      if (idx >= 0) {
        val pts = if (sampleRate > 0) totalInputSamples * 1_000_000L / sampleRate else 0L
        c.queueInputBuffer(idx, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
      }
    }
  }

  // ==========================================================================
  // Metrics / storage / commit
  // ==========================================================================

  private fun updateMetrics(buf: ByteArray, n: Int) {
    var peak = 0
    var i = 0
    // Little-endian signed 16-bit PCM: hi byte signed << 8 | lo byte unsigned.
    while (i + 1 < n) {
      val lo = buf[i].toInt() and 0xFF
      val hi = buf[i + 1].toInt()
      val sample = (hi shl 8) or lo
      val a = if (sample < 0) -sample else sample
      if (a > peak) peak = a
      i += 2
    }
    val db = if (peak <= 0) MIN_DB else 20.0 * Math.log10(peak / 32768.0)
    liveMeterDb = db
    if (db > sessionPeakDb) sessionPeakDb = db
    totalSamplesRead += (n / 2)
  }

  private fun capturedDurationMs(): Long =
    capturedBaseMs + if (sampleRate > 0) totalSamplesRead * 1000L / sampleRate else 0L

  private fun maybePollStorage() {
    val now = SystemClock.elapsedRealtime()
    if (now - lastStoragePollMs < STORAGE_POLL_INTERVAL_MS) return
    lastStoragePollMs = now
    val ctx = appContext ?: return
    val free = runCatching { StatFs(ctx.filesDir.absolutePath).availableBytes }.getOrDefault(Long.MAX_VALUE)
    val size = frameBoundaryBytes.get()
    when {
      free < LOW_SPACE_BYTES -> gracefulStorageStop("low_space", "LOW_SPACE")
      size >= MAX_FILE_BYTES_STOP -> gracefulStorageStop("max_size", "AAC_SIZE_STOP")
      size >= WARN_FILE_BYTES && !warnedSize -> {
        warnedSize = true
        // Soft, non-fatal warning over the error channel (JS maps to telemetry).
        emitError("AAC_SIZE_WARNING", "Recording approaching maximum size", recordingId)
      }
    }
  }

  private fun commitManifest() {
    val ctx = appContext ?: return
    val m = manifest ?: return
    // Flush OS buffers + fsync so completeFrameBytes reflects durably-synced data.
    synchronized(ioLock) {
      runCatching { outStream?.flush(); rawFos?.fd?.sync() }
    }
    val bytes = frameBoundaryBytes.get()
    val frames = frameCount.get()
    val duration = AdtsWriter.framesToDurationMs(frames, sampleRate)
    m.adtsFrameCount = frames
    m.durationMs = duration
    m.completeFrameBytes = bytes
    m.committedBytes = bytes
    m.capturedDurationMs = capturedDurationMs()
    m.peakDb = sessionPeakDb
    m.updatedAt = nowIso()
    m.state = stateStr
    runCatching { DurableManifest.writeAtomic(DurablePaths.manifestFile(ctx, m.userId, m.recordingId), m) }
    emitProgress(m.recordingId, duration, bytes, sessionPeakDb)
  }

  private fun flushBestEffort() {
    if (manifest == null) return
    synchronized(ioLock) {
      runCatching { outStream?.flush(); rawFos?.fd?.sync() }
    }
  }

  // ==========================================================================
  // Worker-thread error / interruption handling
  // ==========================================================================

  private fun handleFatalWorker(code: String, message: String) {
    manifest?.lastErrorCode = code
    emitError(code, message, recordingId)
    // Mark error, keep frames, release resources off the worker thread.
    beginTeardown(DurableState.ERROR, code, async = true)
  }

  private fun gracefulStorageStop(reason: String, code: String) {
    manifest?.lastErrorCode = code
    emitInterruption(reason, recordingId)
    // Graceful stop preserves all complete frames; state becomes recoverable.
    beginTeardown(DurableState.STOPPED, code, async = true)
  }

  private fun onFocusLoss(reason: String) {
    if (stateStr != DurableState.RECORDING && stateStr != DurableState.PAUSED) return
    manifest?.lastErrorCode = "FOCUS_LOSS"
    emitInterruption(reason, recordingId)
    // Release the mic so the call/alarm/other app can use it; JS re-acquires via
    // resume() on AppState 'active' (we defer re-acquire to the JS layer).
    beginTeardown(DurableState.INTERRUPTED, "FOCUS_LOSS", async = true)
  }

  private fun recordDrop(code: String, message: String) {
    droppedUnits.incrementAndGet()
    val now = SystemClock.elapsedRealtime()
    if (now - lastDropEmitMs > DROP_EMIT_THROTTLE_MS) {
      lastDropEmitMs = now
      emitError(code, message, recordingId)
    }
  }

  // ==========================================================================
  // Recovery
  // ==========================================================================

  private fun recoverOne(context: Context, userId: String, recordingId: String): Map<String, Any?>? {
    val audio = DurablePaths.audioFile(context, userId, recordingId)
    if (!audio.exists()) return null
    val fileLen = audio.length()
    if (fileLen <= 0) return null // zero-byte scratch: no recoverable clinical audio
    val manifestFile = DurablePaths.manifestFile(context, userId, recordingId)
    val m = DurableManifest.read(manifestFile)

    if (m != null) {
      if (m.userId != userId) return null
      // Confirmed-uploaded (state 'uploaded' or confirmedUploadAt set) but
      // audio.aac is still on disk — the process was killed after markUploaded
      // but before purgeAfterUpload / draft-delete. Return it so the JS self-heal
      // path purges the leftover; JS routes isConfirmedUploaded manifests to
      // selfHeal (never offer), so this never resurfaces as a recovery card.
      // Skip the reparse below (irrelevant for a purge target). NEVER exclude on
      // serverRecordingId alone (created-but-unconfirmed is still recoverable).
      if (m.state == DurableState.UPLOADED || !m.confirmedUploadAt.isNullOrEmpty()) {
        // Persisted manifest already carries audioUri; return as-is for JS to purge.
        return m.toMap()
      }
      if (!RECOVERABLE_STATES.contains(m.state)) return null

      val anchorsPending = m.anchorsPending == true
      val anchor = m.completeFrameBytes
      val canTailSeek = !anchorsPending &&
        anchor > 0 &&
        fileLen >= anchor &&
        (anchor == fileLen || AdtsWriter.hasSyncAt(audio, anchor))

      if (canTailSeek) {
        // Fast path: trust the manifest anchor, only re-validate the bounded tail
        // (frames written since the last ~2s commit). Never re-parse from byte 0.
        val tail = AdtsWriter.parseFromOffset(audio, anchor)
        val totalFrames = m.adtsFrameCount + tail.frameCount
        if (totalFrames <= 0) return null
        val sr = if (tail.sampleRate > 0) tail.sampleRate else m.sampleRate
        m.adtsFrameCount = totalFrames
        m.completeFrameBytes = tail.completeFrameBytes
        m.committedBytes = tail.completeFrameBytes
        m.durationMs = AdtsWriter.framesToDurationMs(totalFrames, sr)
        m.audioUri = DurablePaths.fileUri(audio)
        // Persist the newly-discovered tail anchor before returning: submit later
        // re-reads the manifest from disk to pick the upload prefix, so without
        // this a crash between commit ticks would upload only the stale anchor and
        // drop the recovered tail (matches the byte-0 path + iOS).
        runCatching { DurableManifest.writeAtomic(manifestFile, m) }
        return m.toMap()
      }

      // Forced byte-0 incremental parse (missing/zero anchor, anchorsPending, or
      // a failed seek validation). KEEP the persisted peakDb (PCM-domain; not
      // derivable from encoded ADTS). Re-finalize so later launches go fast.
      val full = AdtsWriter.parseFromOffset(audio, 0)
      if (full.frameCount <= 0) return null
      val sr = if (full.sampleRate > 0) full.sampleRate else m.sampleRate
      m.adtsFrameCount = full.frameCount
      m.completeFrameBytes = full.completeFrameBytes
      m.committedBytes = full.completeFrameBytes
      m.durationMs = AdtsWriter.framesToDurationMs(full.frameCount, sr)
      if (full.malformed && m.state != DurableState.ERROR) {
        m.state = DurableState.ERROR
        m.lastErrorCode = "ADTS_MALFORMED"
      }
      m.audioUri = DurablePaths.fileUri(audio)
      runCatching { DurableManifest.writeAtomic(manifestFile, m) }
      return m.toMap()
    }

    // Orphan audio.aac (manifest missing/unparseable): byte-0 parse + synthesize.
    val full = AdtsWriter.parseFromOffset(audio, 0)
    if (full.frameCount <= 0) return null
    val rawSr = if (full.sampleRate > 0) full.sampleRate else 16000
    val sr = if (rawSr == 16000 || rawSr == 24000) rawSr else 16000
    val iso = nowIso() // true timestamp unknown; JS guards Intl with isNaN (Rule 11)
    val synth = DurableManifest(
      recordingId = recordingId,
      userId = userId,
      // Use the (unique) recordingId as the slotId placeholder — NOT a constant
      // like "recovered" — so two recovered orphans never collide on the same
      // draft key when the JS recovery screen restores them (iOS parity).
      slotId = recordingId,
      state = if (full.malformed) DurableState.ERROR else DurableState.STOPPED,
      startedAt = iso,
      updatedAt = iso,
      bitrate = 48000,
      sampleRate = sr,
      adtsFrameCount = full.frameCount,
      durationMs = AdtsWriter.framesToDurationMs(full.frameCount, rawSr),
      capturedDurationMs = AdtsWriter.framesToDurationMs(full.frameCount, rawSr),
      committedBytes = full.completeFrameBytes,
      completeFrameBytes = full.completeFrameBytes,
      // Unknown peak for an orphan (peakDb is PCM-domain, not derivable from
      // encoded ADTS). Use a conservative NON-silent default so the durable
      // silent-audio guard (-35 dBFS) does not falsely reject a recovered orphan
      // and block its submit (matches iOS parity).
      peakDb = -20.0,
      appVersion = appVersion(context),
      buildNumber = buildNumber(context),
      audioUri = DurablePaths.fileUri(audio),
      // Unknown edit state for an orphan -> conservatively block Continue/Add-More.
      edited = true,
    )
    runCatching { DurableManifest.writeAtomic(manifestFile, synth) }
    return synth.toMap()
  }

  // ==========================================================================
  // Delete / mutate
  // ==========================================================================

  private fun deleteRecording(context: Context, userId: String, recordingId: String) {
    if (running && this.userId == userId && this.recordingId == recordingId) {
      // Stop the active pipeline before deleting its files.
      runCatching { beginTeardown(DurableState.STOPPED, "DISCARDED", async = false) }
    }
    val dir = DurablePaths.recordingDir(context, userId, recordingId)
    if (!DurablePaths.isUnderUserRoot(context, userId, dir)) {
      throw DurableRecorderException(DurableErrors.INVALID_ID, "Resolved path escapes user root")
    }
    runCatching { dir.deleteRecursively() }
    if (manifest?.recordingId == recordingId && manifest?.userId == userId) {
      manifest = null
      stateStr = DurableState.IDLE
    }
  }

  private fun mutateManifest(context: Context, userId: String, recordingId: String, block: (DurableManifest) -> Unit) {
    val manifestFile = DurablePaths.manifestFile(context, userId, recordingId)
    val m = DurableManifest.read(manifestFile)
      ?: throw DurableRecorderException(DurableErrors.NO_MANIFEST, "Manifest not found")
    if (m.userId != userId) throw DurableRecorderException(DurableErrors.WRONG_USER, "User mismatch")
    block(m)
    m.updatedAt = nowIso()
    DurableManifest.writeAtomic(manifestFile, m)
    // Keep the in-memory active manifest in sync if it is the same recording.
    if (manifest?.recordingId == recordingId && manifest?.userId == userId) {
      manifest = m
      if (m.state == DurableState.UPLOADED) stateStr = DurableState.UPLOADED
    }
  }

  // ==========================================================================
  // Resource release
  // ==========================================================================

  private fun releaseMic() {
    runCatching { audioRecord?.stop() }
    runCatching { audioRecord?.release() }
    audioRecord = null
  }

  private fun releaseEncoder() {
    runCatching { codec?.stop() }
    runCatching { codec?.release() }
    codec = null
  }

  private fun releaseOutput() {
    synchronized(ioLock) {
      runCatching { outStream?.flush() }
      runCatching { rawFos?.fd?.sync() }
      runCatching { outStream?.close() }
      outStream = null
      rawFos = null
    }
  }

  private fun requestAudioFocus(context: Context) {
    runCatching {
      val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      audioManager = am
      val listener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
          // Non-duck loss = call / alarm / other voice app took the mic.
          AudioManager.AUDIOFOCUS_LOSS -> onFocusLoss("focus_loss")
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> onFocusLoss("focus_loss")
          // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK is volume-only -> ignore, keep recording.
          // AUDIOFOCUS_GAIN -> defer mic re-acquire to the JS layer (resume()).
        }
      }
      focusListener = listener
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val attrs = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attrs)
          .setOnAudioFocusChangeListener(listener)
          .setWillPauseWhenDucked(false) // we ignore duck ourselves
          .setAcceptsDelayedFocusGain(false)
          .build()
        focusRequest = req
        am.requestAudioFocus(req)
      } else {
        @Suppress("DEPRECATION")
        am.requestAudioFocus(listener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN)
      }
    }
  }

  private fun releaseFocus() {
    val am = audioManager ?: return
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
      } else {
        @Suppress("DEPRECATION")
        focusListener?.let { am.abandonAudioFocus(it) }
      }
    }
    focusRequest = null
    focusListener = null
    audioManager = null
  }

  private fun startForegroundService(context: Context) {
    runCatching {
      val intent = Intent(context, DurableRecorderService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }

  private fun stopForegroundService(context: Context?) {
    if (context == null) return
    runCatching { context.stopService(Intent(context, DurableRecorderService::class.java)) }
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  private fun setState(s: String) {
    stateStr = s
    emitStateChanged(recordingId, s)
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    runCatching { eventSink?.invoke(name, body) }
  }

  private fun emitProgress(id: String, throughMs: Long, completeBytes: Long, peak: Double) =
    emit(
      EVENT_PROGRESS,
      mapOf(
        "recordingId" to id,
        "committedThroughMs" to throughMs,
        "completeFrameBytes" to completeBytes,
        "peakDb" to peak,
      ),
    )

  private fun emitLiveStats(id: String, meter: Double, captured: Long) =
    emit(EVENT_LIVE, mapOf("recordingId" to id, "meteringDb" to meter, "capturedDurationMs" to captured))

  private fun emitStateChanged(id: String, s: String) =
    emit(EVENT_STATE, mapOf("recordingId" to id, "state" to s))

  private fun emitInterruption(reason: String, id: String) =
    emit(EVENT_INTERRUPTION, mapOf("recordingId" to id, "reason" to reason))

  private fun emitError(code: String, message: String, id: String?) {
    val b = HashMap<String, Any?>()
    b["code"] = code
    b["message"] = message
    if (id != null) b["recordingId"] = id
    emit(EVENT_ERROR, b)
  }

  private fun emitLiveStatsTick() {
    if (stateStr != DurableState.RECORDING) return
    emitLiveStats(recordingId, liveMeterDb, capturedDurationMs())
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private fun resetSessionCounters() {
    frameBoundaryBytes.set(0)
    frameCount.set(0)
    totalSamplesRead = 0
    totalInputSamples = 0
    capturedBaseMs = 0
    sessionPeakDb = MIN_DB
    liveMeterDb = MIN_DB
    droppedUnits.set(0)
    lastDropEmitMs = 0
    warnedSize = false
    lastStoragePollMs = 0
    drainFinished = false
  }

  private fun joinThread(t: Thread?) {
    if (t == null || t == Thread.currentThread()) return
    runCatching { t.join(THREAD_JOIN_TIMEOUT_MS) }
  }

  private fun asDurable(code: String, message: String, e: Throwable): DurableRecorderException =
    if (e is DurableRecorderException) e else DurableRecorderException(code, e.message ?: message, e)

  private fun nowIso(): String {
    val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    sdf.timeZone = TimeZone.getTimeZone("UTC")
    return sdf.format(Date())
  }

  private fun appVersion(context: Context): String = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
  }.getOrDefault("0")

  private fun buildNumber(context: Context): String = runCatching {
    val pi = context.packageManager.getPackageInfo(context.packageName, 0)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      pi.longVersionCode.toString()
    } else {
      @Suppress("DEPRECATION")
      pi.versionCode.toString()
    }
  }.getOrDefault("0")
}

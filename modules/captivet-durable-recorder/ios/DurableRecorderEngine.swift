import Foundation
import AVFoundation

/// The durable capture engine (iOS).
///
/// THREADING MODEL
/// ---------------
///  - The AVAudioEngine input tap fires on a real-time-ish internal thread. Its
///    ONLY work is: copy the PCM buffer (the tap buffer is reused by the system),
///    bump a bounded in-flight counter, and `async`-dispatch the copy to the
///    serial `writerQueue`. It NEVER touches AVAudioConverter, the file handle,
///    or the manifest, so it never blocks on disk I/O (plan: On-Disk Durability).
///  - `writerQueue` (serial) owns ALL of: AVAudioConverter A (HW PCM -> mono
///    target-rate PCM), AVAudioConverter B (mono PCM -> AAC-LC), the AdtsWriter
///    file handle, the running counters, and the DispatchSourceTimer commit tick.
///    Because it is serial, converters (which are not thread-safe) are always
///    touched from one thread, and the ~2 s commit never overlaps a buffer write.
///  - Control ops (start/pause/resume/stop/...) run on the Expo async worker
///    thread. They take `controlLock` to serialize against each other and hop
///    onto `writerQueue.sync {}` for anything that mutates the engine/writer, so
///    all engine mutation stays on the writer queue. writerQueue tasks NEVER take
///    controlLock, so there is no lock-ordering deadlock.
///  - `getLiveStats()` is synchronous and must stay cheap (JS polls it ~500 ms);
///    it reads a tiny snapshot under `statsLock`, never hopping queues.
// Inherits NSObject so the @objc AVAudioSession notification selectors below are
// valid target-action observers.
final class DurableRecorderEngine: NSObject {
  static let shared = DurableRecorderEngine()

  /// Set by the module so native events reach JS. Nil after module destroy.
  var eventEmitter: ((String, [String: Any]) -> Void)?

  // MARK: - Tunables

  private let tapBufferSize: AVAudioFrameCount = 4096
  /// Bounded writer backlog: if the encode/write pipeline stalls, drop buffers
  /// past this cap (bounded in-recording gap) instead of growing memory without
  /// limit (plan: bounded ring/serial writer queue; stall degrades to gaps).
  private let maxPendingBuffers = 64
  private let minFreeBytes: Int64 = 100 * 1024 * 1024        // graceful stop < 100 MiB free
  private let warnAudioBytes: Int = 225 * 1000 * 1000         // warn at ~225 MB
  private let stopAudioBytes: Int = 240 * 1000 * 1000         // stop before ~240 MB (< 250 MB server cap)
  private let defaultCommitIntervalMs = 2000
  private let minCommitIntervalMs = 500

  // MARK: - Locks / queues

  private let controlLock = NSLock()
  private let statsLock = NSLock()
  private let pendingLock = NSLock()
  private let writerQueue = DispatchQueue(label: "com.captivet.durable.writer", qos: .userInitiated)

  // MARK: - Current recording context (mutated under controlLock / writerQueue)

  private var currentUserId: String?
  private var currentRecordingId: String?
  private var currentSlotId: String?
  private var currentState: String = "idle"
  private var startedAtISO: String?
  private var bitrate: Int = 48000
  private var sampleRate: Int = 16000
  private var commitIntervalMs: Int = 2000

  // MARK: - Audio graph (writerQueue only)

  private var engine: AVAudioEngine?
  private var converterA: AVAudioConverter?   // HW PCM -> mono target-rate PCM
  private var converterB: AVAudioConverter?   // mono PCM -> AAC-LC
  private var monoFormat: AVAudioFormat?
  private var aacFormat: AVAudioFormat?
  private var hwFormat: AVAudioFormat?
  private var writer: AdtsWriter?
  private var commitTimer: DispatchSourceTimer?
  private var sessionActive = false
  private var observersInstalled = false
  private var warnedStorage = false

  // MARK: - Counters (writerQueue only unless noted)

  private var capturedFrames: Int64 = 0        // mono PCM frames fed to encoder
  private var runningPeakLinear: Float = 0     // whole-recording max abs (manifest peakDb)
  private var encoderErrorStreak = 0           // consecutive AAC encode failures
  private let maxEncoderErrorStreak = 10       // graceful-stop after this many in a row
  private var recentPeakLinear: Float = 0      // last-buffer level (live meter)
  private var pendingBuffers = 0               // guarded by pendingLock
  private var droppedSinceCommit = 0           // guarded by pendingLock

  // MARK: - Live snapshot (statsLock)

  private var liveMeteringDb: Double = -160
  private var liveCapturedMs: Int = 0
  private var liveIsActive = false

  private override init() { super.init() }

  // MARK: - Typed error

  enum Code: String {
    case busy = "BUSY"
    case invalidId = "INVALID_ID"
    case session = "SESSION"
    case engineStart = "ENGINE_START"
    case converter = "CONVERTER"
    case write = "WRITE"
    case noActive = "NO_ACTIVE"
    case notFound = "NOT_FOUND"
    case storage = "STORAGE"
    case state = "STATE"
    case unknown = "UNKNOWN"
  }

  /// Emit the typed `error` event (primary code channel; see index.ts) and build
  /// the Exception to reject the promise with. Message is `CODE: message` so a JS
  /// caller can also parse the code from the rejection if needed. NEVER traps.
  @discardableResult
  private func fail(_ code: Code, _ message: String, _ recordingId: String? = nil) -> DurableException {
    emitError(code, message, recordingId)
    return DurableException("\(code.rawValue): \(message)")
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    // Emitting can happen from writerQueue or notification threads; Expo handles
    // the bridge hop. Guard against a missing emitter after module destroy.
    eventEmitter?(name, body)
  }

  private func emitError(_ code: Code, _ message: String, _ recordingId: String?) {
    // Only include recordingId when present (index.ts marks it optional); adding
    // a nil under `as Any` would leak an Optional.none box across the bridge.
    var body: [String: Any] = ["code": code.rawValue, "message": message]
    if let rid = recordingId { body["recordingId"] = rid }
    emit("error", body)
  }

  // MARK: - Time / bundle helpers

  private static let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  private func nowISO() -> String { DurableRecorderEngine.isoFormatter.string(from: Date()) }

  private func appVersion() -> String {
    (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
  }

  private func buildNumber() -> String {
    (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "0"
  }

  // MARK: - Public control ops

  /// start(): pre-create dir + empty audio.aac + seed manifest BEFORE opening the
  /// mic, then bring up the session + engine. Returns the (recording) manifest.
  func start(
    userId: String,
    slotId: String,
    recordingId: String,
    commitIntervalMs commitMs: Int?,
    sampleRate reqRate: Int?,
    bitrate reqBitrate: Int?
  ) throws -> [String: Any] {
    controlLock.lock()
    defer { controlLock.unlock() }

    guard DurablePaths.isValidId(userId),
          DurablePaths.isValidId(slotId),
          DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid userId/slotId/recordingId")
    }

    // Single-owner: refuse to start while another recording actively holds the
    // mic. The multi-patient layer pauses/parks the leaving slot first.
    if currentRecordingId != nil,
       (currentState == "recording" || currentState == "starting") {
      throw fail(.busy, "another recording is active", currentRecordingId)
    }

    // Resolve/validate encoder profile. Default fail-safe 16 kHz / 48 kbps.
    var rate = reqRate ?? 16000
    if rate != 16000 && rate != 24000 { rate = 16000 }
    var rateBits = reqBitrate ?? 48000
    if rateBits != 32000 && rateBits != 48000 { rateBits = 48000 }
    var interval = commitMs ?? defaultCommitIntervalMs
    if interval < minCommitIntervalMs { interval = minCommitIntervalMs }

    // Pre-flight free space (belt for the JS-side 250 MiB block).
    if let free = DurablePaths.freeDiskBytes(), free < minFreeBytes {
      throw fail(.storage, "insufficient free space to start", recordingId)
    }

    let dir: URL
    let audioURL: URL
    do {
      dir = try DurablePaths.recordingDirURL(userId: userId, recordingId: recordingId)
      try DurablePaths.ensureDirectory(dir)
      // Backup-exclude + file-protect the whole recording dir + user root so
      // writes continue on a locked device after first unlock.
      DurablePaths.excludeFromBackup(dir)
      DurablePaths.applyFileProtection(dir)
      if let root = try? DurablePaths.durableRootURL() { DurablePaths.excludeFromBackup(root) }

      audioURL = try DurablePaths.audioURL(userId: userId, recordingId: recordingId)
      if !FileManager.default.fileExists(atPath: audioURL.path) {
        FileManager.default.createFile(atPath: audioURL.path, contents: nil)
      }
      DurablePaths.applyFileProtection(audioURL)

      // Seed manifest BEFORE the mic opens: a death right after Start still
      // leaves a parseable manifest pointing at (possibly empty) audio.aac.
      let seed = DurableManifest.seed(
        recordingId: recordingId,
        userId: userId,
        slotId: slotId,
        audioURI: audioURL.absoluteString,   // file:// URI; passes isLocalUri()
        bitrate: rateBits,
        sampleRate: rate,
        appVersion: appVersion(),
        buildNumber: buildNumber(),
        now: nowISO()
      )
      try seed.write(userId: userId, recordingId: recordingId)
    } catch let e as DurableException {
      throw e
    } catch {
      throw fail(.write, "failed to pre-create durable files: \(error)", recordingId)
    }

    // Commit context.
    currentUserId = userId
    currentRecordingId = recordingId
    currentSlotId = slotId
    startedAtISO = nowISO()
    sampleRate = rate
    bitrate = rateBits
    commitIntervalMs = interval
    resetCounters()

    // Bring up the pipeline on the writer queue.
    var thrown: DurableException?
    writerQueue.sync {
      do {
        try self.configureSession(rate: rate)
        try self.buildConverters(rate: rate, bits: rateBits)
        // buildConverters may downgrade self.sampleRate (16 kHz -> 24 kHz
        // encoder fallback); the writer's ADTS headers MUST use the effective
        // rate so the sampling_frequency_index matches the real encoded audio.
        let w = try AdtsWriter(fileURL: audioURL, sampleRate: self.sampleRate)
        try w.open(resumeFromByte: nil, seedFrameCount: 0)
        self.writer = w
        try self.installTapAndStartEngine()
        self.startCommitTimer()
        self.currentState = "recording"
        self.persistManifestLocked(state: "recording")
        self.updateLiveSnapshot(active: true)
      } catch let e as DurableException {
        thrown = e
        self.teardownPipelineLocked()
      } catch let e as AdtsWriter.WriterError {
        thrown = self.fail(.write, "writer open failed: \(e)", recordingId)
        self.teardownPipelineLocked()
      } catch {
        thrown = self.fail(.engineStart, "engine start failed: \(error)", recordingId)
        self.teardownPipelineLocked()
      }
    }

    if let e = thrown {
      // Keep the file recoverable; mark manifest error but do not delete.
      writerQueue.sync { self.persistManifestLocked(state: "error", errorCode: "start_failed") }
      currentState = "error"
      throw e
    }

    emit("stateChanged", ["recordingId": recordingId, "state": "recording"])
    return snapshotManifest(state: "recording")
  }

  /// pause(): drain encoder, fsync, release the mic, mark paused. Keeps the file
  /// fully recoverable. Rethrows a typed error only if the graceful path itself
  /// could not run — the file is preserved regardless (Rule 6 native half).
  func pause() throws -> [String: Any] {
    controlLock.lock()
    defer { controlLock.unlock() }
    guard let recordingId = currentRecordingId else {
      throw fail(.noActive, "no active recording to pause")
    }
    guard currentState == "recording" else {
      // Idempotent-ish: nothing to do; return current status.
      return snapshotManifest(state: currentState)
    }

    // Best-effort + always-preserve: the native pause never rethrows (the file
    // stays recoverable regardless); the JS compat hook owns the Rule 6 rethrow
    // + caller-feedback contract.
    writerQueue.sync {
      self.stopCommitTimer()
      self.drainAndFlushLocked()
      self.stopEngineLocked()
      self.deactivateSessionLocked()
      self.currentState = "paused"
      self.persistManifestLocked(state: "paused")
      self.updateLiveSnapshot(active: false)
      // Note: converters are torn down; resume() rebuilds them with the SAME
      // locked settings and appends to the same ADTS stream.
      self.converterA = nil
      self.converterB = nil
    }
    emit("stateChanged", ["recordingId": recordingId, "state": "paused"])
    return snapshotManifest(state: "paused")
  }

  /// resume(): reopen the writer at the manifest's completeFrameBytes anchor,
  /// rebuild converters with the locked settings, and continue appending to the
  /// same audio.aac.
  func resume(userId: String, recordingId: String) throws -> [String: Any] {
    controlLock.lock()
    defer { controlLock.unlock() }
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }

    // Load the manifest to recover locked settings + the seek anchor. This also
    // supports resuming a parked recording after an interruption / cold restart.
    guard let manifest = DurableManifest.read(userId: userId, recordingId: recordingId) else {
      throw fail(.notFound, "manifest not found for resume", recordingId)
    }
    if manifest.isConfirmedUploaded {
      throw fail(.state, "cannot resume an uploaded recording", recordingId)
    }

    let audioURL: URL
    do {
      audioURL = try DurablePaths.audioURL(userId: userId, recordingId: recordingId)
    } catch {
      throw fail(.notFound, "audio file path unresolved", recordingId)
    }

    // Adopt context (locked settings from the manifest — never re-derive).
    currentUserId = userId
    currentRecordingId = recordingId
    currentSlotId = manifest.slotId
    startedAtISO = manifest.startedAt
    sampleRate = manifest.sampleRate
    bitrate = manifest.bitrate
    if commitIntervalMs < minCommitIntervalMs { commitIntervalMs = defaultCommitIntervalMs }
    // Seed counters from the manifest so counts accumulate across resume.
    capturedFrames = Int64(manifest.capturedDurationMs) * Int64(manifest.sampleRate) / 1000
    runningPeakLinear = manifest.peakDb <= -159 ? 0 : Float(pow(10.0, manifest.peakDb / 20.0))

    var thrown: DurableException?
    writerQueue.sync {
      do {
        try self.configureSession(rate: self.sampleRate)
        // allowFallback:false — never drift the locked rate on resume (fail visibly).
        try self.buildConverters(rate: self.sampleRate, bits: self.bitrate, allowFallback: false)
        let w = try AdtsWriter(fileURL: audioURL, sampleRate: self.sampleRate)
        // Truncate any torn partial tail to the last complete-frame anchor.
        try w.open(resumeFromByte: manifest.audioFile.completeFrameBytes,
                   seedFrameCount: manifest.adtsFrameCount)
        self.writer = w
        try self.installTapAndStartEngine()
        self.startCommitTimer()
        self.currentState = "recording"
        self.persistManifestLocked(state: "recording")
        self.updateLiveSnapshot(active: true)
      } catch let e as DurableException {
        thrown = e
        self.teardownPipelineLocked()
      } catch {
        thrown = self.fail(.engineStart, "resume failed: \(error)", recordingId)
        self.teardownPipelineLocked()
      }
    }
    if let e = thrown {
      writerQueue.sync { self.persistManifestLocked(state: "error", errorCode: "resume_failed") }
      currentState = "error"
      throw e
    }
    emit("stateChanged", ["recordingId": recordingId, "state": "recording"])
    return snapshotManifest(state: "recording")
  }

  /// stop(): fully finalize the active pipeline (or, if `recordingId` targets a
  /// parked recording, just mark that manifest stopped). Swallows internal
  /// errors — the file is always left recoverable (Rule 6: stop() never rethrows).
  func stop(userId: String?, recordingId: String?) throws -> [String: Any] {
    controlLock.lock()
    defer { controlLock.unlock() }

    // Case 1: targeting a parked (non-current) recording -> mark stopped only.
    if let rid = recordingId, rid != currentRecordingId {
      guard let uid = userId ?? currentUserId, DurablePaths.isValidId(uid), DurablePaths.isValidId(rid) else {
        throw fail(.invalidId, "invalid ids for stop", rid)
      }
      guard var manifest = DurableManifest.read(userId: uid, recordingId: rid) else {
        throw fail(.notFound, "manifest not found for stop", rid)
      }
      if !manifest.isConfirmedUploaded {
        manifest.state = "stopped"
        manifest.updatedAt = nowISO()
        try? manifest.write(userId: uid, recordingId: rid)
      }
      emit("stateChanged", ["recordingId": rid, "state": manifest.state])
      return manifest.toDictionary()
    }

    // Case 2: stop the current active pipeline.
    guard let rid = currentRecordingId else {
      throw fail(.noActive, "no active recording to stop")
    }
    writerQueue.sync {
      self.stopCommitTimer()
      self.drainAndFlushLocked()
      self.stopEngineLocked()
      self.deactivateSessionLocked()
      self.currentState = "stopped"
      self.persistManifestLocked(state: "stopped")
      self.updateLiveSnapshot(active: false)
      self.teardownConvertersAndWriterLocked()
    }
    let result = snapshotManifest(state: "stopped")
    removeObservers()
    emit("stateChanged", ["recordingId": rid, "state": "stopped"])
    return result
  }

  /// discard(): explicit user delete. Stops the pipeline if it is the current
  /// recording, then removes the whole recording directory.
  func discard(userId: String, recordingId: String) throws {
    controlLock.lock()
    defer { controlLock.unlock() }
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }
    try tearDownIfCurrentAndDelete(userId: userId, recordingId: recordingId, code: .write, what: "discard")
  }

  /// purgeAfterUpload(): only after server-confirmed upload + local cleanup.
  /// Same directory removal as discard, kept distinct for call-site clarity.
  func purgeAfterUpload(userId: String, recordingId: String) throws {
    controlLock.lock()
    defer { controlLock.unlock() }
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }
    try tearDownIfCurrentAndDelete(userId: userId, recordingId: recordingId, code: .write, what: "purge")
  }

  private func tearDownIfCurrentAndDelete(userId: String, recordingId: String, code: Code, what: String) throws {
    if recordingId == currentRecordingId {
      writerQueue.sync {
        self.stopCommitTimer()
        self.stopEngineLocked()
        self.deactivateSessionLocked()
        self.teardownConvertersAndWriterLocked()
        self.currentState = "idle"
      }
      removeObservers()
      currentRecordingId = nil
      currentUserId = nil
      currentSlotId = nil
      updateLiveSnapshot(active: false)
    }
    do {
      let dir = try DurablePaths.recordingDirURL(userId: userId, recordingId: recordingId)
      if FileManager.default.fileExists(atPath: dir.path) {
        try FileManager.default.removeItem(at: dir)
      }
    } catch {
      throw fail(code, "\(what) failed to remove directory: \(error)", recordingId)
    }
  }

  // MARK: - Manifest mutations (atomic)

  func setServerRecordingId(userId: String, recordingId: String, serverRecordingId: String) throws {
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }
    guard !serverRecordingId.isEmpty else {
      throw fail(.invalidId, "empty serverRecordingId", recordingId)
    }
    try mutateManifestAtomically(userId: userId, recordingId: recordingId) { m in
      m.serverRecordingId = serverRecordingId
    }
  }

  func markUploaded(userId: String, recordingId: String, confirmedUploadAt: String) throws {
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }
    guard !confirmedUploadAt.isEmpty else {
      throw fail(.invalidId, "empty confirmedUploadAt", recordingId)
    }
    try mutateManifestAtomically(userId: userId, recordingId: recordingId) { m in
      m.state = "uploaded"
      m.confirmedUploadAt = confirmedUploadAt
    }
  }

  /// Read-modify-write a manifest atomically. Serialized on writerQueue so it
  /// never races the commit tick when mutating the current recording's manifest.
  private func mutateManifestAtomically(
    userId: String,
    recordingId: String,
    _ mutate: (inout DurableManifest) -> Void
  ) throws {
    var thrown: DurableException?
    writerQueue.sync {
      guard var manifest = DurableManifest.read(userId: userId, recordingId: recordingId) else {
        thrown = self.fail(.notFound, "manifest not found", recordingId)
        return
      }
      mutate(&manifest)
      manifest.updatedAt = self.nowISO()
      do {
        try manifest.write(userId: userId, recordingId: recordingId)
      } catch {
        thrown = self.fail(.write, "manifest write failed: \(error)", recordingId)
      }
    }
    if let e = thrown { throw e }
  }

  // MARK: - Read / recovery ops

  func getStatus() -> [String: Any]? {
    controlLock.lock()
    defer { controlLock.unlock() }
    guard currentRecordingId != nil else { return nil }
    return snapshotManifest(state: currentState)
  }

  func getManifest(userId: String, recordingId: String) throws -> [String: Any]? {
    guard DurablePaths.isValidId(userId), DurablePaths.isValidId(recordingId) else {
      throw fail(.invalidId, "invalid ids", recordingId)
    }
    return DurableManifest.read(userId: userId, recordingId: recordingId)?.toDictionary()
  }

  /// Synchronous live feed for the level meter + headline timer.
  func getLiveStats() -> [String: Any]? {
    statsLock.lock()
    defer { statsLock.unlock() }
    guard liveIsActive else { return nil }
    return ["meteringDb": liveMeteringDb, "capturedDurationMs": liveCapturedMs]
  }

  /// Enumerate recoverable sessions under one user root. BOUNDED + off-thread
  /// (the caller is an Expo async worker). Fast path: trust the manifest's
  /// completeFrameBytes anchor after a cheap sync-word check; fallback: bounded
  /// byte-0 reparse then re-finalize the manifest for future fast launches.
  func listRecoverableSessions(userId: String) throws -> [[String: Any]] {
    guard DurablePaths.isValidId(userId) else {
      throw fail(.invalidId, "invalid userId")
    }
    var results: [[String: Any]] = []
    let fm = FileManager.default
    guard let userRoot = try? DurablePaths.userRootURL(userId: userId),
          let entries = try? fm.contentsOfDirectory(at: userRoot,
                                                    includingPropertiesForKeys: nil,
                                                    options: [.skipsHiddenFiles]) else {
      return results
    }

    for dir in entries {
      var isDir: ObjCBool = false
      guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
      let recordingId = dir.lastPathComponent
      guard DurablePaths.isValidId(recordingId) else { continue }

      let audioURL = dir.appendingPathComponent(DurablePaths.audioFilename, isDirectory: false)
      guard fm.fileExists(atPath: audioURL.path) else {
        // No audio.aac -> nothing recoverable (seed-only dir may be swept by JS).
        continue
      }
      let fileSize = (try? fm.attributesOfItem(atPath: audioURL.path)[.size] as? Int) ?? nil
      let size = fileSize ?? 0

      if var manifest = DurableManifest.read(userId: userId, recordingId: recordingId) {
        // Confirmed-uploaded but audio.aac is still on disk (process killed after
        // markUploaded but before purgeAfterUpload / draft-delete). Return it so
        // the JS self-heal path purges the leftover — JS routes isConfirmedUploaded
        // manifests to selfHeal, never offer, so this never resurfaces as a card.
        // Skip the reparse/validation below (irrelevant for a purge target).
        if manifest.isConfirmedUploaded {
          results.append(manifest.toDictionary())
          continue
        }
        if !DurableManifest.recoverableStates.contains(manifest.state) { continue }

        let anchorsPending = manifest.anchorsPending ?? false
        let anchor = manifest.audioFile.completeFrameBytes
        // Fast tail-seek path: trust the manifest anchor when the file starts
        // with a valid frame AND either the file ends exactly at the anchor
        // (cleanly finalized) OR the next frame boundary at the anchor still
        // carries a sync word (more frames written since the last commit; we
        // accept the manifest's slight lag as a safe lower bound rather than
        // re-counting a bounded tail — a one-version-old manifest must not block
        // recovery). Only a torn/absent anchor forces the byte-0 reparse.
        let fastPathOK = !anchorsPending
          && manifest.adtsFrameCount > 0
          && anchor > 0
          && size >= anchor
          && AdtsScanner.hasSyncWord(at: 0, in: audioURL)
          && (size == anchor || AdtsScanner.hasSyncWord(at: anchor, in: audioURL))

        if fastPathOK {
          results.append(manifest.toDictionary())
          continue
        }

        // Fallback: bounded byte-0 reparse (header-only walk; cheap per frame).
        let scan = AdtsScanner.scanFile(url: audioURL, maxBytes: size)
        if scan.frameCount > 0 {
          manifest.adtsFrameCount = scan.frameCount
          manifest.durationMs = scan.durationMs
          manifest.audioFile.completeFrameBytes = scan.completeFrameBytes
          manifest.audioFile.committedBytes = max(manifest.audioFile.committedBytes, scan.completeFrameBytes)
          // Keep the last persisted peakDb (PCM-domain; not derivable from ADTS).
          if scan.malformed && manifest.state != "error" {
            manifest.state = "error"
            manifest.lastErrorCode = "adts_malformed"
          }
          manifest.anchorsPending = nil
          manifest.updatedAt = nowISO()
          // Re-finalize so later launches take the fast tail-seek path.
          try? manifest.write(userId: userId, recordingId: recordingId)
          if !manifest.isConfirmedUploaded,
             DurableManifest.recoverableStates.contains(manifest.state) {
            results.append(manifest.toDictionary())
          }
        }
        continue
      }

      // Orphan audio.aac (manifest missing/unparseable) with >= 1 complete frame:
      // synthesize a best-effort manifest so the audio is still recoverable.
      let scan = AdtsScanner.scanFile(url: audioURL, maxBytes: size)
      if scan.frameCount > 0, let orphan = synthesizeOrphanManifest(
        userId: userId, recordingId: recordingId, audioURL: audioURL, scan: scan
      ) {
        try? orphan.write(userId: userId, recordingId: recordingId)
        results.append(orphan.toDictionary())
      }
    }
    return results
  }

  private func synthesizeOrphanManifest(
    userId: String, recordingId: String, audioURL: URL, scan: AdtsScanner.Result
  ) -> DurableManifest? {
    // Derive sampleRate/bitrate from the parsed stream where possible; default to
    // fail-safe. slotId is unknown for an orphan, so reuse recordingId (a valid
    // id) as a placeholder the app can reconcile.
    let rate = (scan.sampleRate == 16000 || scan.sampleRate == 24000) ? scan.sampleRate : 16000
    let now = nowISO()
    return DurableManifest(
      schemaVersion: DurableManifest.schemaVersionValue,
      recordingId: recordingId,
      userId: userId,
      slotId: recordingId,
      state: "error",
      startedAt: now,
      updatedAt: now,
      container: DurableManifest.containerValue,
      codec: DurableManifest.codecValue,
      bitrate: 48000,
      sampleRate: rate,
      channels: 1,
      adtsFrameCount: scan.frameCount,
      durationMs: scan.durationMs,
      capturedDurationMs: scan.durationMs,
      audioFile: DurableManifest.AudioFile(
        uri: audioURL.absoluteString,
        committedBytes: scan.completeFrameBytes,
        completeFrameBytes: scan.completeFrameBytes
      ),
      peakDb: -20.0,   // unknown; conservative non-silent default so the guard
                       // does not falsely reject a recovered orphan
      appVersion: appVersion(),
      buildNumber: buildNumber(),
      lastErrorCode: "ORPHAN_RECOVERED",
      serverRecordingId: nil,
      confirmedUploadAt: nil,
      // Unknown edit state (the manifest carrying `edited` is gone) -> treat as
      // edited so the JS Continue/Add-More gate blocks appending a tail to
      // possibly-edited bytes (matches Android parity + Recovery UX spec).
      edited: true,
      anchorsPending: nil
    )
  }

  // MARK: - Session

  private func configureSession(rate: Int) throws {
    let session = AVAudioSession.sharedInstance()
    do {
      // The durable recorder OWNS AVAudioSession activation. playAndRecord keeps
      // capture alive when backgrounded / while the device locks (paired with
      // UIBackgroundModes: audio declared app-side). Options allow common routes.
      try session.setCategory(.playAndRecord,
                              mode: .default,
                              options: [.allowBluetooth, .defaultToSpeaker])
      try session.setActive(true, options: [])
      sessionActive = true
      installObservers()
    } catch {
      throw fail(.session, "AVAudioSession setup failed: \(error)")
    }
  }

  private func deactivateSessionLocked() {
    guard sessionActive else { return }
    do {
      // notifyOthersOnDeactivation lets any ducked app resume.
      try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
      // Non-fatal: the OS may already have deactivated us during interruption.
    }
    sessionActive = false
  }

  // MARK: - Converters

  private func buildConverters(rate: Int, bits: Int, allowFallback: Bool = true) throws {
    let inputFormat = engineInputFormat()
    hwFormat = inputFormat

    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                   sampleRate: Double(rate),
                                   channels: 1,
                                   interleaved: false) else {
      throw fail(.converter, "mono format init failed")
    }
    monoFormat = mono

    guard let convA = AVAudioConverter(from: inputFormat, to: mono) else {
      throw fail(.converter, "PCM converter init failed")
    }
    converterA = convA

    // AAC-LC compressed output format. If 16 kHz cannot init, fall back to 24 kHz
    // (plan: runtime encoder fallback).
    func makeAAC(_ r: Int) -> AVAudioFormat? {
      let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: r,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: bits,
      ]
      return AVAudioFormat(settings: settings)
    }

    var effectiveRate = rate
    var aac = makeAAC(rate)
    var monoForEncoder = mono
    // Resume passes allowFallback=false: the codec/rate are LOCKED by the first
    // frame, so a resume that cannot reopen the locked rate must fail visibly
    // rather than drift to 24 kHz and splice a different-rate stream onto the
    // existing ADTS frames (the parser flags that as corruption and truncates).
    if aac == nil && rate == 16000 && allowFallback {
      effectiveRate = 24000
      aac = makeAAC(24000)
      monoForEncoder = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                     sampleRate: 24000, channels: 1, interleaved: false) ?? mono
    }
    guard let aacFmt = aac else {
      throw fail(.converter, "AAC format init failed")
    }
    if effectiveRate != rate {
      // Rebuild stage A + writer will use the fallback rate. Update context so
      // the manifest/ADTS headers reflect the real rate.
      self.sampleRate = effectiveRate
      monoFormat = monoForEncoder
      guard let convA2 = AVAudioConverter(from: inputFormat, to: monoForEncoder) else {
        throw fail(.converter, "PCM converter (fallback) init failed")
      }
      converterA = convA2
    }
    aacFormat = aacFmt

    guard let convB = AVAudioConverter(from: monoForEncoder, to: aacFmt) else {
      throw fail(.converter, "AAC converter init failed")
    }
    convB.bitRate = bits
    converterB = convB
  }

  private func engineInputFormat() -> AVAudioFormat {
    let e = engine ?? AVAudioEngine()
    engine = e
    // Use the input node's OUTPUT bus format: this is exactly what the tap will
    // deliver, and installing a tap with any other format makes AVAudioEngine
    // assert (format.sampleRate must equal the node's hardware format). Building
    // converterA from the same format guarantees the tap buffers match.
    return e.inputNode.outputFormat(forBus: 0)
  }

  // MARK: - Engine + tap

  private func installTapAndStartEngine() throws {
    let e = engine ?? AVAudioEngine()
    engine = e
    let input = e.inputNode
    let tapFormat = hwFormat ?? input.outputFormat(forBus: 0)

    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: tapBufferSize, format: tapFormat) { [weak self] buffer, _ in
      guard let self = self else { return }
      // Real-time thread: copy + hand off, never block on I/O.
      guard let copy = self.copyPCMBuffer(buffer) else { return }

      // Bounded backlog: drop under sustained stall (bounded gap), and remember
      // so the next commit can report backpressure.
      self.pendingLock.lock()
      if self.pendingBuffers >= self.maxPendingBuffers {
        self.droppedSinceCommit += 1
        self.pendingLock.unlock()
        return
      }
      self.pendingBuffers += 1
      self.pendingLock.unlock()

      self.writerQueue.async {
        self.processBufferLocked(copy)
        self.pendingLock.lock()
        self.pendingBuffers = max(0, self.pendingBuffers - 1)
        self.pendingLock.unlock()
      }
    }

    e.prepare()
    do {
      try e.start()
    } catch {
      input.removeTap(onBus: 0)
      throw fail(.engineStart, "AVAudioEngine.start failed: \(error)")
    }
  }

  private func stopEngineLocked() {
    guard let e = engine else { return }
    e.inputNode.removeTap(onBus: 0)
    if e.isRunning { e.stop() }
    // Keep the engine instance for possible reuse; converters/writer are torn
    // down separately.
  }

  private func copyPCMBuffer(_ src: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: src.format, frameCapacity: src.frameCapacity) else {
      return nil
    }
    copy.frameLength = src.frameLength
    let channels = Int(src.format.channelCount)
    let frames = Int(src.frameLength)
    if let s = src.floatChannelData, let d = copy.floatChannelData {
      for c in 0..<channels { memcpy(d[c], s[c], frames * MemoryLayout<Float>.size) }
      return copy
    }
    if let s = src.int16ChannelData, let d = copy.int16ChannelData {
      for c in 0..<channels { memcpy(d[c], s[c], frames * MemoryLayout<Int16>.size) }
      return copy
    }
    if let s = src.int32ChannelData, let d = copy.int32ChannelData {
      for c in 0..<channels { memcpy(d[c], s[c], frames * MemoryLayout<Int32>.size) }
      return copy
    }
    return nil
  }

  // MARK: - Buffer processing (writerQueue)

  private func processBufferLocked(_ hwBuffer: AVAudioPCMBuffer) {
    guard let mono = convertToMonoLocked(hwBuffer) else { return }
    // Running + recent PCM peak (pre-encode) for manifest peakDb + live meter.
    if let ch = mono.floatChannelData {
      let p = ch[0]
      var maxAbs: Float = 0
      let n = Int(mono.frameLength)
      var i = 0
      while i < n { let v = abs(p[i]); if v > maxAbs { maxAbs = v }; i += 1 }
      if maxAbs > runningPeakLinear { runningPeakLinear = maxAbs }
      recentPeakLinear = maxAbs
    }
    capturedFrames += Int64(mono.frameLength)
    encodeAndWriteLocked(mono)
    updateLiveSnapshot(active: true)
  }

  private func convertToMonoLocked(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let convA = converterA, let mono = monoFormat else { return nil }
    let ratio = mono.sampleRate / max(1.0, input.format.sampleRate)
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return nil }
    var consumed = false
    var convErr: NSError?
    let block: AVAudioConverterInputBlock = { _, outStatus in
      if consumed { outStatus.pointee = .noDataNow; return nil }
      consumed = true
      outStatus.pointee = .haveData
      return input
    }
    let status = convA.convert(to: out, error: &convErr, withInputFrom: block)
    if status == .error { return nil }
    if out.frameLength == 0 { return nil }
    return out
  }

  private func encodeAndWriteLocked(_ mono: AVAudioPCMBuffer) {
    guard let convB = converterB, let aac = aacFormat, let writer = writer else { return }
    let maxPacketSize = convB.maximumOutputPacketSize
    let approxPackets = AVAudioPacketCount(max(4, Int(mono.frameLength) / 1024 + 4))
    guard let compressed = AVAudioCompressedBuffer(format: aac,
                                                   packetCapacity: approxPackets,
                                                   maximumPacketSize: maxPacketSize) else { return }
    var provided = false
    var convErr: NSError?
    let block: AVAudioConverterInputBlock = { _, outStatus in
      if provided {
        outStatus.pointee = .noDataNow
        return nil
      }
      provided = true
      outStatus.pointee = .haveData
      return mono
    }
    let status = convB.convert(to: compressed, error: &convErr, withInputFrom: block)
    if status == .error {
      // A persistent encode failure must NOT be silently dropped (invariant 12):
      // capturedFrames/peak already advanced (live meter climbs) while no ADTS
      // frame is written. Surface it; after a run of consecutive failures,
      // graceful-stop so the complete-frame prefix is preserved + recoverable.
      emitError(.converter, "AAC encode failed: \(convErr?.localizedDescription ?? "unknown")", currentRecordingId)
      encoderErrorStreak += 1
      if encoderErrorStreak >= maxEncoderErrorStreak {
        gracefulStopLocked(reason: "error", errorCode: "encoder_failed")
      }
      return
    }
    encoderErrorStreak = 0
    writePacketsLocked(compressed, writer: writer)
  }

  /// Final encoder drain (endOfStream) so the last buffered <1024-sample block is
  /// emitted before pause/stop/interruption. Uses a fresh converter step with an
  /// endOfStream input block.
  private func drainEncoderLocked() {
    guard let convB = converterB, let aac = aacFormat, let writer = writer else { return }
    let maxPacketSize = convB.maximumOutputPacketSize
    guard let compressed = AVAudioCompressedBuffer(format: aac,
                                                   packetCapacity: 8,
                                                   maximumPacketSize: maxPacketSize) else { return }
    var convErr: NSError?
    let block: AVAudioConverterInputBlock = { _, outStatus in
      outStatus.pointee = .endOfStream
      return nil
    }
    let status = convB.convert(to: compressed, error: &convErr, withInputFrom: block)
    if status == .error { return }
    writePacketsLocked(compressed, writer: writer)
  }

  private func writePacketsLocked(_ compressed: AVAudioCompressedBuffer, writer: AdtsWriter) {
    let packetCount = Int(compressed.packetCount)
    guard packetCount > 0 else { return }
    let base = compressed.data
    if let descs = compressed.packetDescriptions {
      for i in 0..<packetCount {
        let d = descs[i]
        let offset = Int(d.mStartOffset)
        let sizeBytes = Int(d.mDataByteSize)
        guard sizeBytes > 0 else { continue }
        let pkt = Data(bytes: base.advanced(by: offset), count: sizeBytes)
        do {
          try writer.append(accessUnit: pkt)
        } catch {
          emitError(.write, "ADTS append failed: \(error)", currentRecordingId)
          break
        }
      }
    } else {
      // No per-packet descriptions: treat the whole buffer as one access unit.
      let sizeBytes = Int(compressed.byteLength)
      if sizeBytes > 0 {
        let pkt = Data(bytes: base, count: sizeBytes)
        do { try writer.append(accessUnit: pkt) }
        catch { emitError(.write, "ADTS append failed: \(error)", currentRecordingId) }
      }
    }
  }

  private func drainAndFlushLocked() {
    drainEncoderLocked()
    writer?.fsync()
  }

  // MARK: - Commit timer (writerQueue)

  private func startCommitTimer() {
    stopCommitTimer()
    let timer = DispatchSource.makeTimerSource(queue: writerQueue)
    timer.schedule(deadline: .now() + .milliseconds(commitIntervalMs),
                   repeating: .milliseconds(commitIntervalMs),
                   leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in self?.onCommitTickLocked() }
    timer.resume()
    commitTimer = timer
  }

  private func stopCommitTimer() {
    commitTimer?.cancel()
    commitTimer = nil
  }

  private func onCommitTickLocked() {
    guard currentState == "recording", let writer = writer else { return }
    writer.fsync()
    persistManifestLocked(state: "recording")
    updateLiveSnapshot(active: true)

    let durationMs = framesToDurationMs(writer.frameCount, sampleRate)
    emit("recordingProgress", [
      "recordingId": currentRecordingId ?? "",
      "committedThroughMs": durationMs,
      "completeFrameBytes": writer.completeFrameBytes,
      "peakDb": peakDb(runningPeakLinear),
    ])
    emit("liveStats", [
      "recordingId": currentRecordingId ?? "",
      "meteringDb": peakDb(recentPeakLinear),
      "capturedDurationMs": capturedDurationMs(),
    ])

    // Report bounded-writer backpressure if buffers were dropped.
    pendingLock.lock()
    let dropped = droppedSinceCommit
    droppedSinceCommit = 0
    pendingLock.unlock()
    if dropped > 0 {
      emitError(.write, "durable_writer_backpressure: dropped \(dropped) buffers", currentRecordingId)
    }

    // Storage policy (native poll — a JS poll can be starved/backgrounded).
    let size = writer.committedBytes
    if let free = DurablePaths.freeDiskBytes(), free < minFreeBytes {
      gracefulStopLocked(reason: "low_space", errorCode: "low_free_space")
      return
    }
    if size >= stopAudioBytes {
      gracefulStopLocked(reason: "low_space", errorCode: "max_file_size")
      return
    }
    if size >= warnAudioBytes && !warnedStorage {
      warnedStorage = true
      emitError(.storage, "audio.aac approaching size limit (\(size) bytes)", currentRecordingId)
    }
  }

  /// Stop capture from inside the writer queue (storage / fatal path). Preserves
  /// all complete frames; marks the manifest and emits an interruption + stopped.
  private func gracefulStopLocked(reason: String, errorCode: String) {
    let rid = currentRecordingId
    stopCommitTimer()
    drainAndFlushLocked()
    stopEngineLocked()
    deactivateSessionLocked()
    currentState = "stopped"
    persistManifestLocked(state: "stopped", errorCode: errorCode)
    updateLiveSnapshot(active: false)
    teardownConvertersAndWriterLocked()
    if let rid = rid {
      emit("interruption", ["recordingId": rid, "reason": reason])
      emit("stateChanged", ["recordingId": rid, "state": "stopped"])
    }
  }

  // MARK: - Manifest snapshot / persist (writerQueue for persist)

  private func persistManifestLocked(state: String, errorCode: String? = nil) {
    guard let userId = currentUserId, let recordingId = currentRecordingId, let slotId = currentSlotId else {
      return
    }
    // Read the on-disk manifest first so we never clobber death-surviving fields
    // (serverRecordingId, confirmedUploadAt, edited) written by other ops.
    var manifest = DurableManifest.read(userId: userId, recordingId: recordingId)
      ?? DurableManifest.seed(recordingId: recordingId, userId: userId, slotId: slotId,
                              audioURI: (try? DurablePaths.audioURL(userId: userId, recordingId: recordingId).absoluteString) ?? "",
                              bitrate: bitrate, sampleRate: sampleRate,
                              appVersion: appVersion(), buildNumber: buildNumber(), now: startedAtISO ?? nowISO())
    manifest.state = state
    manifest.slotId = slotId
    manifest.startedAt = startedAtISO ?? manifest.startedAt
    manifest.updatedAt = nowISO()
    manifest.bitrate = bitrate
    manifest.sampleRate = sampleRate
    manifest.channels = 1
    if let w = writer {
      manifest.adtsFrameCount = w.frameCount
      manifest.durationMs = framesToDurationMs(w.frameCount, sampleRate)
      manifest.audioFile.committedBytes = w.committedBytes
      manifest.audioFile.completeFrameBytes = w.completeFrameBytes
    }
    manifest.capturedDurationMs = capturedDurationMs()
    manifest.peakDb = peakDb(runningPeakLinear)
    if let code = errorCode { manifest.lastErrorCode = code }
    do {
      try manifest.write(userId: userId, recordingId: recordingId)
    } catch {
      emitError(.write, "manifest commit failed: \(error)", recordingId)
    }
  }

  /// Build a manifest dict for a return value without necessarily re-reading disk
  /// (used right after a persist). Falls back to the on-disk manifest.
  private func snapshotManifest(state: String) -> [String: Any] {
    guard let userId = currentUserId, let recordingId = currentRecordingId else {
      return [:]
    }
    if let m = DurableManifest.read(userId: userId, recordingId: recordingId) {
      return m.toDictionary()
    }
    return [:]
  }

  // MARK: - Counters / conversions

  private func resetCounters() {
    capturedFrames = 0
    runningPeakLinear = 0
    recentPeakLinear = 0
    warnedStorage = false
    pendingLock.lock()
    pendingBuffers = 0
    droppedSinceCommit = 0
    pendingLock.unlock()
  }

  private func capturedDurationMs() -> Int {
    guard sampleRate > 0 else { return 0 }
    return Int(capturedFrames * 1000 / Int64(sampleRate))
  }

  private func framesToDurationMs(_ frames: Int, _ rate: Int) -> Int {
    guard frames > 0, rate > 0 else { return 0 }
    // 1024 PCM samples per AAC-LC frame (matches adts.ts framesToDurationMs).
    return Int((Int64(frames) * 1024 * 1000) / Int64(rate))
  }

  private func peakDb(_ linear: Float) -> Double {
    if linear <= 0.0000001 { return -160.0 }
    let db = 20.0 * log10(Double(linear))
    return max(-160.0, min(0.0, db))
  }

  private func updateLiveSnapshot(active: Bool) {
    statsLock.lock()
    liveIsActive = active
    liveMeteringDb = peakDb(active ? recentPeakLinear : 0)
    liveCapturedMs = capturedDurationMs()
    statsLock.unlock()
  }

  // MARK: - Teardown

  private func teardownConvertersAndWriterLocked() {
    converterA = nil
    converterB = nil
    writer?.close()
    writer = nil
  }

  private func teardownPipelineLocked() {
    stopCommitTimer()
    stopEngineLocked()
    deactivateSessionLocked()
    teardownConvertersAndWriterLocked()
  }

  func detachEmitter() { eventEmitter = nil }

  // MARK: - Interruption / route observers

  private func installObservers() {
    guard !observersInstalled else { return }
    observersInstalled = true
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                   name: AVAudioSession.interruptionNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                   name: AVAudioSession.routeChangeNotification, object: nil)
    nc.addObserver(self, selector: #selector(handleMediaReset(_:)),
                   name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
  }

  private func removeObservers() {
    guard observersInstalled else { return }
    observersInstalled = false
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.routeChangeNotification, object: nil)
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
  }

  @objc private func handleInterruption(_ note: Notification) {
    guard let info = note.userInfo,
          let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    let rid = currentRecordingId
    switch type {
    case .began:
      // Flush + mark interrupted + release the mic. Do NOT auto re-acquire; JS
      // resumes on AppState 'active' (plan: defer re-acquire to JS).
      writerQueue.async {
        guard self.currentState == "recording" else { return }
        self.stopCommitTimer()
        self.drainAndFlushLocked()
        self.stopEngineLocked()
        self.currentState = "interrupted"
        self.persistManifestLocked(state: "interrupted", errorCode: "interruption")
        self.updateLiveSnapshot(active: false)
        self.converterA = nil
        self.converterB = nil
        if let rid = rid {
          self.emit("interruption", ["recordingId": rid, "reason": "focus_loss"])
          self.emit("stateChanged", ["recordingId": rid, "state": "interrupted"])
        }
      }
    case .ended:
      // Signal JS to re-acquire (resume) when appropriate.
      if let rid = rid {
        emit("interruption", ["recordingId": rid, "reason": "focus_gain"])
      }
    @unknown default:
      break
    }
  }

  @objc private func handleRouteChange(_ note: Notification) {
    guard let info = note.userInfo,
          let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    let rid = currentRecordingId
    switch reason {
    case .oldDeviceUnavailable:
      // The input device (e.g. wired headset) went away: treat like an
      // interruption — flush, mark interrupted, release, let JS resume.
      writerQueue.async {
        guard self.currentState == "recording" else { return }
        self.stopCommitTimer()
        self.drainAndFlushLocked()
        self.stopEngineLocked()
        self.currentState = "interrupted"
        self.persistManifestLocked(state: "interrupted", errorCode: "route_change")
        self.updateLiveSnapshot(active: false)
        self.converterA = nil
        self.converterB = nil
        if let rid = rid {
          self.emit("interruption", ["recordingId": rid, "reason": "route_change"])
          self.emit("stateChanged", ["recordingId": rid, "state": "interrupted"])
        }
      }
    default:
      // Non-fatal route change (new device available, category change): keep
      // capturing on the new route — just fsync the durable file. Do NOT emit
      // `interruption`: the JS hook treats every interruption as fatal
      // (finalizes + resets the durable slot), which would desync JS from the
      // still-running native recorder and orphan the capture. A benign route
      // change needs no JS action.
      writerQueue.async { self.writer?.fsync() }
    }
  }

  @objc private func handleMediaReset(_ note: Notification) {
    // Media server reset invalidates the engine/converters. Preserve frames,
    // mark interrupted, tear down; JS must resume to rebuild.
    let rid = currentRecordingId
    writerQueue.async {
      guard self.currentState == "recording" || self.currentState == "paused" else { return }
      self.stopCommitTimer()
      self.writer?.fsync()
      self.currentState = "interrupted"
      self.persistManifestLocked(state: "interrupted", errorCode: "media_reset")
      self.updateLiveSnapshot(active: false)
      self.teardownConvertersAndWriterLocked()
      self.engine = nil
      if let rid = rid {
        self.emit("interruption", ["recordingId": rid, "reason": "media_reset"])
        self.emit("stateChanged", ["recordingId": rid, "state": "interrupted"])
      }
    }
  }
}

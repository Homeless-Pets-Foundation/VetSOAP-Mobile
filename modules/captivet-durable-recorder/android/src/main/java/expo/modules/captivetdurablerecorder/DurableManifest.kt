package expo.modules.captivetdurablerecorder

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * The durable recording manifest (schemaVersion 3). Mirrors
 * DurableRecordingManifest in src/lib/durableAudio/manifest.ts EXACTLY — the JS
 * validator (validateManifestObject) rejects any shape/field drift, so the map
 * produced by [toMap] must satisfy it field-for-field.
 *
 * The manifest is a BOUNDED sidecar that drives UI/progress and the fast
 * recovery seek; it is NOT the recovery source of truth (the complete ADTS
 * prefix is). It must never grow per-frame, and a torn write must never block
 * recovery — hence the temp+rename atomic write in [writeAtomic].
 */
internal data class DurableManifest(
  val recordingId: String,
  val userId: String,
  val slotId: String,
  var state: String,
  val startedAt: String,
  var updatedAt: String,
  val bitrate: Int, // 32000 | 48000
  val sampleRate: Int, // 16000 | 24000
  var adtsFrameCount: Long,
  var durationMs: Long, // frame-derived authoritative duration (upload/recovery)
  var capturedDurationMs: Long, // last live PCM snapshot; NOT the upload duration
  var committedBytes: Long, // lower-bound UI hint
  var completeFrameBytes: Long, // last complete-frame boundary; the seek anchor
  var peakDb: Double, // running PCM peak (dBFS) measured pre-encode
  val appVersion: String,
  val buildNumber: String,
  val audioUri: String,
  var lastErrorCode: String? = null,
  var serverRecordingId: String? = null,
  var confirmedUploadAt: String? = null,
  var edited: Boolean? = null,
  var anchorsPending: Boolean? = null,
) {
  /** Convert to the JS-facing map Expo serializes for the bridge. */
  fun toMap(): Map<String, Any?> {
    val audio = HashMap<String, Any?>()
    audio["uri"] = audioUri
    audio["committedBytes"] = committedBytes
    audio["completeFrameBytes"] = completeFrameBytes

    val m = HashMap<String, Any?>()
    m["schemaVersion"] = SCHEMA_VERSION
    m["recordingId"] = recordingId
    m["userId"] = userId
    m["slotId"] = slotId
    m["state"] = state
    m["startedAt"] = startedAt
    m["updatedAt"] = updatedAt
    m["container"] = "adts"
    m["codec"] = "aac_lc"
    m["bitrate"] = bitrate
    m["sampleRate"] = sampleRate
    m["channels"] = 1
    m["adtsFrameCount"] = adtsFrameCount
    m["durationMs"] = durationMs
    m["capturedDurationMs"] = capturedDurationMs
    m["audioFile"] = audio
    m["peakDb"] = peakDb
    m["appVersion"] = appVersion
    m["buildNumber"] = buildNumber
    lastErrorCode?.let { m["lastErrorCode"] = it }
    serverRecordingId?.let { m["serverRecordingId"] = it }
    confirmedUploadAt?.let { m["confirmedUploadAt"] = it }
    edited?.let { m["edited"] = it }
    anchorsPending?.let { m["anchorsPending"] = it }
    return m
  }

  fun toJson(): String {
    val o = JSONObject()
    o.put("schemaVersion", SCHEMA_VERSION)
    o.put("recordingId", recordingId)
    o.put("userId", userId)
    o.put("slotId", slotId)
    o.put("state", state)
    o.put("startedAt", startedAt)
    o.put("updatedAt", updatedAt)
    o.put("container", "adts")
    o.put("codec", "aac_lc")
    o.put("bitrate", bitrate)
    o.put("sampleRate", sampleRate)
    o.put("channels", 1)
    o.put("adtsFrameCount", adtsFrameCount)
    o.put("durationMs", durationMs)
    o.put("capturedDurationMs", capturedDurationMs)
    val audio = JSONObject()
    audio.put("uri", audioUri)
    audio.put("committedBytes", committedBytes)
    audio.put("completeFrameBytes", completeFrameBytes)
    o.put("audioFile", audio)
    o.put("peakDb", peakDb)
    o.put("appVersion", appVersion)
    o.put("buildNumber", buildNumber)
    lastErrorCode?.let { o.put("lastErrorCode", it) }
    serverRecordingId?.let { o.put("serverRecordingId", it) }
    confirmedUploadAt?.let { o.put("confirmedUploadAt", it) }
    edited?.let { o.put("edited", it) }
    anchorsPending?.let { o.put("anchorsPending", it) }
    return o.toString()
  }

  companion object {
    const val SCHEMA_VERSION = 3

    fun fromJson(text: String): DurableManifest? = runCatching {
      val o = JSONObject(text)
      if (o.optInt("schemaVersion", -1) != SCHEMA_VERSION) return null
      val audio = o.optJSONObject("audioFile") ?: JSONObject()
      DurableManifest(
        recordingId = o.getString("recordingId"),
        userId = o.getString("userId"),
        slotId = if (o.has("slotId")) o.optString("slotId", "recovered") else "recovered",
        state = o.getString("state"),
        startedAt = o.optString("startedAt", ""),
        updatedAt = o.optString("updatedAt", ""),
        bitrate = o.optInt("bitrate", 48000),
        sampleRate = o.optInt("sampleRate", 16000),
        adtsFrameCount = o.optLong("adtsFrameCount", 0),
        durationMs = o.optLong("durationMs", 0),
        capturedDurationMs = o.optLong("capturedDurationMs", 0),
        committedBytes = audio.optLong("committedBytes", 0),
        completeFrameBytes = audio.optLong("completeFrameBytes", 0),
        peakDb = o.optDouble("peakDb", -120.0),
        appVersion = o.optString("appVersion", "0"),
        buildNumber = o.optString("buildNumber", "0"),
        audioUri = audio.optString("uri", ""),
        lastErrorCode = if (o.has("lastErrorCode")) o.optString("lastErrorCode") else null,
        serverRecordingId = if (o.has("serverRecordingId")) o.optString("serverRecordingId") else null,
        confirmedUploadAt = if (o.has("confirmedUploadAt")) o.optString("confirmedUploadAt") else null,
        edited = if (o.has("edited")) o.optBoolean("edited") else null,
        anchorsPending = if (o.has("anchorsPending")) o.optBoolean("anchorsPending") else null,
      )
    }.getOrNull()

    fun read(file: File): DurableManifest? {
      if (!file.exists()) return null
      return runCatching { fromJson(file.readText(Charsets.UTF_8)) }.getOrNull()
    }

    /**
     * Atomic manifest write: serialize to a sibling temp file, fsync it, then
     * rename onto manifest.json. Rename is atomic on the same filesystem, so a
     * crash mid-write leaves either the old good manifest or the new one —
     * never a torn JSON that would block recovery (plan: On-Disk Durability).
     */
    fun writeAtomic(file: File, manifest: DurableManifest) {
      val parent = file.parentFile ?: throw DurableRecorderException(
        DurableErrors.MANIFEST_WRITE,
        "Manifest has no parent directory",
      )
      if (!parent.exists()) parent.mkdirs()
      // Unique temp name so two concurrent writers to the SAME recording's
      // manifest (e.g. setServerRecordingId racing the commit timer) can't
      // collide on one temp file and corrupt/lose an update (matches iOS).
      val tmp = File(parent, "manifest-${java.util.UUID.randomUUID()}.json.tmp")
      val bytes = manifest.toJson().toByteArray(Charsets.UTF_8)
      try {
        FileOutputStream(tmp).use { fos ->
          fos.write(bytes)
          fos.flush()
          runCatching { fos.fd.sync() } // durably land the temp before rename
        }
      } catch (e: Exception) {
        runCatching { tmp.delete() }
        throw DurableRecorderException(DurableErrors.MANIFEST_WRITE, "Failed to write manifest temp", e)
      }
      if (!tmp.renameTo(file)) {
        // Some filesystems refuse rename-over; fall back to delete-then-rename.
        runCatching { file.delete() }
        if (!tmp.renameTo(file)) {
          runCatching { tmp.delete() }
          throw DurableRecorderException(DurableErrors.MANIFEST_WRITE, "Failed to persist manifest")
        }
      }
    }
  }
}

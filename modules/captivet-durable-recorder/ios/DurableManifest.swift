import Foundation

/// Codable DurableRecordingManifest (schema v3) + atomic disk IO.
///
/// MUST serialize to JSON that src/lib/durableAudio/manifest.ts `parseManifest`
/// accepts: schemaVersion === 3, container 'adts', codec 'aac_lc', bitrate in
/// {32000,48000}, sampleRate in {16000,24000}, channels 1, non-negative numeric
/// anchors, non-empty string timestamps, and audioFile.uri a local file URI.
///
/// The manifest is a BOUNDED sidecar that drives UI/progress and the fast
/// tail-seek recovery anchor; it is NOT the recovery source of truth (the
/// complete ADTS prefix is). A stale/torn manifest must never block recovery,
/// so all writes are atomic (temp + replace/rename) and reads tolerate failure.
struct DurableManifest: Codable {
  struct AudioFile: Codable {
    var uri: String
    var committedBytes: Int
    var completeFrameBytes: Int
  }

  var schemaVersion: Int          // always 3
  var recordingId: String
  var userId: String
  var slotId: String
  var state: String               // DurableRecorderState raw value
  var startedAt: String           // ISO 8601
  var updatedAt: String           // ISO 8601
  var container: String           // 'adts'
  var codec: String               // 'aac_lc'
  var bitrate: Int                // 32000 | 48000
  var sampleRate: Int             // 16000 | 24000
  var channels: Int               // 1
  var adtsFrameCount: Int
  var durationMs: Int             // frame-derived authoritative duration
  var capturedDurationMs: Int     // last live PCM snapshot
  var audioFile: AudioFile
  var peakDb: Double              // running PCM peak dBFS (negative; 0 = full scale)
  var appVersion: String
  var buildNumber: String
  var lastErrorCode: String?
  var serverRecordingId: String?
  var confirmedUploadAt: String?
  var edited: Bool?
  var anchorsPending: Bool?
  var pendingConfirmJson: String? = nil

  static let schemaVersionValue = 3
  static let containerValue = "adts"
  static let codecValue = "aac_lc"

  // MARK: - JS bridge representation

  /// Dictionary returned across the Expo bridge. Optionals are omitted when nil
  /// so the JS validator's optional-field handling matches (it never asserts
  /// presence of lastErrorCode/serverRecordingId/etc.).
  func toDictionary() -> [String: Any] {
    var dict: [String: Any] = [
      "schemaVersion": schemaVersion,
      "recordingId": recordingId,
      "userId": userId,
      "slotId": slotId,
      "state": state,
      "startedAt": startedAt,
      "updatedAt": updatedAt,
      "container": container,
      "codec": codec,
      "bitrate": bitrate,
      "sampleRate": sampleRate,
      "channels": channels,
      "adtsFrameCount": adtsFrameCount,
      "durationMs": durationMs,
      "capturedDurationMs": capturedDurationMs,
      "audioFile": [
        "uri": audioFile.uri,
        "committedBytes": audioFile.committedBytes,
        "completeFrameBytes": audioFile.completeFrameBytes,
      ],
      "peakDb": peakDb,
      "appVersion": appVersion,
      "buildNumber": buildNumber,
    ]
    if let lastErrorCode = lastErrorCode { dict["lastErrorCode"] = lastErrorCode }
    if let serverRecordingId = serverRecordingId { dict["serverRecordingId"] = serverRecordingId }
    if let confirmedUploadAt = confirmedUploadAt { dict["confirmedUploadAt"] = confirmedUploadAt }
    if let edited = edited { dict["edited"] = edited }
    if let anchorsPending = anchorsPending { dict["anchorsPending"] = anchorsPending }
    if let pendingConfirmJson = pendingConfirmJson { dict["pendingConfirmJson"] = pendingConfirmJson }
    return dict
  }

  // MARK: - Factory

  /// Seed manifest written by start() BEFORE the engine opens the mic, so a
  /// death immediately after Start still leaves a parseable manifest pointing at
  /// the (possibly empty) audio.aac.
  static func seed(
    recordingId: String,
    userId: String,
    slotId: String,
    audioURI: String,
    bitrate: Int,
    sampleRate: Int,
    appVersion: String,
    buildNumber: String,
    now: String
  ) -> DurableManifest {
    DurableManifest(
      schemaVersion: schemaVersionValue,
      recordingId: recordingId,
      userId: userId,
      slotId: slotId,
      state: "starting",
      startedAt: now,
      updatedAt: now,
      container: containerValue,
      codec: codecValue,
      bitrate: bitrate,
      sampleRate: sampleRate,
      channels: 1,
      adtsFrameCount: 0,
      durationMs: 0,
      capturedDurationMs: 0,
      audioFile: AudioFile(uri: audioURI, committedBytes: 0, completeFrameBytes: 0),
      peakDb: -160.0,
      appVersion: appVersion,
      buildNumber: buildNumber,
      lastErrorCode: nil,
      serverRecordingId: nil,
      confirmedUploadAt: nil,
      edited: nil,
      anchorsPending: nil
    )
  }

  // MARK: - Disk IO (atomic)

  private static func encoder() -> JSONEncoder {
    let enc = JSONEncoder()
    // Stable, compact output. outputFormatting kept default (compact) to match
    // serializeManifest()'s JSON.stringify (no pretty-printing needed).
    return enc
  }

  private static func decoder() -> JSONDecoder {
    JSONDecoder()
  }

  /// Atomically replace `url`'s contents with `data`: write a sibling temp, then
  /// FileManager.replaceItemAt (which is atomic on the same volume). When the
  /// destination does not yet exist replaceItemAt cannot run, so move into place.
  static func atomicWrite(_ data: Data, to url: URL) throws {
    let fm = FileManager.default
    let dir = url.deletingLastPathComponent()
    try DurablePaths.ensureDirectory(dir)

    let tempURL = dir.appendingPathComponent(
      ".manifest-\(UUID().uuidString).tmp",
      isDirectory: false
    )
    // Write the temp with the same file protection the durable tree uses so a
    // locked-device commit does not silently fail to fsync.
    try data.write(to: tempURL, options: [.atomic])
    DurablePaths.applyFileProtection(tempURL)

    if fm.fileExists(atPath: url.path) {
      // Atomic same-volume swap; replaceItemAt removes the temp on success.
      _ = try fm.replaceItemAt(url, withItemAt: tempURL)
    } else {
      do {
        try fm.moveItem(at: tempURL, to: url)
      } catch {
        // moveItem can fail if a racing writer just created the file; retry as a
        // replace before giving up.
        if fm.fileExists(atPath: url.path) {
          _ = try fm.replaceItemAt(url, withItemAt: tempURL)
        } else {
          // Best-effort temp cleanup, then surface the original error.
          try? fm.removeItem(at: tempURL)
          throw error
        }
      }
    }
    DurablePaths.applyFileProtection(url)
  }

  /// Serialize + atomically write this manifest to its canonical location.
  func write(userId: String, recordingId: String) throws {
    let url = try DurablePaths.manifestURL(userId: userId, recordingId: recordingId)
    let data = try DurableManifest.encoder().encode(self)
    try DurableManifest.atomicWrite(data, to: url)
  }

  /// Read + decode a manifest, or nil on any failure (missing / torn / bad
  /// schema). Never throws — a torn manifest must not break recovery.
  static func read(userId: String, recordingId: String) -> DurableManifest? {
    guard let url = try? DurablePaths.manifestURL(userId: userId, recordingId: recordingId) else {
      return nil
    }
    guard let manifest = readAt(url) else { return nil }
    // Defense-in-depth on shared tablets: a misplaced/corrupt manifest must not
    // be returned for a different user even though reads are already path-scoped
    // (matches Android's userId-match guard).
    guard manifest.userId == userId else { return nil }
    return manifest
  }

  static func readAt(_ url: URL) -> DurableManifest? {
    do {
      let data = try Data(contentsOf: url)
      let manifest = try decoder().decode(DurableManifest.self, from: data)
      // Reject anything that would fail the JS validator so callers never act on
      // an out-of-contract manifest.
      guard manifest.schemaVersion == schemaVersionValue,
            manifest.container == containerValue,
            manifest.codec == codecValue,
            DurablePaths.isValidId(manifest.recordingId),
            DurablePaths.isValidId(manifest.userId),
            DurablePaths.isValidId(manifest.slotId)
      else {
        return nil
      }
      return manifest
    } catch {
      return nil
    }
  }

  /// True iff confirmed-uploaded (state 'uploaded' OR confirmedUploadAt set).
  /// Recovery excludes ONLY on this signal, never on serverRecordingId alone.
  var isConfirmedUploaded: Bool {
    if state == "uploaded" { return true }
    if let c = confirmedUploadAt, !c.isEmpty { return true }
    return false
  }

  static let recoverableStates: Set<String> = [
    "starting", "recording", "paused", "interrupted", "stopped", "error",
  ]
}

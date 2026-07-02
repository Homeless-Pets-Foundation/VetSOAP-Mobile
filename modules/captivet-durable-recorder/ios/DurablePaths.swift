import Foundation

/// Path layout, id validation, backup-exclusion, and file-protection helpers for
/// the durable recorder.
///
/// Layout (matches src/lib/durableAudio/paths.ts):
///   <Application Support>/durable-recordings/{userId}/{recordingId}/audio.aac
///   <Application Support>/durable-recordings/{userId}/{recordingId}/manifest.json
///
/// Every entry point that accepts a userId / slotId / recordingId MUST run the
/// ids through `DurablePaths.isValidId` first (plan: reject `/`, `\`, `..`, NUL,
/// or chars outside [A-Za-z0-9_-]) and MUST resolve only under the supplied
/// userId root — user scope is NEVER inferred from a recordingId.
enum DurablePaths {
  static let dirName = "durable-recordings"
  static let audioFilename = "audio.aac"
  static let manifestFilename = "manifest.json"
  /// Recognizable suffix for pre-rename derived-edit / scratch temps the launch
  /// scratch sweep reclaims (plan: Editing for v1 + scratch sweep).
  static let tempSuffix = ".durabletmp"

  /// Typed errors surfaced as rejected promises / error events; never trap.
  enum DurableError: Error {
    case invalidId(String)
    case pathResolution(String)
  }

  // MARK: - Id validation

  // Only [A-Za-z0-9_-] is permitted. Mirrors SAFE_ID_RE in paths.ts so the JS
  // recovery/fallback path and the native path enforce the identical contract.
  private static let safeIdChars: CharacterSet = {
    var set = CharacterSet()
    set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    set.insert(charactersIn: "abcdefghijklmnopqrstuvwxyz")
    set.insert(charactersIn: "0123456789")
    set.insert(charactersIn: "_-")
    return set
  }()

  static func isValidId(_ id: String?) -> Bool {
    guard let id = id, !id.isEmpty else { return false }
    // Defense in depth: '.' is already excluded by the charset, but the plan
    // calls out '..' and NUL explicitly, so reject them directly too.
    if id.contains("..") { return false }
    if id.contains("\0") { return false }
    if id.contains("/") || id.contains("\\") { return false }
    return id.unicodeScalars.allSatisfy { safeIdChars.contains($0) }
  }

  /// Throws DurableError.invalidId unless every supplied id passes validation.
  static func requireValidIds(_ ids: [String: String?]) throws {
    for (label, value) in ids {
      guard isValidId(value) else {
        throw DurableError.invalidId(label)
      }
    }
  }

  // MARK: - Roots

  /// Application Support is app-private and persists across launches (unlike
  /// caches/temp which the OS may purge). Created on demand.
  static func applicationSupportURL() throws -> URL {
    let fm = FileManager.default
    let url = try fm.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    if !fm.fileExists(atPath: url.path) {
      try fm.createDirectory(at: url, withIntermediateDirectories: true)
    }
    return url
  }

  /// <Application Support>/durable-recordings — the backup-excluded root.
  static func durableRootURL() throws -> URL {
    let root = try applicationSupportURL().appendingPathComponent(dirName, isDirectory: true)
    try ensureDirectory(root)
    return root
  }

  /// <durable root>/{userId}. Validates userId before composing.
  static func userRootURL(userId: String) throws -> URL {
    guard isValidId(userId) else { throw DurableError.invalidId("userId") }
    let url = try durableRootURL().appendingPathComponent(userId, isDirectory: true)
    try ensureDirectory(url)
    return url
  }

  /// <durable root>/{userId}/{recordingId}. Validates BOTH ids and resolves
  /// only under the supplied userId — never infers user scope from recordingId.
  static func recordingDirURL(userId: String, recordingId: String) throws -> URL {
    guard isValidId(userId) else { throw DurableError.invalidId("userId") }
    guard isValidId(recordingId) else { throw DurableError.invalidId("recordingId") }
    let url = try userRootURL(userId: userId).appendingPathComponent(recordingId, isDirectory: true)
    // Post-compose containment check: the resolved path MUST stay under the user
    // root. Belt-and-suspenders against any future id-validation regression.
    let userRootPath = try userRootURL(userId: userId).standardizedFileURL.path
    let resolved = url.standardizedFileURL.path
    if !(resolved == userRootPath || resolved.hasPrefix(userRootPath + "/")) {
      throw DurableError.pathResolution("recordingDir escaped user root")
    }
    return url
  }

  static func audioURL(userId: String, recordingId: String) throws -> URL {
    try recordingDirURL(userId: userId, recordingId: recordingId)
      .appendingPathComponent(audioFilename, isDirectory: false)
  }

  static func manifestURL(userId: String, recordingId: String) throws -> URL {
    try recordingDirURL(userId: userId, recordingId: recordingId)
      .appendingPathComponent(manifestFilename, isDirectory: false)
  }

  // MARK: - Directory + protection helpers

  static func ensureDirectory(_ url: URL) throws {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    if fm.fileExists(atPath: url.path, isDirectory: &isDir) {
      if isDir.boolValue { return }
    }
    try fm.createDirectory(at: url, withIntermediateDirectories: true)
  }

  /// Excludes a URL from iCloud/iTunes backup (durable scratch is local-only;
  /// plan: NSURLIsExcludedFromBackupKey=true on the durable dir). Best-effort.
  static func excludeFromBackup(_ url: URL) {
    do {
      var mutable = url
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try mutable.setResourceValues(values)
    } catch {
      // Non-fatal: backup-inclusion is a privacy/cleanliness concern, never a
      // durability one. Never throw out of here.
    }
  }

  /// Applies CompleteUntilFirstUserAuthentication so writes continue on a locked
  /// device after first unlock (plan: background recording + locked-device
  /// durability). Best-effort; never throws.
  static func applyFileProtection(_ url: URL) {
    do {
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
    } catch {
      // Some volumes / simulator configs reject protection attrs; ignore.
    }
  }

  /// Frees bytes available on the Application Support volume, or nil if the
  /// query fails. Used by the capture loop's low-space gate.
  static func freeDiskBytes() -> Int64? {
    do {
      let url = try applicationSupportURL()
      let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
      if let important = values.volumeAvailableCapacityForImportantUsage {
        return important
      }
      let fallback = try url.resourceValues(forKeys: [.volumeAvailableCapacityKey])
      if let cap = fallback.volumeAvailableCapacity {
        return Int64(cap)
      }
      return nil
    } catch {
      return nil
    }
  }
}

import Foundation

/// Owns the growing `audio.aac` FileHandle and prepends a 7-byte ADTS header to
/// every AAC-LC access unit before appending.
///
/// Header layout MUST match what src/lib/durableAudio/adts.ts parses:
///   - sync word 0xFFF (byte0 = 0xFF, byte1 high nibble = 0xF)
///   - MPEG-4 (version bit 0), layer 00, protection_absent = 1 -> byte1 = 0xF1,
///     giving a 7-byte header with no CRC
///   - profile field = AOT-1 = 1 (parser adds 1 back -> 2 = AAC-LC)
///   - sampling_frequency_index derived from the actual encoder output rate
///   - channel_config = 1 (mono)
///   - frame_length = 7 + payloadLength (INCLUDES the 7-byte header)
///   - adts_buffer_fullness = 0x7FF (VBR), number_of_raw_data_blocks = 0 (1 block)
///
/// NOT thread-safe: the engine drives every call from its single serial writer
/// queue so the real-time tap never touches the file handle directly.
final class AdtsWriter {
  enum WriterError: Error {
    case openFailed(String)
    case writeFailed(String)
    case unsupportedSampleRate(Int)
  }

  private let fileURL: URL
  private let sampleRateIndex: Int
  private var handle: FileHandle?

  /// Absolute byte offset of the end of the last COMPLETE frame written. Because
  /// we only ever append whole frames, this equals the current file length after
  /// each successful append and is the sole safe recovery seek anchor.
  private(set) var completeFrameBytes: Int = 0
  /// Total bytes handed to the file handle. Kept equal to completeFrameBytes
  /// (whole-frame writes only); exposed separately to fill the manifest's
  /// lower-bound UI hint.
  private(set) var committedBytes: Int = 0
  /// Complete ADTS frames written across this file's whole lifetime (seeded from
  /// the manifest on resume so counts accumulate across pause/resume).
  private(set) var frameCount: Int = 0

  // ADTS sampling-frequency index table (mirror of adts.ts SAMPLE_RATES).
  private static let sampleRateTable: [Int] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ]

  static func sampleRateIndex(for rate: Int) -> Int? {
    sampleRateTable.firstIndex(of: rate)
  }

  init(fileURL: URL, sampleRate: Int) throws {
    guard let idx = AdtsWriter.sampleRateIndex(for: sampleRate) else {
      throw WriterError.unsupportedSampleRate(sampleRate)
    }
    self.fileURL = fileURL
    self.sampleRateIndex = idx
  }

  /// Open for append. `resumeFromByte` (the manifest completeFrameBytes) is used
  /// on resume to drop any partial trailing frame left by a crash before
  /// continuing to append the SAME-format ADTS stream. `seedFrameCount` carries
  /// the accumulated frame count across pause/resume.
  func open(resumeFromByte: Int?, seedFrameCount: Int) throws {
    let fm = FileManager.default
    if !fm.fileExists(atPath: fileURL.path) {
      // start() should have pre-created an empty file, but be defensive.
      fm.createFile(atPath: fileURL.path, contents: nil)
      DurablePaths.applyFileProtection(fileURL)
    }

    let fh: FileHandle
    do {
      fh = try FileHandle(forWritingTo: fileURL)
    } catch {
      throw WriterError.openFailed("\(error)")
    }

    do {
      if let anchor = resumeFromByte {
        // Truncate to the last known-good complete-frame boundary so we never
        // append after a torn partial frame. Only shrinks; never extends.
        let currentSize = (try? fm.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? nil
        let size = currentSize ?? 0
        let target = min(anchor, size)
        try fh.truncate(atOffset: UInt64(max(0, target)))
        try fh.seek(toOffset: UInt64(max(0, target)))
        completeFrameBytes = max(0, target)
        committedBytes = max(0, target)
      } else {
        // Fresh file: start at 0.
        try fh.truncate(atOffset: 0)
        try fh.seek(toOffset: 0)
        completeFrameBytes = 0
        committedBytes = 0
      }
    } catch {
      try? fh.close()
      throw WriterError.openFailed("seek/truncate: \(error)")
    }

    frameCount = max(0, seedFrameCount)
    handle = fh
  }

  /// Append one AAC-LC access unit as a full ADTS frame. Returns immediately
  /// after the (buffered) write; durability against power loss requires a later
  /// `fsync()` (called on pause/stop/interruption/commit).
  func append(accessUnit payload: Data) throws {
    guard let handle = handle else {
      throw WriterError.writeFailed("handle not open")
    }
    let frameLength = payload.count + 7
    // ADTS frame_length is a 13-bit field; a frame that big cannot occur for a
    // 1024-sample AAC block, but guard so we never emit a malformed header.
    guard frameLength <= 0x1FFF else {
      throw WriterError.writeFailed("frame too large: \(frameLength)")
    }

    var frame = AdtsWriter.header(frameLength: frameLength, sampleRateIndex: sampleRateIndex)
    frame.append(payload)

    do {
      try handle.write(contentsOf: frame)
    } catch {
      throw WriterError.writeFailed("\(error)")
    }

    // Whole frame is now on disk (page cache) -> safe against process death.
    committedBytes += frame.count
    completeFrameBytes = committedBytes
    frameCount += 1
  }

  /// Build the 7-byte MPEG-4 AAC-LC ADTS header (no CRC).
  static func header(frameLength: Int, sampleRateIndex: Int) -> Data {
    let profileField = 1            // AOT(2) - 1 -> parser reads back 2 (AAC-LC)
    let channelConfig = 1           // mono
    let bufferFullness = 0x7FF      // VBR marker
    let numRawDataBlocks = 0        // 0 => exactly one raw data block per frame

    var h = [UInt8](repeating: 0, count: 7)
    h[0] = 0xFF
    // 1111 0 00 1 : syncword low, MPEG-4 (0), layer (00), protection_absent (1).
    h[1] = 0xF1
    h[2] = UInt8(
      ((profileField & 0x03) << 6) |
      ((sampleRateIndex & 0x0F) << 2) |
      (0 << 1) |                                   // private_bit
      ((channelConfig >> 2) & 0x01)                // channel_config MSB
    )
    h[3] = UInt8(
      ((channelConfig & 0x03) << 6) |              // channel_config low 2 bits
      (((frameLength >> 11) & 0x03))               // frame_length bits 12..11
    )
    h[4] = UInt8((frameLength >> 3) & 0xFF)        // frame_length bits 10..3
    h[5] = UInt8(
      (((frameLength & 0x07) << 5)) |              // frame_length bits 2..0
      ((bufferFullness >> 6) & 0x1F)               // buffer_fullness high 5 bits
    )
    h[6] = UInt8(
      ((bufferFullness & 0x3F) << 2) |             // buffer_fullness low 6 bits
      (numRawDataBlocks & 0x03)
    )
    return Data(h)
  }

  /// Force buffered bytes to stable storage. Called on pause/stop/interruption
  /// and each commit tick so a subsequent power loss cannot lose flushed frames.
  func fsync() {
    guard let handle = handle else { return }
    do {
      try handle.synchronize()
    } catch {
      // synchronize can throw on some volumes; swallow. Frames are already in
      // the page cache (process-death safe); fsync only adds power-loss safety.
    }
  }

  /// Flush + close the file handle. Safe to call multiple times.
  func close() {
    guard let handle = handle else { return }
    do { try handle.synchronize() } catch {}
    do { try handle.close() } catch {}
    self.handle = nil
  }
}

/// Read-only ADTS recovery scanner (mirror of src/lib/durableAudio/adts.ts).
///
/// Two entry points for the recovery path:
///  - `hasSyncWord(at:in:)` — a 2-byte read used to VALIDATE the manifest's
///    completeFrameBytes anchor before trusting the fast tail-seek path.
///  - `scanFile(url:maxBytes:)` — the bounded byte-0 fallback. It walks ONLY the
///    7-byte ADTS headers, seeking past each payload, so a multi-hundred-MB file
///    costs O(frames) tiny reads (buffered), never a full-file load. It stops at
///    the first malformed frame / format drift / truncated tail exactly like the
///    JS parser (never scans forward for a later sync word — v1 rule), and
///    returns the byte offset through the last COMPLETE frame.
enum AdtsScanner {
  struct Result {
    var frameCount: Int
    var completeFrameBytes: Int
    var sampleRate: Int
    var channels: Int
    var profile: Int
    var durationMs: Int
    var truncatedFinal: Bool
    var malformed: Bool
  }

  private static let sampleRateTable: [Int] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ]

  /// Cheap validation: is there a valid ADTS sync word at `offset`?
  static func hasSyncWord(at offset: Int, in url: URL) -> Bool {
    guard offset >= 0 else { return false }
    guard let fh = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? fh.close() }
    do {
      try fh.seek(toOffset: UInt64(offset))
      guard let data = try fh.read(upToCount: 2), data.count == 2 else { return false }
      let b0 = data[data.startIndex]
      let b1 = data[data.index(after: data.startIndex)]
      // sync word 0xFFF + layer 00 (matches adts.ts readHeader).
      return b0 == 0xFF && (b1 & 0xF6) == 0xF0
    } catch {
      return false
    }
  }

  /// Bounded incremental header walk from byte 0.
  static func scanFile(url: URL, maxBytes: Int) -> Result {
    var result = Result(frameCount: 0, completeFrameBytes: 0, sampleRate: 0,
                        channels: 0, profile: 0, durationMs: 0,
                        truncatedFinal: false, malformed: false)
    guard maxBytes > 0, let fh = try? FileHandle(forReadingFrom: url) else { return result }
    defer { try? fh.close() }

    var pos = 0
    var lockedRateIndex = -1
    var lockedChannels = -1
    var lockedProfile = -1

    while pos < maxBytes {
      // Read the 7-byte fixed header (enough to compute frame_length).
      guard (try? fh.seek(toOffset: UInt64(pos))) != nil,
            let header = try? fh.read(upToCount: 7), header.count == 7 else {
        result.truncatedFinal = true
        break
      }
      let h = [UInt8](header)
      if h[0] != 0xFF || (h[1] & 0xF6) != 0xF0 {
        // Not a valid boundary: truncated tail vs corruption (matches JS).
        if pos + 7 > maxBytes { result.truncatedFinal = true } else { result.malformed = true }
        break
      }
      let sampleRateIndex = Int((h[2] >> 2) & 0x0F)
      let channels = Int(((h[2] & 0x01) << 2) | ((h[3] >> 6) & 0x03))
      let profile = Int((h[2] >> 6) & 0x03) + 1
      let frameLength = (Int(h[3] & 0x03) << 11) | (Int(h[4]) << 3) | (Int((h[5] >> 5) & 0x07))

      if sampleRateIndex >= sampleRateTable.count || channels < 1 || frameLength < 7 {
        result.malformed = true
        break
      }
      if pos + frameLength > maxBytes {
        result.truncatedFinal = true
        break
      }
      if result.frameCount == 0 {
        lockedRateIndex = sampleRateIndex
        lockedChannels = channels
        lockedProfile = profile
      } else if sampleRateIndex != lockedRateIndex
                || channels != lockedChannels
                || profile != lockedProfile {
        result.malformed = true
        break
      }
      result.frameCount += 1
      pos += frameLength
    }

    result.completeFrameBytes = pos
    result.sampleRate = lockedRateIndex >= 0 ? sampleRateTable[lockedRateIndex] : 0
    result.channels = lockedChannels >= 0 ? lockedChannels : 0
    result.profile = lockedProfile >= 0 ? lockedProfile : 0
    if result.frameCount > 0, result.sampleRate > 0 {
      result.durationMs = Int((Int64(result.frameCount) * 1024 * 1000) / Int64(result.sampleRate))
    }
    return result
  }
}

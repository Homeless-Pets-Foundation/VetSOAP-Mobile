package expo.modules.captivetdurablerecorder

import java.io.File
import java.io.RandomAccessFile

/**
 * ADTS framing for raw AAC-LC access units emitted by MediaCodec, plus a
 * bounded, incremental ADTS-prefix parser used for crash recovery.
 *
 * The 7-byte header layout MUST byte-match src/lib/durableAudio/adts.ts (the JS
 * recovery parser, which is the recovery SOURCE OF TRUTH):
 *   - syncword 0xFFF (byte0 = 0xFF, high nibble of byte1 = 1111)
 *   - MPEG-4 (version bit 0), layer 00, protection_absent = 1  -> 7-byte header
 *   - "profile" field = AAC object_type - 1 (AAC-LC object_type 2 -> field 1)
 *   - frame_length INCLUDES the 7 header bytes
 * adts.ts validates a frame via `(byte1 & 0xF6) == 0xF0`, so byte1 = 0xF1.
 */
internal object AdtsWriter {
  const val HEADER_SIZE = 7

  // ADTS sampling_frequency_index table (index -> Hz), identical to adts.ts.
  private val SAMPLE_RATE_TABLE = intArrayOf(
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  )

  fun sampleRateIndex(hz: Int): Int {
    for (i in SAMPLE_RATE_TABLE.indices) if (SAMPLE_RATE_TABLE[i] == hz) return i
    return -1
  }

  fun sampleRateForIndex(index: Int): Int =
    if (index in SAMPLE_RATE_TABLE.indices) SAMPLE_RATE_TABLE[index] else 0

  /**
   * Write a 7-byte ADTS header for one access unit into [out] at [offset].
   *
   * @param objectType  AAC object type from the encoder output format (2 = LC)
   * @param sampleRateIndex  ADTS sampling-frequency index (see table above)
   * @param channelConfig  channel configuration (1 = mono)
   * @param payloadLength  raw AAC access-unit length WITHOUT the header
   */
  fun writeHeader(
    out: ByteArray,
    offset: Int,
    objectType: Int,
    sampleRateIndex: Int,
    channelConfig: Int,
    payloadLength: Int,
  ) {
    val frameLength = payloadLength + HEADER_SIZE
    val profile = (objectType - 1) and 0x03 // ADTS "profile" field = object_type - 1

    out[offset] = 0xFF.toByte() // syncword high byte
    // 1111 (sync low) | MPEG-4 (0) | layer 00 | protection_absent 1  => 0xF1
    out[offset + 1] = 0xF1.toByte()
    out[offset + 2] = (
      (profile shl 6) or
        ((sampleRateIndex and 0x0F) shl 2) or
        ((channelConfig shr 2) and 0x01)
      ).toByte()
    out[offset + 3] = (
      ((channelConfig and 0x03) shl 6) or
        ((frameLength shr 11) and 0x03)
      ).toByte()
    out[offset + 4] = ((frameLength shr 3) and 0xFF).toByte()
    // frame_length low 3 bits | buffer_fullness high 5 bits (0x1F = VBR 0x7FF)
    out[offset + 5] = (((frameLength and 0x07) shl 5) or 0x1F).toByte()
    // buffer_fullness low 6 bits (0x3F) | number_of_raw_data_blocks (0)
    out[offset + 6] = 0xFC.toByte()
  }

  fun framesToDurationMs(frameCount: Long, sampleRate: Int): Long {
    if (frameCount <= 0 || sampleRate <= 0) return 0
    // AAC-LC = 1024 PCM samples per frame; durationMs = frames * 1024 / sampleRate.
    return frameCount * 1024L * 1000L / sampleRate
  }

  /** True if a valid ADTS sync word begins at [offset] — validates a seek anchor. */
  fun hasSyncAt(file: File, offset: Long): Boolean {
    if (offset < 0) return false
    return runCatching {
      RandomAccessFile(file, "r").use { raf ->
        if (offset + 2 > raf.length()) return@use false
        raf.seek(offset)
        val b0 = raf.read()
        val b1 = raf.read()
        b0 == 0xFF && (b1 and 0xF6) == 0xF0
      }
    }.getOrDefault(false)
  }

  data class ParseResult(
    val frameCount: Long,
    /** Absolute byte offset through the last COMPLETE frame (the seek anchor). */
    val completeFrameBytes: Long,
    val sampleRate: Int,
    val channels: Int,
    val profile: Int, // AAC object type (profileField + 1); 2 = AAC-LC
    val truncatedFinal: Boolean,
    val malformed: Boolean,
  )

  /**
   * Walk ADTS frames from [baseOffset] to EOF WITHOUT loading the (potentially
   * hundreds-of-MB) file into memory: read only each 7-byte header window, then
   * seek forward by frame_length. This keeps launch recovery bounded — the plan
   * forbids a byte-0 full scan on the hot path, and even the byte-0 fallback
   * must stay incremental/off-thread.
   *
   * Mirrors parseAdts() in src/lib/durableAudio/adts.ts: locks codec format at
   * the first frame, stops (malformed) on drift/corruption before EOF, stops
   * (truncatedFinal) on a trailing partial frame, and NEVER scans forward for a
   * later sync word (v1 rule). The valid prefix is always returned.
   */
  fun parseFromOffset(file: File, baseOffset: Long): ParseResult {
    var pos = baseOffset
    var frameCount = 0L
    var lockedRateIndex = -1
    var lockedChannels = -1
    var lockedProfile = -1
    var truncatedFinal = false
    var malformed = false
    val header = ByteArray(HEADER_SIZE)

    runCatching {
      RandomAccessFile(file, "r").use { raf ->
        val length = raf.length()
        if (baseOffset < 0 || baseOffset > length) {
          malformed = true
          return@use
        }
        while (pos < length) {
          if (pos + HEADER_SIZE > length) {
            truncatedFinal = true
            break
          }
          raf.seek(pos)
          raf.readFully(header, 0, HEADER_SIZE)

          val b0 = header[0].toInt() and 0xFF
          val b1 = header[1].toInt() and 0xFF
          // Same sync test as adts.ts: 0xFFF + layer 00, ignoring version/CRC bits.
          if (b0 != 0xFF || (b1 and 0xF6) != 0xF0) {
            malformed = true
            break
          }

          val b2 = header[2].toInt() and 0xFF
          val b3 = header[3].toInt() and 0xFF
          val b4 = header[4].toInt() and 0xFF
          val b5 = header[5].toInt() and 0xFF

          val profileField = (b2 shr 6) and 0x03
          val rateIndex = (b2 shr 2) and 0x0F
          val channels = ((b2 and 0x01) shl 2) or ((b3 shr 6) and 0x03)
          val frameLength = ((b3 and 0x03) shl 11) or (b4 shl 3) or ((b5 shr 5) and 0x07)

          // Reject structurally impossible frames (matches adts.ts readHeader).
          if (rateIndex >= SAMPLE_RATE_TABLE.size) { malformed = true; break }
          if (channels < 1) { malformed = true; break }
          if (frameLength < HEADER_SIZE) { malformed = true; break }
          if (pos + frameLength > length) { truncatedFinal = true; break }

          if (frameCount == 0L) {
            lockedRateIndex = rateIndex
            lockedChannels = channels
            lockedProfile = profileField
          } else if (
            rateIndex != lockedRateIndex ||
            channels != lockedChannels ||
            profileField != lockedProfile
          ) {
            // Mid-file format drift — recover only the prefix before it.
            malformed = true
            break
          }

          frameCount++
          pos += frameLength
        }
      }
    }.onFailure { malformed = true }

    val sampleRate = if (lockedRateIndex >= 0) sampleRateForIndex(lockedRateIndex) else 0
    val channels = if (lockedChannels >= 0) lockedChannels else 0
    val profile = if (lockedProfile >= 0) lockedProfile + 1 else 0
    return ParseResult(frameCount, pos, sampleRate, channels, profile, truncatedFinal, malformed)
  }
}

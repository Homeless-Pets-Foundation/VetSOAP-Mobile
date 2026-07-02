/**
 * Pure ADTS AAC stream parser for durable-recorder crash recovery.
 *
 * This module has NO React Native / expo dependencies so it stays callable on
 * the JS-side recovery/fallback path even when the native capture module is
 * disabled or fails to load (plan: "ADTS parsing, manifest reads ... must live
 * in JS/shared code"). It operates on a raw byte buffer (the caller reads the
 * on-disk audio.aac prefix via fileOps and hands the bytes here).
 *
 * The parser is the recovery SOURCE OF TRUTH for how far an audio.aac file is
 * a syntactically complete, uploadable ADTS stream — it walks frames from a
 * known-good boundary and returns the byte offset through the last COMPLETE
 * frame. It guarantees a complete ADTS prefix (sync word + frame_length); it
 * does NOT prove each AAC payload decodes (delegated to the decoder/ASR).
 */

// AAC ADTS sampling-frequency index -> Hz.
const SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

// AAC-LC: 1024 PCM samples per raw data block; native encoders emit one block
// per ADTS frame, so duration = frames * 1024 / sampleRate.
const SAMPLES_PER_FRAME = 1024;

export interface AdtsParseResult {
  /** Number of complete ADTS frames recovered from the buffer. */
  frameCount: number;
  /**
   * Absolute byte offset (baseOffset + bytes consumed) through the last
   * complete frame. This is the ONLY safe recovery/seek anchor. 0 when nothing
   * recoverable.
   */
  completeFrameBytes: number;
  /** Sample rate (Hz) locked at the first frame, or 0 if no frame parsed. */
  sampleRate: number;
  /** Channel count locked at the first frame, or 0 if no frame parsed. */
  channels: number;
  /** AAC object type (profile + 1); 2 = AAC-LC. 0 if no frame parsed. */
  profile: number;
  /** Frame-derived duration in ms (1024 samples/frame / sampleRate). */
  durationMs: number;
  /** True if the final bytes were a truncated (incomplete) frame. */
  truncatedFinal: boolean;
  /**
   * True if parsing stopped on a malformed frame / format drift before EOF, or
   * the buffer never started with a valid frame. The valid prefix before the
   * fault is still returned via completeFrameBytes. The parser never scans
   * forward for a later sync word (v1 rule).
   */
  malformed: boolean;
}

export interface AdtsParseOptions {
  /**
   * Absolute byte offset of buffer[0] within the source file. Lets the caller
   * parse only a bounded tail (seek to completeFrameBytes) and still get an
   * absolute completeFrameBytes back. Defaults to 0 (byte-0 parse).
   */
  baseOffset?: number;
}

const ADTS_HEADER_MIN = 7;

interface FrameHeader {
  frameLength: number;
  headerLength: number;
  sampleRateIndex: number;
  channels: number;
  profile: number;
}

/** Parse the fixed ADTS header at `pos`, or null if it is not a valid sync. */
function readHeader(buf: Uint8Array, pos: number): FrameHeader | null {
  if (pos + ADTS_HEADER_MIN > buf.length) return null;
  // Sync word: 0xFFF + layer must be 00. (buf[pos+1] & 0xF6) === 0xF0 checks
  // the low nibble of the syncword (1111) and the 2 layer bits (00) while
  // ignoring the MPEG-version and protection-absent bits.
  if (buf[pos] !== 0xff) return null;
  if ((buf[pos + 1] & 0xf6) !== 0xf0) return null;

  const protectionAbsent = buf[pos + 1] & 0x01;
  const headerLength = protectionAbsent ? 7 : 9;

  const profileMinus1 = (buf[pos + 2] >> 6) & 0x03;
  const sampleRateIndex = (buf[pos + 2] >> 2) & 0x0f;
  const channels = ((buf[pos + 2] & 0x01) << 2) | ((buf[pos + 3] >> 6) & 0x03);
  const frameLength =
    ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | ((buf[pos + 5] >> 5) & 0x07);

  // Reject structurally impossible frames: unknown sample rate, zero channels,
  // or a frame_length that cannot even hold its own header.
  if (sampleRateIndex >= SAMPLE_RATES.length) return null;
  if (channels < 1) return null;
  if (frameLength < headerLength) return null;

  return {
    frameLength,
    headerLength,
    sampleRateIndex,
    channels,
    profile: profileMinus1 + 1,
  };
}

export function framesToDurationMs(frameCount: number, sampleRate: number): number {
  if (frameCount <= 0 || sampleRate <= 0) return 0;
  return Math.round((frameCount * SAMPLES_PER_FRAME * 1000) / sampleRate);
}

/**
 * Walk ADTS frames from the start of `buf`. Locks codec format at the first
 * frame; stops (flagging malformed) at the first frame whose sample
 * rate/channels/profile drift from the locked format, at the first malformed
 * sync before EOF, or (flagging truncatedFinal) at a trailing partial frame.
 */
export function parseAdts(buf: Uint8Array, options: AdtsParseOptions = {}): AdtsParseResult {
  const baseOffset = options.baseOffset ?? 0;
  let pos = 0;
  let frameCount = 0;
  let lockedRateIndex = -1;
  let lockedChannels = -1;
  let lockedProfile = -1;
  let truncatedFinal = false;
  let malformed = false;

  while (pos < buf.length) {
    const header = readHeader(buf, pos);
    if (!header) {
      // Not a valid frame boundary. If we have fewer than a header's worth of
      // bytes left it is a truncated final frame; otherwise it is corruption.
      if (pos + ADTS_HEADER_MIN > buf.length) {
        truncatedFinal = true;
      } else {
        malformed = true;
      }
      break;
    }

    if (pos + header.frameLength > buf.length) {
      // The declared frame extends past EOF: truncated final frame.
      truncatedFinal = true;
      break;
    }

    if (frameCount === 0) {
      lockedRateIndex = header.sampleRateIndex;
      lockedChannels = header.channels;
      lockedProfile = header.profile;
    } else if (
      header.sampleRateIndex !== lockedRateIndex ||
      header.channels !== lockedChannels ||
      header.profile !== lockedProfile
    ) {
      // Mid-file format drift — treat the drift boundary as corruption and
      // recover only the prefix before it. Never scan forward (v1 rule).
      malformed = true;
      break;
    }

    frameCount += 1;
    pos += header.frameLength;
  }

  const sampleRate = lockedRateIndex >= 0 ? SAMPLE_RATES[lockedRateIndex] : 0;
  const channels = lockedChannels >= 0 ? lockedChannels : 0;
  const profile = lockedProfile >= 0 ? lockedProfile : 0;

  return {
    frameCount,
    completeFrameBytes: baseOffset + pos,
    sampleRate,
    channels,
    profile,
    durationMs: framesToDurationMs(frameCount, sampleRate),
    truncatedFinal,
    malformed,
  };
}

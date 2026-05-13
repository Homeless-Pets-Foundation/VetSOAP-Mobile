import { FFmpegKit, FFprobeKit, ReturnCode } from 'ffmpeg-kit-react-native';
import type { FFmpegSession } from 'ffmpeg-kit-react-native';
import {
  getInfoAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { File as ExpoFile, Directory } from 'expo-file-system';
import { audioTempFiles } from './audioTempFiles';
import { getCachedPeaks, cachePeaks } from './waveformCache';

// Maximum input file size for waveform extraction (500MB).
// Prevents OOM from decoding extremely large files to PCM.
const MAX_WAVEFORM_INPUT_BYTES = 500 * 1024 * 1024;

// 16-bit signed integer full-scale value. Peaks are normalized against this so the
// returned amplitudes represent absolute fraction of digital full-scale rather than
// per-segment max — keeps visual heights comparable across segments and recordings.
// (Per-segment normalization made a continuous-volume recording split into N pieces
// render as N different bar heights because tiny variations in each piece's local max
// produced wildly different scale factors.)
const PCM16_FULL_SCALE = 32767;

// Seek-based sampling constants (used when duration >= SHORT_FILE_THRESHOLD_S)
const SHORT_FILE_THRESHOLD_S = 60;   // files shorter than this use full-decode path
const SAMPLE_DURATION_S = 4;         // seconds of audio decoded per sample position
const BATCH_SIZE = 10;               // FFmpeg inputs per command (multi-input concat)
const SAMPLES_PER_POSITION = 5;      // waveform peaks extracted per sample position
const SEEK_SAMPLERATE = 2000;        // Hz for seek-based PCM output
const SHORT_SAMPLERATE = 500;        // Hz for full-decode path (short files)

// Per-call timeout for FFmpeg invocations on the waveform-extraction path.
// On weak CPUs (e.g. Galaxy A7 Lite, MediaTek Helio P22T) seeking 30 positions
// across a multi-hour AAC can stall indefinitely; without a budget the editor
// would show a skeleton forever and the user has no signal to retry/fall back.
// 45s is generous for a 10-input batch on healthy hw, conservative on weak hw.
const WAVEFORM_FFMPEG_TIMEOUT_MS = 45_000;
const SILENCE_CHECK_FFMPEG_TIMEOUT_MS = 15_000;

// After this many consecutive per-position decode failures (timeout OR non-success
// return code), abandon the extraction and throw so the caller's peakErrors path
// surfaces a "could not load waveform" banner. Without this, the pad-with-zeros
// fallback would return a mostly-flat array that renders as a useless baseline
// and takes minutes to arrive on weak hw (10 × 45s per batch worst case). Three
// in a row strongly implies the hardware cannot keep up with the file.
const CONSECUTIVE_DECODE_FAILURE_GIVEUP = 3;

/**
 * Run a single FFmpeg command with a hard timeout. On timeout the session is
 * cancelled (best-effort) and an Error is thrown so the caller's fallback
 * (per-position decode pad-with-zeros, or extractWaveformPeaks's overall
 * try/catch) can run instead of awaiting forever.
 *
 * Uses executeAsync so the session id is available immediately for cancel —
 * FFmpegKit.execute()'s Promise only resolves *after* the session finishes,
 * by which time the timeout window has already passed.
 */
function executeWaveformWithTimeout(
  command: string,
  timeoutMs: number = WAVEFORM_FFMPEG_TIMEOUT_MS
): Promise<FFmpegSession> {
  return new Promise<FFmpegSession>((resolve, reject) => {
    let settled = false;
    let startedSessionId: number | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (startedSessionId !== null) {
        try { FFmpegKit.cancel(startedSessionId); } catch { /* best-effort */ }
      }
      reject(new Error(`FFmpeg waveform timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    FFmpegKit.executeAsync(command, (completedSession) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completedSession);
    })
      .then((startedSession) => {
        startedSessionId = startedSession.getSessionId();
        // If the timer already fired before the start handle resolved, cancel now.
        if (settled) {
          try { FFmpegKit.cancel(startedSessionId); } catch { /* best-effort */ }
        }
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

class FFmpegSilenceCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`FFmpeg silence check timeout after ${timeoutMs}ms`);
    this.name = 'FFmpegSilenceCheckTimeoutError';
  }
}

function executeSilenceCheckWithTimeout(
  command: string,
  timeoutMs: number = SILENCE_CHECK_FFMPEG_TIMEOUT_MS
): Promise<FFmpegSession> {
  return new Promise<FFmpegSession>((resolve, reject) => {
    let settled = false;
    let startedSessionId: number | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (startedSessionId !== null) {
        try { FFmpegKit.cancel(startedSessionId); } catch { /* best-effort */ }
      }
      reject(new FFmpegSilenceCheckTimeoutError(timeoutMs));
    }, timeoutMs);

    FFmpegKit.executeAsync(command, (completedSession) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completedSession);
    })
      .then((startedSession) => {
        startedSessionId = startedSession.getSessionId();
        if (settled) {
          try { FFmpegKit.cancel(startedSessionId); } catch { /* best-effort */ }
        }
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Module-level chain that serializes the FFmpeg portion of waveform extraction.
// Concurrency = 1 globally: at most one peak-extraction FFmpeg pipeline runs at
// a time across the whole app. The audio editor's adjacent-segment prefetch
// fires extractions for prev + next without awaiting (audio-editor.tsx around
// the InteractionManager.runAfterInteractions block), and FFmpegKit on Android
// spawns a worker thread per session — running 2-3 in parallel on a 3 GB device
// (Galaxy A7 Lite) caused real OOM/thrash risk. Cache hits and the upfront file
// existence/size checks happen *before* enqueueing, so cached lookups stay
// instant even if a slow extraction is in flight.
let waveformExtractionChain: Promise<unknown> = Promise.resolve();

function enqueueWaveformExtraction<T>(work: () => Promise<T>): Promise<T> {
  // Swallow upstream rejection so a single failure doesn't poison every
  // subsequent caller. Each caller still observes its own work()'s result
  // because we return the unwrapped promise.
  const next = waveformExtractionChain.then(() => work(), () => work());
  // Persist a swallowed version in the chain so the *next* enqueue sees a
  // resolved sentinel regardless of how `next` settles.
  waveformExtractionChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Validate that a file URI is safe to pass to FFmpeg.
 * Rejects URIs containing characters that could corrupt FFmpegKit's argument parser.
 */
function validateFileUri(uri: string, label: string): void {
  if (!uri || typeof uri !== 'string') {
    throw new Error(`${label}: URI is empty or not a string`);
  }
  // Reject characters that could break FFmpegKit's quote-aware argument parsing
  if (uri.includes('"') || uri.includes("'") || uri.includes('`')) {
    throw new Error(`${label}: URI contains unsafe characters`);
  }
  // Reject path traversal attempts
  if (uri.includes('..')) {
    throw new Error(`${label}: URI contains path traversal`);
  }
  // Must be a local file URI (file:// or content:// or absolute path)
  if (!uri.match(/^(file:\/\/|content:\/\/|\/)/)) {
    throw new Error(`${label}: URI is not a local file path`);
  }
}

/**
 * Validate numeric time parameters for FFmpeg commands.
 */
function validateTimeParam(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label}: must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`${label}: must be non-negative, got ${value}`);
  }
}

/**
 * Trim an M4A audio file using AAC stream copy (near-instant, no re-encoding).
 * The output file is a new M4A containing only the audio between startSeconds and endSeconds.
 */
export async function trimAudio(
  inputUri: string,
  startSeconds: number,
  endSeconds: number,
  outputUri: string
): Promise<{ uri: string; duration: number }> {
  // Validate all parameters
  validateFileUri(inputUri, 'Input');
  validateFileUri(outputUri, 'Output');
  validateTimeParam(startSeconds, 'Start time');
  validateTimeParam(endSeconds, 'End time');

  if (endSeconds <= startSeconds) {
    throw new Error('End time must be greater than start time');
  }

  // Validate input exists
  const inputInfo = await getInfoAsync(inputUri);
  if (!inputInfo.exists) {
    throw new Error('Input audio file does not exist');
  }

  // Use -ss before -i for fast keyframe-based seeking (accurate to ~23ms for AAC)
  // -c:a copy avoids re-encoding — near-instant even for large files
  const command = `-ss ${startSeconds} -to ${endSeconds} -i "${inputUri}" -c:a copy -y "${outputUri}"`;

  const session = await FFmpegKit.execute(command);
  const returnCode = await session.getReturnCode();

  if (!ReturnCode.isSuccess(returnCode)) {
    // Clean up partial output file on failure
    await audioTempFiles.cleanupFile(outputUri);
    const logs = (await session.getLogsAsString()) ?? '';
    throw new Error(`FFmpeg trim failed (code ${returnCode.getValue()}): ${logs.slice(0, 200)}`);
  }

  // Verify output exists and get duration — clean up output on any failure
  const outputInfo = await getInfoAsync(outputUri);
  if (!outputInfo.exists) {
    throw new Error('FFmpeg trim produced no output file');
  }

  try {
    const duration = await getAudioDuration(outputUri);
    return { uri: outputUri, duration };
  } catch (err) {
    await audioTempFiles.cleanupFile(outputUri);
    throw err;
  }
}

/**
 * Concatenate multiple audio segments into a single file using stream copy (no re-encoding).
 * All input files must use the same codec (AAC in M4A, as produced by expo-audio).
 * Returns immediately for single-segment input without invoking FFmpeg.
 */
export async function concatenateAudio(
  inputUris: string[],
  outputUri: string
): Promise<{ uri: string; duration: number }> {
  if (inputUris.length === 0) throw new Error('No input files to concatenate');

  if (inputUris.length === 1) {
    const duration = await getAudioDuration(inputUris[0]);
    return { uri: inputUris[0], duration };
  }

  for (const uri of inputUris) validateFileUri(uri, 'Concat input');
  validateFileUri(outputUri, 'Concat output');

  // Verify all inputs exist
  for (const uri of inputUris) {
    const info = await getInfoAsync(uri);
    if (!info.exists) throw new Error(`Concat input file does not exist: ${uri}`);
  }

  // Write concat demuxer list file — FFmpeg expects paths without file:// prefix
  const listPath = audioTempFiles.getConcatListPath();
  const listContent = inputUris
    .map((uri) => `file '${uri.replace(/^file:\/\//, '')}'`)
    .join('\n');
  await writeAsStringAsync(listPath, listContent);

  try {
    const command = `-f concat -safe 0 -i "${listPath}" -c copy -y "${outputUri}"`;
    const session = await FFmpegKit.execute(command);
    const returnCode = await session.getReturnCode();

    if (!ReturnCode.isSuccess(returnCode)) {
      await audioTempFiles.cleanupFile(outputUri);
      const logs = (await session.getLogsAsString()) ?? '';
      throw new Error(`FFmpeg concat failed (code ${returnCode.getValue()}): ${logs.slice(0, 200)}`);
    }

    const outputInfo = await getInfoAsync(outputUri);
    if (!outputInfo.exists) {
      throw new Error('FFmpeg concat produced no output file');
    }

    // Clean up output on duration query failure — listPath is always cleaned by finally
    try {
      const duration = await getAudioDuration(outputUri);
      return { uri: outputUri, duration };
    } catch (err) {
      await audioTempFiles.cleanupFile(outputUri);
      throw err;
    }
  } finally {
    await audioTempFiles.cleanupFile(listPath);
  }
}

/**
 * Get the precise duration of an audio file using FFprobe.
 */
export async function getAudioDuration(uri: string): Promise<number> {
  validateFileUri(uri, 'Duration query');

  const session = await FFprobeKit.execute(
    `-i "${uri}" -show_entries format=duration -v quiet -of csv=p=0`
  );
  const returnCode = await session.getReturnCode();

  if (!ReturnCode.isSuccess(returnCode)) {
    throw new Error('FFprobe duration query failed');
  }

  const output = await session.getOutput();
  const duration = parseFloat(output.trim());

  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid duration from FFprobe: "${output.trim()}"`);
  }

  return duration;
}

/**
 * Detect whether an audio file is effectively silent by inspecting FFmpeg's
 * `volumedetect` output. Returns false if analysis cannot complete so we fail open.
 */
export async function isAudioEffectivelySilent(
  uri: string,
  thresholds: { maxVolumeDb?: number; meanVolumeDb?: number } = {}
): Promise<boolean> {
  const maxVolumeThresholdDb = thresholds.maxVolumeDb ?? -20;
  const meanVolumeThresholdDb = thresholds.meanVolumeDb ?? -60;
  validateFileUri(uri, 'Silence check');

  const info = await getInfoAsync(uri);
  if (!info.exists) {
    throw new Error('Audio file does not exist for silence check');
  }

  const session = await FFmpegKit.execute(
    `-i "${uri}" -af volumedetect -f null -`
  );
  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    return false;
  }

  const silenceResult = parseVolumedetectSilence((await session.getLogsAsString()) ?? '', {
    maxVolumeDb: maxVolumeThresholdDb,
    meanVolumeDb: meanVolumeThresholdDb,
  });
  return silenceResult ?? false;
}

export type SilenceCheckResult =
  | { status: 'silent' }
  | { status: 'not_silent' }
  | { status: 'inconclusive'; reason: 'ffmpeg_timeout' | 'ffmpeg_error' };

function parseVolumedetectSilence(
  logs: string,
  thresholds: { maxVolumeDb: number; meanVolumeDb: number }
): boolean | null {
  const meanVolumeMatch = logs.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?)?)\s*dB/i);
  const maxVolumeMatch = logs.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?)?)\s*dB/i);
  if (!meanVolumeMatch || !maxVolumeMatch) {
    return null;
  }

  const rawMean = meanVolumeMatch[1]?.toLowerCase();
  const raw = maxVolumeMatch[1]?.toLowerCase();
  if (!rawMean || !raw || rawMean === '-inf' || raw === '-inf' || rawMean === 'inf' || raw === 'inf') {
    return true;
  }

  const meanVolume = Number.parseFloat(rawMean);
  const maxVolume = Number.parseFloat(raw);
  if (!Number.isFinite(meanVolume) || !Number.isFinite(maxVolume)) {
    return null;
  }

  return meanVolume <= thresholds.meanVolumeDb && maxVolume <= thresholds.maxVolumeDb;
}

export async function checkAudioSilenceForUpload(
  uri: string,
  thresholds: { maxVolumeDb?: number; meanVolumeDb?: number; timeoutMs?: number } = {}
): Promise<SilenceCheckResult> {
  const maxVolumeThresholdDb = thresholds.maxVolumeDb ?? -20;
  const meanVolumeThresholdDb = thresholds.meanVolumeDb ?? -60;

  try {
    validateFileUri(uri, 'Upload silence check');

    const info = await getInfoAsync(uri);
    if (!info.exists) {
      return { status: 'inconclusive', reason: 'ffmpeg_error' };
    }

    const session = await executeSilenceCheckWithTimeout(
      `-i "${uri}" -af volumedetect -f null -`,
      thresholds.timeoutMs ?? SILENCE_CHECK_FFMPEG_TIMEOUT_MS
    );
    const returnCode = await session.getReturnCode();
    if (!ReturnCode.isSuccess(returnCode)) {
      return { status: 'inconclusive', reason: 'ffmpeg_error' };
    }

    const isSilent = parseVolumedetectSilence((await session.getLogsAsString()) ?? '', {
      maxVolumeDb: maxVolumeThresholdDb,
      meanVolumeDb: meanVolumeThresholdDb,
    });
    if (isSilent === null) {
      return { status: 'inconclusive', reason: 'ffmpeg_error' };
    }

    return isSilent ? { status: 'silent' } : { status: 'not_silent' };
  } catch (error) {
    return {
      status: 'inconclusive',
      reason: error instanceof FFmpegSilenceCheckTimeoutError ? 'ffmpeg_timeout' : 'ffmpeg_error',
    };
  }
}

/**
 * Read raw 16-bit little-endian PCM from a file and compute `peakCount`
 * max-amplitude windows. Returns normalized values (0.0 - 1.0).
 *
 * Used by both the full-decode path (short files) and the seek-based path
 * (long files). The file handle is always closed in a finally block.
 */
async function readPcmPeaks(
  pcmPath: string,
  totalBytes: number,
  peakCount: number
): Promise<number[]> {
  const bytesPerSample = 2; // 16-bit
  const totalSamples = Math.floor(totalBytes / bytesPerSample);
  const samplesPerPeak = Math.max(1, Math.floor(totalSamples / peakCount));
  const actualPeaks = Math.min(peakCount, totalSamples);

  const CHUNK_SIZE = 256 * 1024; // 256KB chunks — no base64 overhead
  const peaks: number[] = [];
  let currentPeakMax = 0;
  let samplesInCurrentPeak = 0;

  const file = new ExpoFile(pcmPath);
  const handle = file.open();
  let chunkCount = 0;

  try {
    for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
      const readSize = Math.min(CHUNK_SIZE, totalBytes - offset);
      handle.offset = offset;
      const bytes = handle.readBytes(readSize);

      // Process 16-bit samples (little-endian)
      for (let i = 0; i + 1 < bytes.length; i += bytesPerSample) {
        let sample = bytes[i] | (bytes[i + 1] << 8);
        // Convert unsigned to signed 16-bit
        if (sample >= 0x8000) sample -= 0x10000;
        const absSample = Math.abs(sample);

        if (absSample > currentPeakMax) {
          currentPeakMax = absSample;
        }

        samplesInCurrentPeak++;

        if (samplesInCurrentPeak >= samplesPerPeak && peaks.length < actualPeaks) {
          peaks.push(currentPeakMax);
          currentPeakMax = 0;
          samplesInCurrentPeak = 0;
        }
      }

      // Yield to JS thread every 4 chunks to prevent ANR on slow devices
      chunkCount++;
      if (chunkCount % 4 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  } finally {
    handle.close();
  }

  // Push any remaining samples as the last peak
  if (samplesInCurrentPeak > 0 && peaks.length < actualPeaks) {
    peaks.push(currentPeakMax);
  }

  // Normalize to 0.0 - 1.0 against absolute full-scale (not per-segment max),
  // so segments at the same physical loudness render at the same height.
  return peaks.map((p) => p / PCM16_FULL_SCALE);
}

/**
 * Seek-based waveform extraction for long files (>= SHORT_FILE_THRESHOLD_S).
 *
 * Divides the recording into `numberOfPeaks` equal windows. For each window
 * the audio at the window's midpoint is sampled, decoding SAMPLE_DURATION_S
 * seconds. Positions are grouped into batches of BATCH_SIZE per FFmpeg call
 * using multi-input + concat filter to amortise process startup cost.
 *
 * For 150 peaks at 30 positions × 4s at 2kHz: ~240KB of PCM total instead
 * of decoding the full file — a 60x reduction for a 120-minute recording.
 */
async function extractPeaksSampled(
  inputUri: string,
  numberOfPeaks: number,
  duration: number
): Promise<number[]> {
  // Number of evenly-spaced sample positions across the file
  const numPositions = Math.ceil(numberOfPeaks / SAMPLES_PER_POSITION);
  // Peaks per position — may exceed SAMPLES_PER_POSITION for odd numberOfPeaks
  const peaksPerPosition = Math.ceil(numberOfPeaks / numPositions);

  // Compute midpoint seek offsets for each window
  const windowSize = duration / numPositions;
  const positions: number[] = [];
  for (let i = 0; i < numPositions; i++) {
    // Midpoint of each equal-width window, clamped so the 4s decode fits
    const mid = (i + 0.5) * windowSize;
    const seekPos = Math.max(0, Math.min(mid, duration - SAMPLE_DURATION_S));
    positions.push(seekPos);
  }

  const allPeaks: number[] = [];

  // Process positions in batches
  const numBatches = Math.ceil(positions.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
    const batchPositions = positions.slice(
      batchIdx * BATCH_SIZE,
      (batchIdx + 1) * BATCH_SIZE
    );
    const batchPcmPath = audioTempFiles.getBatchPcmTempPath(batchIdx);

    try {
      const batchPeaks = await runBatch(inputUri, batchPositions, batchPcmPath, peaksPerPosition);
      allPeaks.push(...batchPeaks);
    } finally {
      audioTempFiles.cleanupFile(batchPcmPath);
    }
  }

  // Ensure we return exactly numberOfPeaks (trim or pad with 0 as needed)
  while (allPeaks.length < numberOfPeaks) allPeaks.push(0);
  return allPeaks.slice(0, numberOfPeaks);
}

/**
 * Run a single batch: try multi-input concat first, fall back to sequential
 * individual decodes if FFmpeg returns non-success.
 */
async function runBatch(
  inputUri: string,
  batchPositions: number[],
  batchPcmPath: string,
  peaksPerPosition: number
): Promise<number[]> {
  const n = batchPositions.length;

  // Build multi-input concat command
  // e.g.: -ss 0 -t 4 -i "f.m4a" -ss 240 -t 4 -i "f.m4a" ... -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" -ac 1 -ar 2000 -f s16le ...
  const inputArgs = batchPositions
    .map((pos) => `-ss ${pos.toFixed(3)} -t ${SAMPLE_DURATION_S} -i "${inputUri}"`)
    .join(' ');

  const concatInputs = Array.from({ length: n }, (_, i) => `[${i}:a]`).join('');
  const filterComplex = `${concatInputs}concat=n=${n}:v=0:a=1[out]`;

  const batchCommand =
    `${inputArgs} -filter_complex "${filterComplex}" -map "[out]"` +
    ` -ac 1 -ar ${SEEK_SAMPLERATE} -f s16le -acodec pcm_s16le -y "${batchPcmPath}"`;

  // Try the multi-input concat batch first. Non-success return code OR a timeout
  // throw from the wrapper both drop through to the per-position loop below.
  let batchPeaks: number[] | null = null;
  try {
    const batchSession = await executeWaveformWithTimeout(batchCommand);
    const batchReturnCode = await batchSession.getReturnCode();
    if (ReturnCode.isSuccess(batchReturnCode)) {
      batchPeaks = await readBatchPcm(batchPcmPath, n, peaksPerPosition);
    } else if (__DEV__) {
      console.log('[ffmpeg] multi-input concat failed (code', batchReturnCode.getValue(), '), falling back to individual decodes');
    }
  } catch (err) {
    if (__DEV__) {
      console.log('[ffmpeg] batch timed out, falling back to individual decodes:', (err as Error).message);
    }
  }

  if (batchPeaks !== null) return batchPeaks;

  const peaks: number[] = [];
  let consecutiveFailures = 0;
  for (let i = 0; i < batchPositions.length; i++) {
    const pos = batchPositions[i];
    const individualCommand =
      `-ss ${pos.toFixed(3)} -t ${SAMPLE_DURATION_S} -i "${inputUri}"` +
      ` -ac 1 -ar ${SEEK_SAMPLERATE} -f s16le -acodec pcm_s16le -y "${batchPcmPath}"`;

    let individualSucceeded = false;
    try {
      const individualSession = await executeWaveformWithTimeout(individualCommand);
      const individualReturnCode = await individualSession.getReturnCode();
      individualSucceeded = ReturnCode.isSuccess(individualReturnCode);
    } catch (err) {
      if (__DEV__) {
        console.log('[ffmpeg] individual decode timed out at', pos, ':', (err as Error).message);
      }
    }

    if (!individualSucceeded) {
      consecutiveFailures++;
      if (consecutiveFailures >= CONSECUTIVE_DECODE_FAILURE_GIVEUP) {
        // Hardware can't keep up — abandon rather than return a useless flat
        // waveform. The caller catches this and surfaces an error banner, and
        // trim-by-time still works because the overlay is decoupled from peaks.
        throw new Error(
          `FFmpeg waveform extraction aborted after ${consecutiveFailures} consecutive decode failures`
        );
      }
      for (let p = 0; p < peaksPerPosition; p++) peaks.push(0);
      continue;
    }
    consecutiveFailures = 0;

    const indivInfo = await getInfoAsync(batchPcmPath);
    if (!indivInfo.exists || !('size' in indivInfo) || indivInfo.size === 0) {
      for (let p = 0; p < peaksPerPosition; p++) peaks.push(0);
      continue;
    }

    const positionPeaks = await readPcmPeaks(batchPcmPath, indivInfo.size, peaksPerPosition);
    peaks.push(...positionPeaks);

    // Clean up between individual calls so the next one gets a fresh file
    audioTempFiles.cleanupFile(batchPcmPath);
  }

  return peaks;
}

/**
 * Read the concatenated PCM output from a multi-input batch and extract
 * `peaksPerPosition` peaks from each `SAMPLE_DURATION_S`-second window.
 */
async function readBatchPcm(
  batchPcmPath: string,
  numPositions: number,
  peaksPerPosition: number
): Promise<number[]> {
  const pcmInfo = await getInfoAsync(batchPcmPath);
  if (!pcmInfo.exists || !('size' in pcmInfo) || pcmInfo.size === 0) {
    // Return zeros for the entire batch rather than throwing
    return Array(numPositions * peaksPerPosition).fill(0) as number[];
  }

  const totalBytes = pcmInfo.size;
  const bytesPerSample = 2; // 16-bit
  // Bytes for one SAMPLE_DURATION_S window at SEEK_SAMPLERATE
  const bytesPerWindow = SAMPLE_DURATION_S * SEEK_SAMPLERATE * bytesPerSample;

  const allPeaks: number[] = [];

  for (let wi = 0; wi < numPositions; wi++) {
    const windowOffset = wi * bytesPerWindow;
    const windowBytes = Math.min(bytesPerWindow, totalBytes - windowOffset);
    if (windowBytes <= 0) {
      // Window extends past EOF (shouldn't happen, but be defensive)
      for (let p = 0; p < peaksPerPosition; p++) allPeaks.push(0);
      continue;
    }

    // Read just this window's bytes from the file
    const file = new ExpoFile(batchPcmPath);
    const handle = file.open();
    let windowPeaks: number[];
    try {
      handle.offset = windowOffset;
      const bytes = handle.readBytes(windowBytes);

      // Extract peaksPerPosition peaks from this window inline
      const totalSamples = Math.floor(bytes.length / bytesPerSample);
      const samplesPerPeak = Math.max(1, Math.floor(totalSamples / peaksPerPosition));
      const rawPeaks: number[] = [];
      let currentPeakMax = 0;
      let samplesInCurrentPeak = 0;

      for (let i = 0; i + 1 < bytes.length; i += bytesPerSample) {
        let sample = bytes[i] | (bytes[i + 1] << 8);
        if (sample >= 0x8000) sample -= 0x10000;
        const absSample = Math.abs(sample);
        if (absSample > currentPeakMax) currentPeakMax = absSample;
        samplesInCurrentPeak++;

        if (samplesInCurrentPeak >= samplesPerPeak && rawPeaks.length < peaksPerPosition) {
          rawPeaks.push(currentPeakMax);
          currentPeakMax = 0;
          samplesInCurrentPeak = 0;
        }
      }
      if (samplesInCurrentPeak > 0 && rawPeaks.length < peaksPerPosition) {
        rawPeaks.push(currentPeakMax);
      }

      // Absolute-scale normalization (not per-window max) so segments compare correctly
      windowPeaks = rawPeaks.map((p) => p / PCM16_FULL_SCALE);
    } finally {
      handle.close();
    }

    // Pad or trim to exactly peaksPerPosition
    while (windowPeaks.length < peaksPerPosition) windowPeaks.push(0);
    allPeaks.push(...windowPeaks.slice(0, peaksPerPosition));
  }

  return allPeaks;
}

/**
 * Extract waveform peak amplitudes for visualization.
 *
 * For short files (< 60s): decodes the entire file to 500Hz mono PCM, then
 * computes max-amplitude windows in JS. Returns normalized values (0.0 - 1.0).
 *
 * For long files (>= 60s): uses seek-based sampling — jumps to evenly-spaced
 * positions and decodes only SAMPLE_DURATION_S seconds at each, batching 10
 * positions per FFmpeg call. For a 120-minute file this reduces decoded audio
 * from 7,200s to 120s (60x improvement).
 *
 * Results are cached by file URI + size and returned immediately on cache hit.
 */
export async function extractWaveformPeaks(
  inputUri: string,
  numberOfPeaks: number
): Promise<number[]> {
  validateFileUri(inputUri, 'Waveform input');

  if (!Number.isFinite(numberOfPeaks) || numberOfPeaks < 1) {
    throw new Error('numberOfPeaks must be a positive integer');
  }

  // Check input file size to prevent OOM during PCM decoding
  const inputInfo = await getInfoAsync(inputUri);
  if (!inputInfo.exists) {
    throw new Error('Input audio file does not exist');
  }
  if ('size' in inputInfo && inputInfo.size > MAX_WAVEFORM_INPUT_BYTES) {
    throw new Error(
      `Audio file too large for waveform extraction (${Math.round(inputInfo.size / 1024 / 1024)}MB, max ${Math.round(MAX_WAVEFORM_INPUT_BYTES / 1024 / 1024)}MB)`
    );
  }

  const fileSize = 'size' in inputInfo ? inputInfo.size : 0;

  // Check cache before any FFmpeg work
  const cached = await getCachedPeaks(inputUri, fileSize);
  if (cached !== null) return cached;

  const peaks = await enqueueWaveformExtraction(async () => {
    // Get duration to decide which extraction strategy to use
    const duration = await getAudioDuration(inputUri);

    // Both paths write PCM scratch files into EDIT_TEMP_DIR. Editor unmount wipes that
    // directory; without re-creating it here, the next extraction after a fresh editor
    // session fails with "No such file or directory" on the FFmpeg output path.
    await audioTempFiles.ensureDir();

    if (duration >= SHORT_FILE_THRESHOLD_S) {
      // Long file: seek-based sampling (fast — only decodes 4s per position)
      return extractPeaksSampled(inputUri, numberOfPeaks, duration);
    }

    // Short file: full decode at low sample rate (500Hz is sufficient for visuals)
    const pcmPath = audioTempFiles.getPcmTempPath(0);

    try {
      const command =
        `-i "${inputUri}" -ac 1 -ar ${SHORT_SAMPLERATE} -f s16le -acodec pcm_s16le -y "${pcmPath}"`;

      const session = await executeWaveformWithTimeout(command);
      const returnCode = await session.getReturnCode();

      if (!ReturnCode.isSuccess(returnCode)) {
        throw new Error('FFmpeg waveform extraction failed');
      }

      const pcmInfo = await getInfoAsync(pcmPath);
      if (!pcmInfo.exists || !('size' in pcmInfo) || pcmInfo.size === 0) {
        throw new Error('PCM output file is empty or missing');
      }

      return readPcmPeaks(pcmPath, pcmInfo.size, numberOfPeaks);
    } finally {
      audioTempFiles.cleanupFile(pcmPath);
    }
  });

  // Write to cache (fire-and-forget — cachePeaks() has internal try/catch)
  cachePeaks(inputUri, fileSize, peaks);

  return peaks;
}

/**
 * Split an M4A audio file into N parts of approximately equal duration
 * using AAC stream copy (no re-encoding) via the FFmpeg `segment` muxer.
 *
 * Sizing: callers pass `targetBytes` (the desired upper bound per part) and
 * `durationSeconds` (the source file's full duration). The helper computes
 * `parts = ceil(fileSize / targetBytes)` and `T = ceil(durationSeconds / parts)`,
 * then runs:
 *
 *     ffmpeg -i <input> -f segment -segment_time T -c copy
 *            -reset_timestamps 1 -map 0:a <outDir>/part_%03d.m4a
 *
 * The segment muxer emits whole AAC frames at keyframe boundaries, so each
 * part is independently decodable. Per-part actual size can drift a few MB
 * above the time-derived target due to keyframe alignment — callers should
 * reserve a margin (e.g. target 200 MB to stay under a 250 MB cap).
 *
 * Output files are named `part_000.m4a`, `part_001.m4a`, … in `outputDir`.
 * Caller owns the directory's lifecycle (creation + cleanup).
 *
 * Per-part durations are computed from the size-to-duration ratio of the
 * input rather than re-probed via FFprobe, because invoking FFprobe N times
 * on a slow tablet adds seconds we don't need — the server re-derives exact
 * timing from the concatenated file anyway.
 *
 * Hard timeout: 5 minutes. Stream copy is I/O bound, so a 6-hour 700 MB file
 * on a Galaxy A7 Lite typically completes in 30–60 s; 5 min is a generous
 * upper bound that still prevents infinite hangs.
 */
const SPLIT_FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

export async function splitAudioBySize(
  inputUri: string,
  targetBytes: number,
  durationSeconds: number,
  outputDir: string,
): Promise<{ uri: string; duration: number }[]> {
  validateFileUri(inputUri, 'Split input');
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    throw new Error(`splitAudioBySize: targetBytes must be positive, got ${targetBytes}`);
  }
  validateTimeParam(durationSeconds, 'Split duration');
  if (durationSeconds <= 0) {
    throw new Error('splitAudioBySize: durationSeconds must be > 0');
  }
  if (!outputDir.endsWith('/')) {
    throw new Error('splitAudioBySize: outputDir must end with /');
  }

  const inputInfo = await getInfoAsync(inputUri);
  if (!inputInfo.exists) {
    throw new Error('splitAudioBySize: input file does not exist');
  }
  const inputSize = inputInfo.size ?? 0;
  if (inputSize <= 0) {
    throw new Error('splitAudioBySize: input file is empty');
  }

  // Ensure output directory exists (idempotent — Directory.create({intermediates}))
  const outDir = new Directory(outputDir);
  if (!outDir.exists) {
    outDir.create({ intermediates: true });
  }

  // Compute splits. ceil(size/target) parts, ceil(duration/parts) seconds each.
  // We round up segment_time so the final part captures any remainder; FFmpeg's
  // segment muxer naturally emits N or N±1 outputs depending on keyframe layout,
  // and the directory listing reads back whatever it actually produced.
  const parts = Math.ceil(inputSize / targetBytes);
  const segmentTimeSec = Math.ceil(durationSeconds / parts);

  // Pattern uses %03d so directory listing's lexical sort matches numeric order
  const outputPattern = `${outputDir}part_%03d.m4a`;

  const command =
    `-i "${inputUri}" ` +
    `-f segment ` +
    `-segment_time ${segmentTimeSec} ` +
    `-c copy ` +
    `-reset_timestamps 1 ` +
    `-map 0:a ` +
    `-y "${outputPattern}"`;

  // Wrap in a hard timeout. FFmpegKit.execute resolves after the session
  // completes; if it stalls, we cancel all in-flight FFmpeg sessions
  // (best-effort — coarser than the executeAsync session-id pattern used
  // by the waveform extractor, but acceptable here because the only other
  // FFmpeg consumer in the app is short-lived waveform/silence detection
  // that won't be running concurrently with submit-time split).
  const sessionPromise = FFmpegKit.execute(command);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`splitAudioBySize: FFmpeg timed out after ${SPLIT_FFMPEG_TIMEOUT_MS}ms`)),
      SPLIT_FFMPEG_TIMEOUT_MS,
    ),
  );

  let session;
  try {
    session = await Promise.race([sessionPromise, timeoutPromise]);
  } catch (err) {
    try { FFmpegKit.cancel(); } catch { /* best-effort */ }
    throw err;
  }

  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    const logs = (await session.getLogsAsString()) ?? '';
    throw new Error(`FFmpeg split failed (code ${returnCode.getValue()}): ${logs.slice(0, 200)}`);
  }

  // Read back the parts that FFmpeg actually emitted, sorted lexically.
  const dirEntries = outDir.list();
  const partFiles = dirEntries
    .filter((entry): entry is InstanceType<typeof ExpoFile> => entry instanceof ExpoFile)
    .filter((file) => /^part_\d{3}\.m4a$/.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (partFiles.length === 0) {
    throw new Error('FFmpeg split produced no output files');
  }

  // Build segment list. Compute each part's duration from its size ratio
  // against the input. This is approximate but only used for UI / quality
  // telemetry; the server re-derives exact duration from the concatenated file.
  const result: { uri: string; duration: number }[] = [];
  for (const partFile of partFiles) {
    const partInfo = await getInfoAsync(partFile.uri);
    if (!partInfo.exists || (partInfo.size ?? 0) === 0) {
      throw new Error(`FFmpeg split produced empty part: ${partFile.name}`);
    }
    const partSize = partInfo.size ?? 0;
    const partDuration = (partSize / inputSize) * durationSeconds;
    result.push({ uri: partFile.uri, duration: partDuration });
  }

  return result;
}

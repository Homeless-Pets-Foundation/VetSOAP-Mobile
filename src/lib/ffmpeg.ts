// eslint-disable-next-line import/no-unresolved -- native module resolved during EAS build, not in node_modules
import { FFmpegKit, FFprobeKit, ReturnCode } from 'ffmpeg-kit-react-native';
import {
  getInfoAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { File as ExpoFile } from 'expo-file-system';
import { audioTempFiles } from './audioTempFiles';

// Maximum input file size for waveform extraction (500MB).
// Prevents OOM from decoding extremely large files to PCM.
const MAX_WAVEFORM_INPUT_BYTES = 500 * 1024 * 1024;

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

  // Verify output exists and get duration
  const outputInfo = await getInfoAsync(outputUri);
  if (!outputInfo.exists) {
    throw new Error('FFmpeg trim produced no output file');
  }

  const duration = await getAudioDuration(outputUri);
  return { uri: outputUri, duration };
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

    const duration = await getAudioDuration(outputUri);
    return { uri: outputUri, duration };
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
 * Extract waveform peak amplitudes for visualization.
 *
 * Decodes audio to 8kHz mono raw PCM, then reads in chunks and computes
 * the max absolute amplitude per window. Returns normalized values (0.0 - 1.0).
 *
 * For a 90-minute file at 8kHz mono 16-bit: ~86MB of PCM data.
 * We process in 1MB chunks to avoid memory pressure.
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

  await audioTempFiles.ensureDir();
  const pcmPath = audioTempFiles.getPcmTempPath(0);

  try {
    // Decode to 2kHz mono 16-bit little-endian PCM (2kHz is sufficient for
    // visualization peaks and produces 4x less data than 8kHz — critical for
    // low-end tablets like the A7 Lite where JS-thread PCM processing is the
    // bottleneck)
    const command = `-i "${inputUri}" -ac 1 -ar 2000 -f s16le -acodec pcm_s16le -y "${pcmPath}"`;

    const session = await FFmpegKit.execute(command);
    const returnCode = await session.getReturnCode();

    if (!ReturnCode.isSuccess(returnCode)) {
      throw new Error('FFmpeg waveform extraction failed');
    }

    const pcmInfo = await getInfoAsync(pcmPath);
    if (!pcmInfo.exists || !('size' in pcmInfo) || pcmInfo.size === 0) {
      throw new Error('PCM output file is empty or missing');
    }

    const totalBytes = pcmInfo.size;
    const bytesPerSample = 2; // 16-bit
    const totalSamples = Math.floor(totalBytes / bytesPerSample);
    const samplesPerPeak = Math.max(1, Math.floor(totalSamples / numberOfPeaks));
    const actualPeaks = Math.min(numberOfPeaks, totalSamples);

    // Read PCM via native FileHandle — returns Uint8Array directly, avoiding
    // the base64 encode → atob decode → charCodeAt loop that blocks the JS
    // thread for 10-30s on low-end devices
    const CHUNK_SIZE = 256 * 1024; // 256KB (no base64 overhead, smaller is fine)
    const peaks: number[] = [];
    let globalMax = 1; // avoid division by zero

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
            if (currentPeakMax > globalMax) globalMax = currentPeakMax;
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
      if (currentPeakMax > globalMax) globalMax = currentPeakMax;
      peaks.push(currentPeakMax);
    }

    // Normalize to 0.0 - 1.0
    return peaks.map((p) => p / globalMax);
  } finally {
    // Always clean up temp PCM file
    await audioTempFiles.cleanupFile(pcmPath);
  }
}

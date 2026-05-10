import { Paths, Directory } from 'expo-file-system';
import { getInfoAsync } from 'expo-file-system/legacy';
import { splitAudioBySize } from './ffmpeg';
import { safeDeleteDirectory, ensureDirectory } from './fileOps';
import type { AudioSegment } from '../types/multiPatient';

/**
 * Hard cap matching the server's `segmentKeys.max(20)` validation in
 * `apps/api/src/routes/recordings.ts:630`. Recordings that would split into
 * more parts than this are rejected client-side with a clear message rather
 * than failing later at confirm-upload.
 */
export const MAX_SPLIT_PARTS = 20;

/**
 * Per-part target. The server-bound cap is MAX_FILE_SIZE_BYTES = 250 MB
 * (in `recordings.ts`). We aim for 200 MB so that AAC keyframe-alignment
 * variance under stream-copy doesn't push any part above the cap.
 */
export const SPLIT_TARGET_BYTES = 200 * 1024 * 1024;

/**
 * Server-bound preflight cap, mirrored here to avoid a `recordings.ts` ↔
 * `oversizedSplit.ts` import cycle. Kept in sync manually — the constant
 * is hard-coded in two places by design.
 */
export const OVERSIZE_THRESHOLD_BYTES = 250 * 1024 * 1024;

const SPLIT_TEMP_ROOT = `${Paths.document.uri}split-temp/`;

/**
 * Free-disk margin: split temp doubles on-device storage briefly
 * (original is kept until upload succeeds). 1.5x the input gives headroom
 * for the parts plus a small safety buffer.
 */
const DISK_SPACE_MULTIPLIER = 1.5;

type TaggedError = Error & { uploadPhase?: string; errorCode?: string };

function tagPreflightError(err: unknown, errorCode: string): never {
  const e = (err instanceof Error ? err : new Error(String(err ?? 'preflight failed'))) as TaggedError;
  if (!e.uploadPhase) e.uploadPhase = 'preflight';
  if (!e.errorCode) e.errorCode = errorCode;
  throw e;
}

export interface MaybeSplitResult {
  /** The (possibly-split) flat segment list to feed into createWithSegments. */
  segments: AudioSegment[];
  /** True iff at least one input segment was actually split. */
  didSplit: boolean;
  /** Temp URIs to delete after upload completes (or in finally on failure). */
  tempUris: string[];
  /** Temp directory to delete after upload completes; null if no split happened. */
  tempDir: string | null;
}

/**
 * Inspect the input segments for oversize files and split any that exceed
 * the cap. Pass-through if all segments are already within cap.
 *
 * @param segments The slot's `segments[]` to evaluate.
 * @param context Identifying info for temp-dir naming + telemetry.
 * @param onProgress Optional callback called during the split phase.
 */
export async function maybeSplitForUpload(
  segments: AudioSegment[],
  context: { userId: string; slotId: string },
  onProgress?: (phase: 'splitting' | 'done', currentPart?: number, totalParts?: number) => void,
): Promise<MaybeSplitResult> {
  if (segments.length === 0) {
    throw new Error('maybeSplitForUpload: empty segments');
  }

  // Sum input sizes
  let totalInputBytes = 0;
  const segmentSizes: number[] = [];
  for (const seg of segments) {
    const info = await getInfoAsync(seg.uri);
    if (!info.exists) {
      tagPreflightError(new Error('Input segment missing — cannot evaluate for split'), 'INPUT_MISSING');
    }
    const size = info.size ?? 0;
    if (size <= 0) {
      tagPreflightError(new Error('Input segment is empty — cannot evaluate for split'), 'INPUT_EMPTY');
    }
    segmentSizes.push(size);
    totalInputBytes += size;
  }

  // Determine which segments need splitting
  const needsSplit = segmentSizes.some((size) => size > OVERSIZE_THRESHOLD_BYTES);
  if (!needsSplit) {
    return { segments, didSplit: false, tempUris: [], tempDir: null };
  }

  // Disk-space pre-flight. Paths.availableDiskSpace is a synchronous getter
  // (returns a fresh value each access on iOS/Android via the new FS API).
  const required = Math.ceil(totalInputBytes * DISK_SPACE_MULTIPLIER);
  const available = Paths.availableDiskSpace;
  if (available < required) {
    const requiredGB = Math.ceil((required / 1e9) * 10) / 10;
    const availableGB = Math.floor((available / 1e9) * 10) / 10;
    tagPreflightError(
      new Error(
        `Not enough free space to prepare this upload — needs ${requiredGB} GB free, ${availableGB} GB available.`,
      ),
      'DISK_SPACE',
    );
  }

  // Create temp dir scoped to user + slot + timestamp, so concurrent
  // uploads (multi-patient) and stale runs don't collide.
  const tempDir = `${SPLIT_TEMP_ROOT}${context.userId}/${context.slotId}-${Date.now()}/`;
  ensureDirectory(tempDir);

  // Walk segments, splitting where needed; pass-through where not.
  const flat: AudioSegment[] = [];
  const tempUris: string[] = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const size = segmentSizes[i];

      if (size <= OVERSIZE_THRESHOLD_BYTES) {
        flat.push(seg);
        continue;
      }

      onProgress?.('splitting', flat.length, MAX_SPLIT_PARTS);

      // Sub-temp dir per source segment so part_NNN.m4a names don't
      // collide across multiple oversized segments.
      const subDir = `${tempDir}seg_${i}/`;
      ensureDirectory(subDir);

      const parts = await splitAudioBySize(
        seg.uri,
        SPLIT_TARGET_BYTES,
        seg.duration,
        subDir,
      );

      for (const part of parts) {
        flat.push({ uri: part.uri, duration: part.duration });
        tempUris.push(part.uri);
      }
    }
  } catch (err) {
    safeDeleteDirectory(tempDir);
    tagPreflightError(err, 'SPLIT_FAILED');
  }

  // Enforce server's 20-part cap
  if (flat.length > MAX_SPLIT_PARTS) {
    safeDeleteDirectory(tempDir);
    tagPreflightError(
      new Error(
        `Recording is too long to upload in one go (would need ${flat.length} parts, max is ${MAX_SPLIT_PARTS}). Please record shorter sessions.`,
      ),
      'TOO_LONG',
    );
  }

  onProgress?.('done', flat.length, flat.length);
  return { segments: flat, didSplit: true, tempUris, tempDir };
}

/**
 * Sweep stale split-temp directories for the current user. Called from the
 * Record-tab orphan-sweep effect. Deletes the user-scoped subtree on each
 * mount — any in-progress split holds its dir name with a unique timestamp
 * + the orchestrator's `finally`/catch is the live cleanup path, so wiping
 * `${SPLIT_TEMP_ROOT}${userId}/` only removes leftovers from a previous
 * session that was force-quit mid-split.
 */
export function cleanupSplitTempDirs(userId: string): void {
  const userRoot = `${SPLIT_TEMP_ROOT}${userId}/`;
  const dir = new Directory(userRoot);
  if (!dir.exists) return;
  safeDeleteDirectory(userRoot);
}

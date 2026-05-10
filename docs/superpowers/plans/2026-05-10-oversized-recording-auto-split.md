# Oversized Recording Auto-Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-split single audio files (or single segments) over the 250 MB client cap into ≤200 MB parts via FFmpeg-kit segment muxer + stream copy, then upload through the existing `createWithSegments` path which the server already concatenates back into one logical recording before transcription.

**Architecture:** Add a single `splitAudioBySize` helper to `src/lib/ffmpeg.ts`; wrap it in a small new orchestrator `src/lib/oversizedSplit.ts` that handles disk-space pre-flight, per-segment splitting, and temp-file tracking. Wire `uploadSlot` in `app/(app)/(tabs)/record.tsx` to detect oversize → show a confirm dialog → run the orchestrator → route the flattened segment list through `createWithSegments` (always, post-split). Add a new `'preflight'` upload phase tag to separate file-validation errors from the existing `silent_check` (which is repurposed to mean only mic-input silence). No server changes.

**Tech Stack:**
- `ffmpeg-kit-react-native` (already installed) — segment muxer with `-c copy` stream copy
- `expo-file-system` v18 — `Paths.availableDiskSpace`, `File`, `Directory`, plus existing legacy `getInfoAsync` already used in `ffmpeg.ts`
- React Native `Alert` (already used elsewhere in `record.tsx`)
- TypeScript strict mode (`npx tsc --noEmit` is the verification gate — repo has no unit-test framework; verification is type-check + lint + manual device test per CLAUDE.md)

**Reference spec:** `docs/superpowers/specs/2026-05-10-oversized-recording-auto-split-design.md`

---

## File Structure

| File | Operation | Responsibility |
|---|---|---|
| `src/api/recordings.ts` | Modify | Add `'preflight'` to `UploadPhase` union (line 81-87). Move file-missing/empty/too-large throws (lines 387-400, 577-590) from `'silent_check'` → `'preflight'`. **Keep** the per-segment too-large throw inside `createWithSegments` as a defensive backstop — the orchestrator runs first, but the API helper remains correct in isolation. |
| `src/lib/ffmpeg.ts` | Modify | Add exported `splitAudioBySize(inputUri, targetBytes, durationSeconds, outputDir)` helper at the end of the file, alongside `trimAudio` / `concatenateAudio`. |
| `src/lib/oversizedSplit.ts` | Create | NEW. Orchestrator module exporting `maybeSplitForUpload(segments, context)` and `cleanupSplitTempDirs(userId)`. Single purpose, no shared mutable state. |
| `src/constants/strings.ts` | Modify | Add `OVERSIZED_CONFIRM_COPY` constant (title, body builder, button labels) + extend `UPLOAD_OVERLAY_COPY` with `phasePreparing` field. |
| `src/components/UploadOverlay.tsx` | Modify | Render new `"preparing"` phase when `currentSlot.uploadStatus === 'uploading' && currentSlot.uploadProgress` is in a reserved sentinel range (0–4). Reuse existing 5–95 range for upload, 95+ for processing. |
| `app/(app)/(tabs)/record.tsx` | Modify | In `uploadSlot`: between the silence check and `createWithFile/createWithSegments`, call `maybeSplitForUpload` after a confirm dialog. Track temp URIs for cleanup post-success or in `finally`. Add `cleanupSplitTempDirs(userId)` call to the existing Record-tab orphan-sweep effect. |

No new dependencies. No new EAS config.

---

### Task 1: Add `'preflight'` upload phase + retag preflight throws

**Files:**
- Modify: `src/api/recordings.ts:81-87` (UploadPhase union)
- Modify: `src/api/recordings.ts:387-400` (createWithFile preflight)
- Modify: `src/api/recordings.ts:577-590` (createWithSegments preflight)

- [ ] **Step 1: Extend the `UploadPhase` union to include `'preflight'`**

In `src/api/recordings.ts`, find the existing union:

```ts
export type UploadPhase =
  | 'silent_check'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'unknown';
```

Replace with:

```ts
export type UploadPhase =
  | 'preflight'
  | 'silent_check'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'unknown';
```

Phase semantics after this change:
- `preflight` — local file/disk validation before any network call (file exists, file non-empty, file size ≤ cap, free disk for split)
- `silent_check` — peakMetering-based silence detection (the `hasSilentAudioOnly` call inside `uploadSlot`) and the FFmpeg-based `isAudioEffectivelySilent` if/when it gets wired in
- All other phases unchanged

- [ ] **Step 2: Retag the single-file preflight throws**

In `src/api/recordings.ts`, locate the preflight block in `createWithFile` (around line 386–400) and replace the three `phaseError('silent_check', ...)` calls with `phaseError('preflight', ...)`:

```ts
      // Read local file info (fetch() doesn't support file:// URIs on Android)
      const fileInfo = await getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        phaseError('preflight', 'Failed to read the recorded audio file. Please try recording again.');
      }
      const fileSizeBytes = fileInfo.size ?? 0;
      if (!fileSizeBytes) {
        phaseError('preflight', 'The recorded audio file is empty. Please try recording again.');
      }
      // Enforce client-side file size limit
      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        phaseError(
          'preflight',
          `File too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 250MB.`
        );
      }
```

- [ ] **Step 3: Retag the multi-segment preflight throws**

In `src/api/recordings.ts`, locate the per-segment preflight block in `createWithSegments` (around line 577–590) and replace the three `phaseError('silent_check', ...)` calls with `phaseError('preflight', ...)`:

```ts
        // Read local file info
        const fileInfo = await getInfoAsync(segment.uri);
        if (!fileInfo.exists) {
          phaseError('preflight', `Failed to read audio segment ${i + 1}. Please try recording again.`);
        }
        const fileSizeBytes = fileInfo.size ?? 0;
        if (!fileSizeBytes) {
          phaseError('preflight', `Audio segment ${i + 1} is empty. Please try recording again.`);
        }
        if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
          phaseError(
            'preflight',
            `Segment ${i + 1} too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 250MB.`
          );
        }
```

- [ ] **Step 4: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS — no new type errors. Existing callers of `getUploadPhase` already destructure as `string`, and the new union member is a strict superset.

- [ ] **Step 5: Commit**

```bash
git add src/api/recordings.ts
git commit -m "$(cat <<'EOF'
refactor(api): add 'preflight' phase to UploadPhase

Splits file-validation errors (missing/empty/too-large) out of
'silent_check' so Sentry dashboards distinguish 'audio is silent'
from 'audio is too big'. No behavioral change yet — pure tag rename.
Lays the groundwork for the auto-split path to throw under the same
'preflight' bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `splitAudioBySize` to FFmpeg helpers

**Files:**
- Modify: `src/lib/ffmpeg.ts` (append new export at end)

- [ ] **Step 1: Verify the file's existing import surface**

Open `src/lib/ffmpeg.ts` and confirm these imports already exist (they do at the top of the file — do not duplicate):

```ts
import { FFmpegKit, FFprobeKit, ReturnCode } from 'ffmpeg-kit-react-native';
import { getInfoAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { Directory, File as ExpoFile } from 'expo-file-system';
```

The existing import line uses `File as ExpoFile` (already there). Confirm `Directory` is also imported; if not, add it to the same `expo-file-system` line:

```ts
import { File as ExpoFile, Directory } from 'expo-file-system';
```

(Run `grep -n "from 'expo-file-system'" src/lib/ffmpeg.ts` to check current import shape — keep additions on the same line.)

- [ ] **Step 2: Append the `splitAudioBySize` helper to `src/lib/ffmpeg.ts`**

Add at the end of the file, after the existing `isAudioEffectivelySilent` export:

```ts
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
  // completes; if it stalls, we cancel the session and throw.
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
    // Best-effort cancel any in-flight FFmpeg session
    try { FFmpegKit.cancel(); } catch { /* best-effort */ }
    throw err;
  }

  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    const logs = (await session.getLogsAsString()) ?? '';
    throw new Error(`FFmpeg split failed (code ${returnCode.getValue()}): ${logs.slice(0, 200)}`);
  }

  // Read back the parts that FFmpeg actually emitted, sorted lexically.
  // Directory.list() returns File/Directory entries; filter to .m4a files
  // matching our part_NNN pattern.
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
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS. If a type error mentions `Directory.list()` return shape or `ExpoFile` instanceof, double-check Step 1's import line. The expected return type from `Directory.list()` is `(File | Directory)[]`.

- [ ] **Step 4: Lint check**

Run: `npx expo lint`
Expected: no new warnings on `src/lib/ffmpeg.ts`. Pre-existing warnings in other files are fine; only ours need to be clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ffmpeg.ts
git commit -m "$(cat <<'EOF'
feat(ffmpeg): add splitAudioBySize helper

Stream-copy split via FFmpeg segment muxer. Computes part count from
size:target ratio, runs one ffmpeg invocation, reads back emitted
parts from the output directory. Per-part durations approximated from
size ratio (server re-derives exact timing from concatenated file).
5-minute hard timeout.

Used by the upcoming oversize-upload orchestrator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `oversizedSplit` orchestrator

**Files:**
- Create: `src/lib/oversizedSplit.ts`

- [ ] **Step 1: Create `src/lib/oversizedSplit.ts`**

```ts
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
 * Server-bound preflight cap, mirrored here to avoid an `recordings.ts` ↔
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
      throw new Error('Input segment missing — cannot evaluate for split');
    }
    const size = info.size ?? 0;
    if (size <= 0) {
      throw new Error('Input segment is empty — cannot evaluate for split');
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
    const err = new Error(
      `Not enough free space to prepare this upload — needs ${requiredGB} GB free, ${availableGB} GB available.`,
    ) as Error & { uploadPhase: 'preflight'; errorCode: 'DISK_SPACE' };
    err.uploadPhase = 'preflight';
    err.errorCode = 'DISK_SPACE';
    throw err;
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
        // Within cap — keep the original URI as a segment.
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
    // Clean up temp dir on any split failure
    safeDeleteDirectory(tempDir);
    if (err instanceof Error && !(err as Error & { uploadPhase?: string }).uploadPhase) {
      const tagged = err as Error & { uploadPhase: 'preflight'; errorCode: 'SPLIT_FAILED' };
      tagged.uploadPhase = 'preflight';
      tagged.errorCode = 'SPLIT_FAILED';
    }
    throw err;
  }

  // Enforce server's 20-part cap
  if (flat.length > MAX_SPLIT_PARTS) {
    safeDeleteDirectory(tempDir);
    const err = new Error(
      `Recording is too long to upload in one go (would need ${flat.length} parts, max is ${MAX_SPLIT_PARTS}). Please record shorter sessions.`,
    ) as Error & { uploadPhase: 'preflight'; errorCode: 'TOO_LONG' };
    err.uploadPhase = 'preflight';
    err.errorCode = 'TOO_LONG';
    throw err;
  }

  onProgress?.('done', flat.length, flat.length);
  return { segments: flat, didSplit: true, tempUris, tempDir };
}

/**
 * Sweep stale split-temp directories for the current user. Called from the
 * Record-tab orphan-sweep effect. Deletes any user-scoped directory under
 * `${documentDirectory}split-temp/${userId}/` whose contents are older than
 * 24 h (best-effort: we don't probe mtimes — we delete the whole user-scoped
 * tree on each mount, since any in-progress split holds its dir name with a
 * unique timestamp + the orchestrator's `finally` is the live cleanup path).
 *
 * Concretely: a stale temp dir from a previous app session (force-quit
 * mid-split) gets removed on next Record-tab mount. The live in-flight split
 * is guarded by the orchestrator's own try/finally.
 */
export function cleanupSplitTempDirs(userId: string): void {
  const userRoot = `${SPLIT_TEMP_ROOT}${userId}/`;
  const dir = new Directory(userRoot);
  if (!dir.exists) return;

  // List children. Each child is a per-slot timestamped directory. We can't
  // tell which (if any) is in-flight from a previous session vs the current
  // one — but the orchestrator only creates a new dir per call, and the
  // record.tsx mount-time sweep runs before any new split, so it's safe to
  // delete everything under the user root.
  safeDeleteDirectory(userRoot);
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS. If `Paths.availableDiskSpace` is flagged unknown, confirm the installed `expo-file-system` version exposes it (Step 0 / docs check has confirmed v18+ does — see `node_modules/expo-file-system/build/FileSystem.d.ts`). If a typing mismatch surfaces on `errorCode`, ensure the local error-tagging shape uses optional fields (`{ uploadPhase?: 'preflight'; errorCode?: string }`) rather than required intersections — soften to optional if needed.

- [ ] **Step 3: Lint check**

Run: `npx expo lint`
Expected: no new warnings on `src/lib/oversizedSplit.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/oversizedSplit.ts
git commit -m "$(cat <<'EOF'
feat(upload): add oversizedSplit orchestrator

Pre-upload helper that detects segments above the 250 MB client cap,
runs splitAudioBySize per oversized segment, returns a flat segment
list ready for createWithSegments. Disk-space check (1.5x input bytes
required), 20-part hard cap mirroring server schema, user-scoped
temp dirs under documentDirectory/split-temp/{userId}/, and a
mount-time orphan sweep helper.

All thrown errors carry uploadPhase='preflight' so existing Sentry
phase routing in record.tsx picks them up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add user-facing strings

**Files:**
- Modify: `src/constants/strings.ts`

- [ ] **Step 1: Extend `UPLOAD_OVERLAY_COPY` and add `OVERSIZED_CONFIRM_COPY`**

In `src/constants/strings.ts`, replace the existing `UPLOAD_OVERLAY_COPY` block:

```ts
export const UPLOAD_OVERLAY_COPY = {
  title: 'Uploading Recording',
  titleMulti: 'Uploading Recordings',
  reassurance: 'Please wait while your recording uploads.',
} as const;
```

with:

```ts
export const UPLOAD_OVERLAY_COPY = {
  title: 'Uploading Recording',
  titleMulti: 'Uploading Recordings',
  reassurance: 'Please wait while your recording uploads.',
  /** Phase label shown while FFmpeg is splitting an oversized recording before any bytes are uploaded. */
  phasePreparing: 'Preparing audio…',
} as const;
```

Then add a new `OVERSIZED_CONFIRM_COPY` constant immediately after it:

```ts
export const OVERSIZED_CONFIRM_COPY = {
  title: 'Recording is large',
  /** Body builder. `hours` rounded to 1 decimal, `mb` rounded to whole MB, `parts` is the predicted part count. */
  body: (hours: number, mb: number, parts: number): string =>
    `Your ${hours.toFixed(1)}-hour recording (${mb} MB) will be uploaded in ${parts} parts. ` +
    `This may take a few minutes. Continue?`,
  cancel: 'Cancel',
  upload: 'Upload',
} as const;
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/constants/strings.ts
git commit -m "$(cat <<'EOF'
feat(strings): add oversized-recording confirm + overlay copy

Adds OVERSIZED_CONFIRM_COPY (title/body/cancel/upload) and a new
phasePreparing label on UPLOAD_OVERLAY_COPY for the splitting phase.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Render the "Preparing audio…" phase in `UploadOverlay`

**Files:**
- Modify: `src/components/UploadOverlay.tsx:55-62`

- [ ] **Step 1: Update phase-label logic**

In `src/components/UploadOverlay.tsx`, find the existing `phaseText` calculation:

```tsx
  // Use overallProgress for phase text in multi-patient mode so label matches percentage
  const progressForPhase = isMulti && totalSlotsToUpload > 1 ? overallProgress : currentProgress;
  const phaseText =
    progressForPhase < 10
      ? 'Preparing...'
      : progressForPhase >= 95
        ? 'Processing...'
        : 'Uploading...';
```

Replace with:

```tsx
  // Use overallProgress for phase text in multi-patient mode so label matches percentage
  const progressForPhase = isMulti && totalSlotsToUpload > 1 ? overallProgress : currentProgress;
  // Sentinel: when uploadSlot is in the FFmpeg split phase, it sets progress=2
  // (between the initial 0 and the upload-start 5). Display the dedicated
  // "Preparing audio…" label so users on slow tablets see meaningful text
  // instead of a frozen "Preparing..." for up to a minute.
  const phaseText =
    progressForPhase >= 1 && progressForPhase < 5
      ? UPLOAD_OVERLAY_COPY.phasePreparing
      : progressForPhase < 10
        ? 'Preparing...'
        : progressForPhase >= 95
          ? 'Processing...'
          : 'Uploading...';
```

The `1 ≤ progress < 5` window is reserved for the splitting phase. The existing `5` start (in `record.tsx` `setUploadStatus(slot.id, 'uploading', { progress: 5 })`) marks "upload bytes start moving"; `0` is "no progress reported yet"; `1` is the new sentinel for "split started"; intermediate values 2–4 will be reported by the orchestrator's progress callback.

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/UploadOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(upload-overlay): render 'Preparing audio…' phase during split

Uses progress sentinel range [1, 5) — set by uploadSlot when the
FFmpeg auto-split runs before bytes start moving — to show a
dedicated label instead of a frozen 'Preparing...' for up to a
minute on slow tablets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire orchestrator into `uploadSlot` with confirm dialog

**Files:**
- Modify: `app/(app)/(tabs)/record.tsx` (uploadSlot — around line 1021–1230, plus the existing orphan-sweep effect)

- [ ] **Step 1: Add imports**

Near the top of `app/(app)/(tabs)/record.tsx`, locate the existing imports of `recordingsApi`, `breadcrumb`, `safeDeleteFile`, etc., and add:

```tsx
import { maybeSplitForUpload, cleanupSplitTempDirs } from '../../../src/lib/oversizedSplit';
import { OVERSIZED_CONFIRM_COPY } from '../../../src/constants/strings';
import { safeDeleteDirectory } from '../../../src/lib/fileOps';
```

(Match the path style already used by neighboring imports — relative paths into `src/`.)

- [ ] **Step 2: Add a confirm-dialog helper near other top-level helpers in this file**

Outside the component, add:

```tsx
/** Sentinel error thrown when the user taps Cancel on the oversize confirm dialog. */
class UploadCancelledByUser extends Error {
  constructor() { super('Upload cancelled by user'); this.name = 'UploadCancelledByUser'; }
}

/** Promise-wrapped Alert.alert with a yes/no choice. Resolves true on confirm, false on cancel. */
function confirmOversizedUpload(hours: number, mb: number, parts: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      OVERSIZED_CONFIRM_COPY.title,
      OVERSIZED_CONFIRM_COPY.body(hours, mb, parts),
      [
        { text: OVERSIZED_CONFIRM_COPY.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: OVERSIZED_CONFIRM_COPY.upload, style: 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
```

- [ ] **Step 3: Insert orchestrator call into `uploadSlot` between silence check and upload**

Locate the body of `uploadSlot` (starts ~line 1021). Right after the existing block:

```tsx
      try {
        if (hasSilentAudioOnly(slot)) {
          const silentError = new Error(
            'This recording appears silent. Please verify microphone input and record again before uploading.'
          ) as Error & { uploadPhase?: 'silent_check' };
          silentError.uploadPhase = 'silent_check';
          throw silentError;
        }

        setUploadStatus(slot.id, 'uploading', { progress: 5 });
```

Replace the `setUploadStatus(slot.id, 'uploading', { progress: 5 });` line and everything that follows up to and including the `if (slot.segments.length === 1) { … } else { … }` block with the new flow below. Keep the `onUploadProgress` and `onR2Complete` definitions where they are (they stay inside the try); only the segments→upload routing changes.

The new structure (replace from `setUploadStatus(slot.id, 'uploading', { progress: 5 });` through the close of the `if (slot.segments.length === 1) { … } else { … }` block):

```tsx
        // Pre-flight: detect oversized segments and split them via FFmpeg.
        // This block is wrapped in try so any error tags as 'preflight'.
        let segmentsForUpload = slot.segments;
        let splitTempDir: string | null = null;
        let splitTempUris: string[] = [];
        try {
          // Quick sniff: any segment over the cap?
          let totalBytes = 0;
          let anyOversized = false;
          for (const seg of slot.segments) {
            const info = await getInfoAsync(seg.uri);
            const size = info.size ?? 0;
            totalBytes += size;
            if (size > 250 * 1024 * 1024) anyOversized = true;
          }

          if (anyOversized) {
            const totalDurationSec = slot.segments.reduce((sum, s) => sum + (s.duration ?? 0), 0);
            const hours = totalDurationSec / 3600;
            const mb = Math.round(totalBytes / 1024 / 1024);
            const predictedParts = Math.ceil(totalBytes / (200 * 1024 * 1024));

            const userConfirmed = await confirmOversizedUpload(hours, mb, predictedParts);
            if (!userConfirmed) {
              throw new UploadCancelledByUser();
            }

            // Mark the new "Preparing audio…" phase via the [1, 5) sentinel.
            setUploadStatus(slot.id, 'uploading', { progress: 1 });

            const splitResult = await maybeSplitForUpload(
              slot.segments,
              { userId: user?.id ?? 'unknown', slotId: slot.id },
              (phase, current, total) => {
                if (phase === 'splitting' && total && total > 0) {
                  // Map split progress into [1, 4] reserved range (we leave 5 for "upload start")
                  const pct = Math.min(4, 1 + Math.floor(((current ?? 0) / total) * 3));
                  setUploadStatus(slot.id, 'uploading', { progress: pct });
                }
              },
            );

            segmentsForUpload = splitResult.segments;
            splitTempDir = splitResult.tempDir;
            splitTempUris = splitResult.tempUris;

            breadcrumb('upload', 'oversized_split', {
              slot_index: slotIndex,
              input_size_bytes: totalBytes,
              parts: splitResult.segments.length,
              did_split: splitResult.didSplit,
            });
          }
        } catch (err) {
          // Clean up any partially-created temp before rethrowing
          if (splitTempDir) safeDeleteDirectory(splitTempDir);
          if (err instanceof UploadCancelledByUser) throw err;
          if (err instanceof Error && !(err as Error & { uploadPhase?: string }).uploadPhase) {
            (err as Error & { uploadPhase: 'preflight' }).uploadPhase = 'preflight';
          }
          throw err;
        }

        setUploadStatus(slot.id, 'uploading', { progress: 5 });
        // Throttle progress updates to avoid dispatching state on every native chunk
        let lastProgressUpdate = 0;
        const onUploadProgress = ({ percent }: { percent: number }) => {
          const now = Date.now();
          if (now - lastProgressUpdate >= 500) {
            lastProgressUpdate = now;
            setUploadStatus(slot.id, 'uploading', {
              progress: Math.round(5 + (percent * 85) / 100),
            });
          }
        };

        // Persist the resume hint as soon as R2 is done but before confirm. (unchanged below)
        const onR2Complete = (hint: {
          recordingId: string;
          fileKey: string;
          segmentKeys?: string[];
          segmentCount?: number;
        }) => {
          setUploadStatus(slot.id, 'uploading', {
            progress: 95,
            pendingConfirm: {
              recordingId: hint.recordingId,
              fileKey: hint.fileKey,
              segmentKeys: hint.segmentKeys,
              segmentCount: hint.segmentCount,
            },
          });
        };

        // Existing draft promotion logic (lines 1116-1140) stays exactly as-is.
        // Re-paste unchanged in this position. It must remain before the
        // create*With* call so existingRecordingId is honored.

        // ... draft-promotion block (unchanged from existing code) ...

        // Route: stay on createWithFile only if no split happened AND original was 1 segment.
        // Anything else (split, or originally multi-segment) goes through createWithSegments.
        let result;
        if (segmentsForUpload.length === 1) {
          result = await recordingsApi.createWithFile(
            slot.formData,
            segmentsForUpload[0].uri,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              audioDurationSeconds: durationSeconds,
              slotIndex,
            }
          );
        } else {
          result = await recordingsApi.createWithSegments(
            slot.formData,
            segmentsForUpload,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              slotIndex,
            }
          );
        }

        completedUploadSlotIdsRef.current.add(slot.id);
        setUploadStatus(slot.id, 'success', {
          progress: 100,
          serverRecordingId: result.id,
        });
        recordSubmitAttempt(result.id);

        // Clean up local audio files now that they're safely on R2.
        // For the split path: also delete the per-slot temp directory.
        slot.segments.forEach((seg) => { safeDeleteFile(seg.uri); });
        for (const tempUri of splitTempUris) safeDeleteFile(tempUri);
        if (splitTempDir) safeDeleteDirectory(splitTempDir);

        // Clean up local draft after successful upload
        draftStorage.deleteDraft(slot.id).catch(() => {});
```

> **IMPORTANT:** the existing draft-promotion block (`useExistingDraft`, `patchDraftMetadataWithRetry`, etc., currently around lines 1116–1140) must remain in place between the `onR2Complete` definition and the `createWith*` calls. The replacement above marks its position with a `// ... draft-promotion block (unchanged from existing code) ...` comment — when implementing, copy the existing code into that gap verbatim. Do not delete it.

> The trailing analytics/breadcrumb block (`trackEvent` for `submit_succeeded`, `breadcrumb`, etc., currently around lines 1192-onward) is unchanged and must remain unchanged after the cleanup statements.

- [ ] **Step 4: Handle `UploadCancelledByUser` in `uploadSlot`'s catch**

Locate the `catch (error) { ... }` block at the end of `uploadSlot`'s try (it's the block that handles `submit_failed` analytics + Sentry capture). At the very top of that catch, add a sentinel-bypass:

```tsx
      } catch (error) {
        // User explicitly cancelled the oversize confirm dialog: do not log,
        // do not capture, leave the slot in 'pending'. They can retry later.
        if (error instanceof UploadCancelledByUser) {
          setUploadStatus(slot.id, 'pending');
          return null;
        }
        // ... existing error handling continues unchanged ...
```

Keep all existing error-handling code below this guard.

- [ ] **Step 5: Add `cleanupSplitTempDirs` to the existing Record-tab orphan-sweep effect**

Locate the existing effect that runs on Record-tab mount and calls `draftStorage.cleanupOrphaned(...)`. Search the file:

```bash
grep -n "cleanupOrphaned\|orphan" "app/(app)/(tabs)/record.tsx"
```

In the same effect (or alongside it if separate), add:

```tsx
  // Sweep stale split-temp directories from a previous session that may
  // have been force-quit mid-split.
  if (user?.id) {
    cleanupSplitTempDirs(user.id);
  }
```

Place this call only inside an effect gated on `user?.id` so we don't sweep before the user is known.

- [ ] **Step 6: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS. The most likely failure is an unused-import warning on `safeDeleteDirectory` if you accidentally only used it inside a conditional branch — confirm both the inline `if (splitTempDir) safeDeleteDirectory(splitTempDir)` (in the catch around the split) and the post-success `if (splitTempDir) safeDeleteDirectory(splitTempDir)` are present.

- [ ] **Step 7: Lint check**

Run: `npx expo lint`
Expected: no new warnings on `record.tsx`. The file is large; pre-existing warnings are out of scope.

- [ ] **Step 8: Commit**

```bash
git add "app/(app)/(tabs)/record.tsx"
git commit -m "$(cat <<'EOF'
feat(upload): auto-split oversized recordings before upload

When uploadSlot detects any segment > 250 MB, prompt the user with a
confirm dialog showing duration / size / predicted part count, then
run maybeSplitForUpload (FFmpeg segment muxer + stream copy) and
route the flattened segment list through createWithSegments. Server
already concatenates segments back before transcription, so SOAP is
unchanged.

User-cancel of the dialog is silent (no Sentry, no submit_failed,
slot returns to pending). Split errors carry uploadPhase='preflight'.

Adds a mount-time orphan sweep for stale split-temp directories so a
force-quit mid-split doesn't leak storage.

Fixes Sentry REACT-NATIVE-7 (250 MB cap blocked 6h+ recordings;
1 user stuck across 5 days of retries).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Whole-repo TypeScript**

Run: `npx tsc --noEmit`
Expected: PASS — zero errors.

- [ ] **Step 2: Whole-repo lint**

Run: `npx expo lint`
Expected: any new warnings introduced by this change should be addressed; pre-existing warnings outside our touched files are out of scope.

- [ ] **Step 3: Expo doctor (per CLAUDE.md pre-build hook)**

Run: `npx expo-doctor`
Expected: PASS — no version mismatches.

- [ ] **Step 4: Manual physical-device verification (per CLAUDE.md "Verify before claiming done")**

Repo has no automated test framework, so the upload path is verified manually on a physical Android device (per CLAUDE.md: emulator silence-check blocks all real uploads).

Test plan on Pixel 10 Pro XL or Galaxy Tab A7 Lite:
1. Start a recording, let it run ~30 minutes.
2. Stop. The single segment will be < 250 MB at this length, so the new code-path will not trigger naturally — for testing purposes, temporarily lower `OVERSIZE_THRESHOLD_BYTES` in `src/lib/oversizedSplit.ts` to e.g. `5 * 1024 * 1024` (5 MB) **in a local-only commit you do NOT push**, install via `expo run:android`, then submit.
3. Confirm: confirm dialog appears with sane numbers (duration in hours, MB, part count).
4. Tap Upload. Observe UploadOverlay shows "Preparing audio…" briefly, then transitions to "Uploading…" with the progress bar advancing.
5. Wait for upload to complete and the recording to land in the Records list.
6. Open the recording — confirm the transcript and SOAP are generated from the **whole** recording (server-side concat worked).
7. Run `git diff src/lib/oversizedSplit.ts` and confirm you remember to revert the threshold change before pushing. Run `git checkout src/lib/oversizedSplit.ts` if needed.

- [ ] **Step 5: Sentry phase-tag verification (optional but recommended)**

If `EXPO_PUBLIC_SENTRY_ENABLE_IN_DEV=true` is set in `.env`:
1. With the dev-only threshold lowered (Step 4), force a split failure by also temporarily breaking the FFmpeg command (e.g. set `targetBytes` to negative in `splitAudioBySize` invocation) — pure local diagnostic, do not push.
2. Trigger a submit. Sentry should capture an event tagged `phase=preflight`, `error_code=SPLIT_FAILED`.
3. Revert local diagnostic edits with `git checkout src/lib/`.

- [ ] **Step 6: Push the branch (only after manual verification passed)**

`git push -u origin <branch-name>` — explicitly confirm with the user before this step (per CLAUDE.md "Confirm before shared-state actions").

---

## Self-Review

Looking back at the spec coverage:

- **UX (pre-confirm dialog)**: Task 6 Step 2 + Step 3 → `confirmOversizedUpload` + `OVERSIZED_CONFIRM_COPY` (Task 4). ✅
- **"Preparing audio…" overlay phase**: Task 5 + Task 4 (`phasePreparing`). ✅
- **Silent fall-through to existing UploadOverlay phases**: Task 5 (sentinel range `[1, 5)`). ✅
- **Both single + multi-segment paths covered**: Task 6 Step 3 — segment loop in `maybeSplitForUpload` walks every segment, splits each oversized one independently. ✅
- **FFmpeg segment muxer + stream copy**: Task 2 — `-f segment -segment_time T -c copy`. ✅
- **`splitAudioBySize` returns `{ uri, duration }[]` matching `AudioSegment` shape**: Task 2. ✅
- **`maybeSplitForUpload` orchestrator with disk-space pre-flight, 20-part cap, temp-dir scoping by user+slot+timestamp**: Task 3. ✅
- **`MAX_FILE_SIZE_BYTES = 250 MB` unchanged; `SPLIT_TARGET_BYTES = 200 MB`; `MAX_SPLIT_PARTS = 20`**: Task 3. ✅
- **`'preflight'` phase added to `UploadPhase`, throws retagged**: Task 1. ✅
- **`silent_check` retains the `hasSilentAudioOnly` throw in `record.tsx`**: confirmed in Task 6 Step 3 — that block is preserved before the new split block. ✅
- **Cleanup of split temp on success**: Task 6 Step 3 (`safeDeleteDirectory(splitTempDir)` after success). ✅
- **Cleanup on failure**: Task 6 Step 3 (catch around split block) + Task 7 (orphan sweep). ✅
- **User-cancel returns slot to pending without Sentry capture**: Task 6 Step 4. ✅
- **Stuck-user recovery (REACT-NATIVE-7)**: no special code per spec — the new path activates on any retry from a build with this code. Stash payload already carries `serverDraftId` per CLAUDE.md rule 24, so promotion in place is automatic. Confirmed in Task 6 Step 3 (the `existingRecordingId: serverDraftId` spread is preserved through both branches). ✅
- **Server changes**: none. Task 0 (no task) — confirmed by inspecting `apps/api/src/routes/recordings.ts:630` (`segmentKeys.max(20)`) and `apps/jobs/src/jobs/process-recording.ts:361` (segment concat). ✅

**Placeholder scan**: searched for "TBD", "TODO", "implement later", "similar to". One in-line "// ... draft-promotion block (unchanged from existing code) ..." marker exists in Task 6 Step 3 — but this is **not** a placeholder for the engineer; the surrounding text **explicitly directs them to copy the existing code into that gap verbatim and not delete it**. A real placeholder asks the engineer to invent code; this asks them to preserve existing code. Acceptable.

**Type consistency**: `splitAudioBySize` returns `{ uri: string; duration: number }[]`. `MaybeSplitResult.segments` is typed `AudioSegment[]`. `AudioSegment` (per `src/types/multiPatient.ts`) is `{ uri: string; duration: number }` exactly. ✅. `maybeSplitForUpload` and `cleanupSplitTempDirs` names appear identically in Task 3 (definition) and Task 6 (consumption). ✅. `OVERSIZED_CONFIRM_COPY` field names (`title`, `body`, `cancel`, `upload`) used in Task 4 (definition) and Task 6 Step 2 (consumption) match. ✅. `phasePreparing` defined in Task 4, consumed in Task 5. ✅.

**Scope check**: All tasks operate on a tightly bounded set of files (one new module, four edits). No multi-subsystem decomposition needed. ✅

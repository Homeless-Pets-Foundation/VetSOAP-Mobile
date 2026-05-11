# Oversized Recording Auto-Split — Design

**Date:** 2026-05-10
**Status:** Approved
**Author:** Claude (brainstormed with Phil)
**Origin:** Sentry issue `REACT-NATIVE-7` — "File too large (709MB). Maximum allowed size is 250MB." 7 events, 1 user, last seen 2026-05-07. User retried 7× across 5 days; recording stuck in stash.

## Goal

Unblock recordings whose single-file size exceeds the client-side `MAX_FILE_SIZE_BYTES = 250 MB` cap by auto-splitting them on the device into chunks the server can already concatenate back into one logical file. Single fix covers both `createWithFile` and `createWithSegments` upload paths.

## Non-goals

- Server-side cap raise. The server already accepts up to 20 segments of arbitrary size in production via `apps/jobs/src/jobs/process-recording.ts:361-459` (downloads all segments, runs `ffmpeg -f concat -c copy`, replaces R2 keys with the concatenated output, then transcribes that single file).
- Raw-audio export-to-Files share flow. Could ship separately as a defense-in-depth recovery path.
- Pre-recording duration warning ("you've been recording for 4h, consider stopping").
- Re-encoding to shrink files. Stream-copy only.

## Background

`src/api/recordings.ts:395-399` and `:585-589` throw `phaseError('silent_check', ...)` when a single audio file (or single segment) exceeds 250 MB. Both throws are intentionally tagged under the `silent_check` phase as a preflight bucket, but the message and the phase are misleading in Sentry dashboards: a user with a 6.4-hour recording (709 MB) was filed under "silent audio" telemetry. Phase tagging is fixed as part of this work.

Server contract is already segment-aware: `POST /api/recordings/:id/confirm` accepts `segmentKeys: z.array(safeFileKeySchema).max(20).optional()` (`apps/api/src/routes/recordings.ts:630`). The Trigger.dev job `process-recording` then runs `ffmpeg -f concat -c copy` to reassemble before transcription. SOAP is generated from one transcript, never per-segment.

## UX

When the upload path detects an oversized file or segment, the user sees:

```
┌──────────────────────────────────────────────┐
│ Recording is large                           │
│                                              │
│ Your 6.4-hour recording (709 MB) will be     │
│ uploaded in 4 parts. This may take a few     │
│ minutes. Continue?                           │
│                                              │
│       [Cancel]              [Upload]         │
└──────────────────────────────────────────────┘
```

On `Upload`:
1. UploadOverlay shows a new phase **"Preparing audio…"** during FFmpeg split.
2. Then transitions to existing **"Uploading…"** phase as parts upload.
3. Then **"Finishing…"** as the server confirms.

On `Cancel`: slot returns to `pending` state, no Sentry capture, no `submit_failed` analytics event. User can retry later or stash.

The confirm dialog is the only new user-visible surface. Splitting is otherwise transparent.

## Architecture

### Module layout

| Module | Responsibility |
|---|---|
| `src/lib/ffmpeg.ts` (existing) | Add `splitAudioBySize(uri, targetBytes, durationSeconds)` next to existing `trimAudio` / `concatSegments` helpers. |
| `src/lib/oversizedSplit.ts` (new) | Orchestrator: pre-flight disk check, split per-segment if needed, return flat `AudioSegment[]`, manage temp directory. Single purpose, single export. |
| `src/api/recordings.ts` (existing) | Add `'preflight'` to `UploadPhase`; move size/empty/missing checks from `silent_check` to `preflight`; remove now-redundant per-segment size throws (split orchestrator handles it before this code runs). |
| `app/(app)/record.tsx` `uploadSlot()` (existing) | Call `maybeSplitForUpload()` before upload. Show confirm dialog when at least one segment exceeds the cap. Route to `createWithSegments` when `didSplit === true OR finalSegments.length > 1`; route to `createWithFile` only when `didSplit === false AND finalSegments.length === 1`. Wire upload-overlay phase strings. |
| `src/constants/strings.ts` (existing) | New copy: confirm-dialog title/body/buttons, "Preparing audio…" overlay phase label. |
| `src/components/UploadOverlay.tsx` (existing) | Render new `"preparing"` phase before `"uploading"`. |

No server changes. No dependency additions.

### Constants (in `src/api/recordings.ts`)

```ts
const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024; // unchanged — server-bound cap
const SPLIT_TARGET_BYTES = 200 * 1024 * 1024;  // 50 MB margin for stream-copy keyframe variance
const MAX_SPLIT_PARTS = 20;                     // matches server's segmentKeys.max(20)
```

The 50 MB margin accounts for AAC keyframe alignment under `-c copy` with `-segment_time` — actual part sizes can drift a few MB above the time-derived target. 200 MB target × 20 max parts = 4 GB / ~36 hours of audio at typical mobile bitrate.

### `splitAudioBySize` contract

```ts
async function splitAudioBySize(
  inputUri: string,
  targetBytes: number,
  durationSeconds: number,
): Promise<{ uri: string; duration: number }[]>
```

Behavior:
1. Compute `parts = Math.ceil(fileSize / targetBytes)`.
2. Compute `segmentTimeSec = Math.ceil(durationSeconds / parts)`.
3. Create a temp directory: `${documentDirectory}split-temp/${userId}/${slotId}-${timestamp}/`.
4. Run a single FFmpeg invocation:
   ```
   ffmpeg -i <inputUri> \
          -f segment \
          -segment_time <T> \
          -c copy \
          -reset_timestamps 1 \
          -map 0:a \
          <outDir>/part_%03d.m4a
   ```
5. Read back `part_NNN.m4a` files in lexical order. Validate each via `getInfoAsync` (exists, size > 0).
6. Compute each part's duration from `(fileSize / totalSize) × durationSeconds` (we trust the size:duration ratio rather than re-probing each part — re-probing N files via FFprobe would add seconds on slow tablets).
7. Return `[{ uri, duration }, ...]`.

Hard timeout: 5 min (longer than the existing waveform-extraction timeout — files are larger, but stream-copy is I/O bound).

On any failure: clean the temp directory and rethrow with a contextual message; the caller (`maybeSplitForUpload`) will retag the error with `phase = 'preflight'`.

### `maybeSplitForUpload` contract

```ts
async function maybeSplitForUpload(
  segments: AudioSegment[],
  context: { userId: string; slotId: string },
  onProgress?: (phase: 'splitting' | 'done', currentPart?: number, totalParts?: number) => void,
): Promise<{
  segments: AudioSegment[];
  didSplit: boolean;
  tempUris: string[];   // temp split files, for caller to delete after upload success
}>
```

Pre-flight:
- Sum `getInfoAsync(uri).size` across all input segments.
- Call `FileSystem.getFreeDiskStorageAsync()`. Require `freeBytes >= 1.5 × totalInputBytes`. Throw a user-friendly message if not.
- For each segment: if `size > MAX_FILE_SIZE_BYTES`, run `splitAudioBySize`; else pass through unchanged.
- Flatten outputs into a single ordered `AudioSegment[]`. Track every temp URI for cleanup.
- If total parts (split parts + pass-through segments) > `MAX_SPLIT_PARTS`, throw: "Recording is too long to upload (over ~36 hours). Please record shorter sessions."

Returns `didSplit = false` only when no segment exceeded the cap, in which case the caller can stay on `createWithFile` for single-segment slots. (Optimization, not correctness — `createWithSegments` works for N=1 too.)

### Phase tag rename

Current `UploadPhase` union (in `src/api/recordings.ts:80-87`):
```
'silent_check' | 'presign' | 'r2_put' | 'confirm' | 'create_draft' | 'unknown'
```

Add `'preflight'`. Move these throw sites from `silent_check` → `preflight`:
- File missing (`recordings.ts:388`)
- File empty (`recordings.ts:392`)
- File too large (`recordings.ts:395-399`)
- Multi-segment counterparts (`:579, :583, :585-589`)
- Disk space insufficient (new)
- Split failure (new)
- Part count > 20 (new)

`silent_check` keeps only the actual silence detection — the `hasSilentAudioOnly()` call against peakMetering. Future Sentry dashboard filter `phase:silent_check` returns only mic-input issues; `phase:preflight` returns only file-validation issues.

This is a documentation-quality fix that pairs naturally with this work because we're already touching the same throw sites.

### Data flow

```
                                        oversize?
                                           │
                                  ┌────────┴────────┐
                                  │                 │
                                  No               Yes
                                  │                 │
                                  ▼                 ▼
                           createWithFile()   confirm dialog
                           or createWith        │
                           Segments() as       Cancel? → return slot to pending
                           today                │
                                              Upload
                                                │
                                                ▼
                                         disk-space check
                                                │
                                                ▼
                                         Preparing audio…
                                         (FFmpeg segment muxer,
                                          stream copy)
                                                │
                                                ▼
                                       N parts (each ≤ 250 MB)
                                                │
                                                ▼
                                       createWithSegments(
                                         parts,
                                         existingRecordingId: slot.serverDraftId
                                       )
                                                │
                                                ▼
                                       presign × N → R2 PUT × N
                                                │
                                                ▼
                                       confirm with segmentKeys[]
                                                │
                                                ▼
                                       server: ffmpeg concat -c copy
                                                │
                                                ▼
                                       transcribe → SOAP → done
                                                │
                                                ▼
                                       client cleanup:
                                       - delete temp split parts
                                       - delete original audio
                                       - delete local draft metadata
```

## Error handling

| Failure | Tag | User-visible behavior |
|---|---|---|
| Disk space insufficient | `phase=preflight`, `error_code=DISK_SPACE` | Alert message embeds the actual computed deficit, e.g. `"Not enough free space to prepare this upload — needs ${requiredGB} GB free, ${freeGB} GB available."` Compute `requiredGB = Math.ceil(1.5 * totalInputBytes / 1e9 * 10) / 10`. Slot stays in `error`. |
| FFmpeg split fails | `phase=preflight`, `error_code=SPLIT_FAILED` | Alert: "Could not prepare the recording. Please retry or contact support." Sentry capture with FFmpeg log tail (≤200 chars) for diagnosis. |
| Split produces > 20 parts | `phase=preflight`, `error_code=TOO_LONG` | Alert: "Recording is too long to upload (over ~36 hours). Please record shorter sessions." Slot stays in `error`. |
| User cancels confirm dialog | (no tag) | Slot returns to `pending`. No Sentry capture. No `submit_failed` analytics. Internal `UploadCancelledByUser` sentinel error caught at the `uploadSlot` boundary. |
| Network fails during a part upload | unchanged | Existing `createWithSegments` per-segment retry/timeout logic. Temp split files retained on disk. User can retry, which will re-detect oversized state and re-show confirm. |
| App killed during split | n/a | Temp files orphaned in `${documentDirectory}split-temp/`. Cleanup sweep on Record-tab mount (sibling to existing `draftStorage.cleanupOrphaned`) deletes temp dirs older than 24h. |

## Stuck-user recovery (REACT-NATIVE-7)

No bespoke migration code. After installing the new build:
1. User opens app → sees stashed session in Saved Sessions.
2. Tap Resume → `useStashedSessions.resumeSession` restores `slot.serverDraftId` from stash payload (already supported per CLAUDE.md rule 24).
3. Tap Submit → `uploadSlot` runs new path: detects oversize → confirm → split → `createWithSegments` with `existingRecordingId = slot.serverDraftId`.
4. Server promotes the existing draft in place (the 404 they were hitting earlier was specific to that one stale draft ID; their newer attempts have created/refreshed the row).
5. Recovery is transparent — they retry one more time and it succeeds.

## Testing

| Layer | Coverage |
|---|---|
| Unit | Mock `FFmpegKit.execute` and `getInfoAsync`; assert `splitAudioBySize` builds the correct command, reads N outputs, computes durations from size ratio. Mock `getFreeDiskStorageAsync` to verify disk-space gate. |
| Unit | `maybeSplitForUpload`: pass-through case (no oversize), single oversized segment splits to N parts, mixed-size multi-segment input flattens correctly, > 20 part limit throws, disk-space throw, temp URI tracking. |
| Integration (emulator) | Emulator silence-check blocks all real uploads (per CLAUDE.md), so add a `__DEV__`-only AsyncStorage debug flag `force_split_threshold_bytes` (default `null`) that lets a developer set a 1 MB cap to exercise the full split → confirm → upload path on a small recording. Off in release. |
| Physical device | Pixel 10 Pro XL: record ~30 min, copy the m4a 4× and stitch via local ffmpeg into a single oversized file injected into the slot via the dev console (route to be added in `__DEV__`-gated dev-tools screen, separate change), then submit and verify split → upload → server concat → transcript appears. |
| Sentry verification | Force a `phase=preflight` error in dev (e.g., set the debug threshold to 0 bytes) and confirm Sentry tags the event with `phase=preflight`, not `phase=silent_check`. |

## Risks

- **Slow tablets:** Galaxy Tab A7 Lite stream-copy of 6 h ≈ 30–60 s. Confirm dialog sets expectations. UploadOverlay's "Preparing audio…" phase will be visible for the duration. If we see widespread complaints, consider a progress callback driven by `FFmpegKit.executeAsync`'s log line parsing (FFmpeg emits `time=` updates).
- **Disk space on old devices:** 1.5× margin requirement may block users with tight storage. The thrown error message points at the cause and suggests freeing space — the only real mitigation. Disk-tight tablets are a clinic-environment fact; the alternative (silent failure) is worse.
- **Stream-copy correctness for AAC in m4a:** AAC frames are independently decodable (1024 samples each, ~23 ms). `ffmpeg -f segment -c copy` on m4a is a well-trodden path; the same flag is what server uses for the inverse concat. Risk is low; tests will catch regressions.
- **AAC bitrate variance:** VBR encoders make exact-size targeting impossible from time alone. The 50 MB margin (200 MB target vs 250 MB cap) covers expected variance for typical voice content. If a part comes back > cap, `createWithSegments` will reject it at its own validation throw — at that point the user sees the disk-space-style error and the temp files orphan. Add a re-split fallback (target 150 MB) only if we see this in production.

## Open questions

None — all clarifying questions answered during brainstorming. Implementation plan to follow via `superpowers:writing-plans`.

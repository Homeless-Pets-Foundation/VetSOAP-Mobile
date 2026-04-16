import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import type { CreateRecording } from '../types';

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000, 5_000];

// Race-cleanup paths in record.tsx used to fire-and-forget
// `recordingsApi.delete(...).catch(() => {})` to drop an orphaned draft row.
// A transient failure (bad network, token refresh mid-flight, 5xx) silently
// left the draft in the database; on the next Recordings list it rendered as
// "Not Submitted" next to its completed sibling. This helper retries with
// short backoff so one blip doesn't leak an orphan.
export async function deleteRecordingWithRetry(
  recordingId: string,
  attempts = DEFAULT_ATTEMPTS
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await recordingsApi.delete(recordingId);
      return true;
    } catch (err) {
      if (__DEV__) console.warn('[cleanup] delete retry', i + 1, recordingId, err);
      if (i < attempts - 1) {
        const delay = BACKOFF_MS[i] ?? 5_000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return false;
}

export type PatchDraftOutcome =
  | 'success'              // PATCH succeeded
  | 'draft_missing'        // 404 — draft no longer exists; upload must fresh-create
  | 'not_draft'            // 409 NOT_DRAFT — draft already promoted; may still be usable for upload
  | 'transient_failure';   // retries exhausted — keep existingRecordingId and accept stale metadata

// Historically record.tsx treated any PATCH failure as "drop the draft and
// create a fresh row," which is the root cause of the duplicate-draft-plus-
// completed pattern: a blip during metadata sync spawned a second server
// recording. This helper retries transient failures and classifies permanent
// ones so callers can distinguish "draft is gone" (fresh create required)
// from "network hiccup" (reuse draft id, carry slightly stale metadata —
// strictly better than leaving an orphan behind).
export async function patchDraftMetadataWithRetry(
  recordingId: string,
  data: Partial<CreateRecording>,
  attempts = DEFAULT_ATTEMPTS
): Promise<PatchDraftOutcome> {
  for (let i = 0; i < attempts; i++) {
    try {
      await recordingsApi.updateDraftMetadata(recordingId, data);
      return 'success';
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) return 'draft_missing';
        if (err.status === 409 && err.code === 'NOT_DRAFT') return 'not_draft';
        // 4xx other than 404/409-NOT_DRAFT: not retryable, treat as permanent.
        if (err.status >= 400 && err.status < 500 && err.status !== 429) {
          return 'transient_failure';
        }
      }
      if (__DEV__) console.warn('[cleanup] patch-draft retry', i + 1, recordingId, err);
      if (i < attempts - 1) {
        const delay = BACKOFF_MS[i] ?? 5_000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return 'transient_failure';
}

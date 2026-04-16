import { recordingsApi } from '../api/recordings';

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

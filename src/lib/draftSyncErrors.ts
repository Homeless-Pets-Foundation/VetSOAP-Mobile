import { isApiError, isRequestTimeoutError } from '../api/apiErrors';

/** Expected transport failures leave the saved local draft pending for retry. */
export function isDraftSyncTransportError(error: unknown): boolean {
  return isRequestTimeoutError(error) ||
    (error instanceof TypeError && /network request failed/i.test(error.message));
}

/**
 * A server CONFLICT on the draft-create path.
 *
 * 409 means the server's row for this recording moved on from what we sent —
 * most often `IDEMPOTENCY_KEY_MISMATCH`, i.e. the row is already claimed by a
 * different upload-intent key (`src/lib/uploadIntent.ts` rotates the key on an
 * approved restart or an audio change, so a replayed create carries the old
 * one). The work is not lost: a conflict proves the server already HAS a row.
 *
 * It is separated from the generic failure branch because it was arriving as an
 * untyped `captureException` with the generic 'Something went wrong. Please try
 * again.' message (Sentry REACT-NATIVE-1Z), which says nothing about what
 * happened and is not actionable. Classifying it does NOT change local state:
 * the draft stays exactly as the generic branch left it, because deciding which
 * side wins a conflict needs the server contract, not a guess here.
 */
export function isDraftSyncConflictError(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

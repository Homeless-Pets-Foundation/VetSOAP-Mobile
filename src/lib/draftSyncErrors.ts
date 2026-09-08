import { isRequestTimeoutError } from '../api/apiErrors';

/** Expected transport failures leave the saved local draft pending for retry. */
export function isDraftSyncTransportError(error: unknown): boolean {
  return isRequestTimeoutError(error) ||
    (error instanceof TypeError && /network request failed/i.test(error.message));
}

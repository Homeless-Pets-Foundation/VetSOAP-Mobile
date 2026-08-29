/**
 * Retryability + user-facing copy for `/auth/me` failures.
 *
 * Extracted from AuthProvider.tsx so these branches can be tested by
 * EXECUTION — tests/helpers/loadTs.mjs resolves `.ts` only, never `.tsx`, so
 * anything left in the component is fenced by regex alone. Same reasoning as
 * src/lib/appLockPolicy.ts.
 *
 * The bug this extraction was written for: a request TIMEOUT is neither a
 * TypeError nor an ApiError, so it fell through to `false` and was treated as
 * terminal. That skipped both the [1000, 2000, 4000] backoff and — worse — the
 * cached-profile fallback, stranding an offline vet on "Can't reach Captivet"
 * instead of letting them reach their own un-uploaded drafts. AuthProvider's
 * own comment already documented the intended contract as
 * "network/timeout/5xx"; the code just never implemented the timeout half.
 */
import {
  isApiError,
  isRequestTimeoutError,
  isStorageUnavailableError,
} from '../api/apiErrors';
import { ACCOUNT_LOAD_ERROR_COPY } from '../constants/strings';

/**
 * Transient-looking errors from /auth/me that deserve a retry. Deliberately
 * narrow: a 401 is already handled by apiClient's refresh flow, a 403 / 404 /
 * 422 shouldn't be retried, and anything not matching here lands directly in
 * the error state.
 */
export function isRetryableFetchUserError(error: unknown): boolean {
  // Our own 30s deadline. Classified by TYPE, not by message: the message is
  // owned by the upload-retry regex and must not become a second contract.
  if (isRequestTimeoutError(error)) return true;
  // A bounded SecureStore read that timed out on the request path. Same
  // reasoning as the request deadline: it is a local, transient fault, and
  // treating it as terminal would skip the cached-profile fallback and strand
  // the vet — reintroducing the very bug this module was extracted to fix.
  // The fallback's own reads are separately bounded, so attempting it against
  // a degraded Keystore is safe: it degrades to null, not to another hang.
  if (isStorageUnavailableError(error)) return true;
  if (error instanceof TypeError && /network/i.test(error.message)) return true;
  if (isApiError(error)) {
    // 5xx and network-layer 0 both warrant a retry.
    return error.status === 0 || error.status >= 500;
  }
  return false;
}

export function fetchUserErrorMessage(error: unknown): string {
  // Never leak "Request timeout after 30000ms" to a vet — it reached the
  // screen verbatim before, via the `error.message` fallthrough below.
  if (isRequestTimeoutError(error)) return ACCOUNT_LOAD_ERROR_COPY.timeout;
  if (isStorageUnavailableError(error)) return ACCOUNT_LOAD_ERROR_COPY.storage;
  if (error instanceof TypeError && /network/i.test(error.message)) {
    return ACCOUNT_LOAD_ERROR_COPY.offline;
  }
  if (isApiError(error)) {
    return error.message || `Server error (HTTP ${error.status}).`;
  }
  if (error instanceof Error) return error.message;
  return 'Failed to load your account.';
}

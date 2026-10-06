/**
 * Bounded session refresh for the 401 and foreground-resume paths (rule 24).
 *
 * Extracted from AuthProvider.tsx so the decision is testable by EXECUTION —
 * tests/helpers/loadTs.mjs resolves `.ts` only, never `.tsx`.
 *
 * `supabase.auth.refreshSession()` and `getSession()` first await GoTrue's
 * `initialize()`, and RN's fetch has no timeout of its own. When a cold-start
 * restore (sessionRestore.ts) adopted the persisted session because that
 * initialize() stalled, every later refresh queued behind it. A 401 then
 * waited in onUnauthorized for as long as the stall lasted, and since
 * concurrent 401s share one refresh, so did every other request: a Submit
 * could stay on its spinner indefinitely (Codex review on VetSOAP-Mobile#234).
 * A refresh fetch that stalls mid-session has the same shape.
 *
 * So no refresh is attempted while GoTrue's startup is known to be pending,
 * and an attempted one is bounded. Either way the outcome is `unresolved`:
 * GoTrue could not answer, which is not proof that the session is dead.
 * Callers keep the session and fail only the request in hand, as retryable
 * (ApiClient raises a RequestTimeoutError), instead of signing the vet out.
 */
import { withPromiseTimeout } from '../lib/promiseTimeout';

/**
 * GoTrue's own refresh retries a retryable failure for up to 30 s, so a
 * refresh cut at this bound may still land later. That is fine: a late
 * success arrives as TOKEN_REFRESHED, and a late hard failure as SIGNED_OUT.
 */
export const AUTH_REFRESH_TIMEOUT_MS = 15_000;

export type BoundedAuthResult<T> = { timedOut: false; value: T } | { timedOut: true };

/** Run a GoTrue call with a deadline. A rejection is rethrown; only the deadline reads as `timedOut`. */
export async function boundedAuthCall<T>(
  call: () => Promise<T>,
  timeoutMs: number = AUTH_REFRESH_TIMEOUT_MS,
): Promise<BoundedAuthResult<T>> {
  let timedOut = false;
  try {
    const value = await withPromiseTimeout(call(), timeoutMs, 'auth_call_timeout', () => {
      timedOut = true;
      return new Error('auth_call_timeout');
    });
    return { timedOut: false, value };
  } catch (error) {
    if (timedOut) return { timedOut: true };
    throw error;
  }
}

export type RefreshUnresolvedReason = 'init_pending' | 'timeout';

export type RefreshAttempt<E> =
  | { kind: 'refreshed' }
  | { kind: 'failed'; error: E }
  | { kind: 'unresolved'; reason: RefreshUnresolvedReason };

/**
 * One refresh, never left hanging. `failed` is GoTrue's own answer (the caller
 * decides whether it ends the session); `unresolved` means GoTrue could not
 * answer and must never end it.
 */
export async function attemptSessionRefresh<E>(
  refresh: () => Promise<{ error: E | null }>,
  initPending: boolean,
  timeoutMs: number = AUTH_REFRESH_TIMEOUT_MS,
): Promise<RefreshAttempt<E>> {
  if (initPending) return { kind: 'unresolved', reason: 'init_pending' };
  const result = await boundedAuthCall(refresh, timeoutMs);
  if (result.timedOut) return { kind: 'unresolved', reason: 'timeout' };
  const { error } = result.value;
  return error ? { kind: 'failed', error } : { kind: 'refreshed' };
}

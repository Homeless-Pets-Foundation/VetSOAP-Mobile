/**
 * Offline-first cold-start session restore.
 *
 * Extracted from AuthProvider.tsx so the decision is testable by EXECUTION —
 * tests/helpers/loadTs.mjs resolves `.ts` only, never `.tsx`. Same reasoning as
 * fetchUserErrors.ts and appLockPolicy.ts.
 *
 * The defect (Sentry REACT-NATIVE-1K, `init_watchdog_fired` on
 * `auth_init_get_session`): `supabase.auth.getSession()` awaits GoTrue's
 * `initialize()`, and `initialize()` refreshes the stored session over the
 * network whenever the access token is within 90s of expiry. auth-js 2.116
 * retries a failed refresh with exponential backoff for up to 30s, and RN's
 * fetch has no timeout of its own. So once the 1h access token has lapsed,
 * EVERY cold start waits on the network:
 *
 * - offline, `getSession()` resolves `session: null` with an
 *   `AuthRetryableFetchError` — GoTrue deliberately KEEPS the session in
 *   storage for a retryable failure;
 * - on a slow or stalled link it outlives the 10s deadline.
 *
 * Either way the vet landed on the sign-in screen while still holding a valid
 * refresh token. Offline they cannot sign in, so their drafts and the recorder
 * were unreachable until connectivity returned — and the profile-cache
 * fallback in `fetchUser` never ran, because it is only reached once a session
 * exists.
 *
 * The fix restores the persisted session GoTrue itself would use, but ONLY
 * when GoTrue could not answer for a transient reason. An authoritative answer
 * is honored: `session: null` with no error means signed out, and a
 * non-retryable error means GoTrue has already removed a dead session. The
 * restored token is then validated lazily exactly like the normal restore
 * path: GoTrue's background refresh emits TOKEN_REFRESHED on success, and a
 * dead refresh token surfaces as SIGNED_OUT, which onAuthStateChange handles.
 */
import type { Session } from '@supabase/supabase-js';

/**
 * Bound for the direct storage read behind a restore (rule 24). The 10s
 * `auth_init_get_session` deadline plus this stays inside the 15s top-level
 * init watchdog, so a restore lands before that watchdog would release the
 * loading gate onto the sign-in screen. tests/auth-session-restore.test.mjs
 * asserts the budget against the literals in AuthProvider.tsx.
 */
export const SESSION_RESTORE_READ_TIMEOUT_MS = 4_000;

/** Why a restore was attempted. Closed set — it is an analytics prop. */
export type SessionRestoreTrigger = 'unanswered' | 'retryable_error';

/**
 * The parts of a `getSession()` result this decision reads. Loose on purpose:
 * the caller holds `withTimeout`'s `T | null`, and a decision about an
 * unexpected shape must fail toward "no restore".
 */
export interface GetSessionResultLike {
  data?: { session?: unknown } | null;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a bounded `getSession()` outcome warrants restoring from storage.
 *
 * `null` is what `withTimeout` yields when GoTrue never answered — the
 * deadline fired or the call rejected. A resolved result restores only when
 * GoTrue reported no session BECAUSE of a retryable network failure. Matched
 * by `name`, not `instanceof`, for the same reason rule 22 is: two module
 * instances of auth-js produce two class objects.
 */
export function sessionRestoreTrigger(
  result: GetSessionResultLike | null | undefined,
): SessionRestoreTrigger | null {
  if (result == null) return 'unanswered';
  if (result.data?.session) return null;
  const error = result.error;
  if (isRecord(error) && error.name === 'AuthRetryableFetchError') {
    return 'retryable_error';
  }
  return null;
}

/**
 * Parse the session GoTrue persisted (it stores `JSON.stringify(session)` via
 * our storage adapter). Stricter than GoTrue's own `_isValidSession`, which
 * only checks that the keys exist: a restore must never adopt a session it
 * cannot attribute to a user, because `fetchUser`'s profile-cache fallback
 * keys on that id (rule 13 user scoping on shared tablets).
 */
export function parsePersistedSession(raw: unknown): Session | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { access_token, refresh_token, expires_at, user } = value;
  if (typeof access_token !== 'string' || access_token.length === 0) return null;
  if (typeof refresh_token !== 'string' || refresh_token.length === 0) return null;
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) return null;
  if (!isRecord(user) || typeof user.id !== 'string' || user.id.length === 0) return null;
  return value as unknown as Session;
}

/** Who a cold-start restore adopted, and under which auth generation. */
export interface RestoredSessionStamp {
  userId: string;
  generation: number;
  /** The adopted access token's `expires_at`, in seconds (see restoredExpiryExplains). */
  expiresAt: number;
}

/**
 * GoTrue's own EXPIRY_MARGIN_MS. A token this close to expiry is already being
 * refreshed, and the margin absorbs the request's time in flight plus modest
 * device-server clock skew.
 */
const RESTORED_EXPIRY_MARGIN_MS = 90_000;

/**
 * Whether a terminal `/auth/me` failure is only the restored token's own
 * expiry. A 401 normally means the API refused the account, so `fetchUser`
 * skips the profile cache. But a restore runs exactly when GoTrue cannot
 * refresh (offline, or its fetch stalled), and the token it adopts has usually
 * expired. With the API still reachable, `/auth/me` answers 401 for that expiry
 * alone, and treating it as a refusal stranded the vet on "Can't Load Account"
 * (Codex review on VetSOAP-Mobile#234). The 10 s fresh-session guard keeps the
 * 401 handlers from refreshing into the same stalled GoTrue; GoTrue's own
 * background refresh still decides, through TOKEN_REFRESHED or SIGNED_OUT.
 *
 * Any real session event clears the stamp, so a 401 on a refreshed token is a
 * refusal again. Matched by `name` like the rest of this module.
 *
 * Expiry is judged when the 401 arrives, not when the token was adopted: a
 * token restored with seconds to spare can expire on its way to the server.
 *
 * Scoped to `/auth/me`: there a 401 only ever means a missing or invalid token
 * (Connect `routes/auth.ts`). On `/api` routes a 401 can also mean a revoked
 * device, so do not reuse this for them.
 */
export function restoredExpiryExplains(
  error: unknown,
  stamp: RestoredSessionStamp | null | undefined,
  currentGeneration: number,
  nowMs: number,
): boolean {
  if (!stamp || stamp.generation !== currentGeneration) return false;
  if (stamp.expiresAt * 1000 - RESTORED_EXPIRY_MARGIN_MS > nowMs) return false;
  return isRecord(error) && error.name === 'ApiError' && error.status === 401;
}

/**
 * The restored user id `fetchUser`'s profile-cache fallback may use when
 * GoTrue's own `getSession()` reports no session — which it does for as long
 * as an offline refresh keeps failing, even though the session is still in
 * storage. Every sign-out path bumps the auth generation, so a stamp from an
 * earlier generation is retired: a cached profile is never served across a
 * sign-out (rule 13, shared tablets).
 */
export function restoredUserIdFor(
  stamp: RestoredSessionStamp | null | undefined,
  currentGeneration: number,
): string | undefined {
  if (!stamp || stamp.generation !== currentGeneration) return undefined;
  return stamp.userId.length > 0 ? stamp.userId : undefined;
}

/** True once the access token's own expiry (not GoTrue's 90s margin) has passed. */
export function isAccessTokenExpired(session: Pick<Session, 'expires_at'>, nowMs: number): boolean {
  return typeof session.expires_at !== 'number' || session.expires_at * 1000 <= nowMs;
}

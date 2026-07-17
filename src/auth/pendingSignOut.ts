/**
 * Tracks the in-flight GoTrue sign-out so a subsequent sign-in can wait for
 * it instead of racing it (Codex P2, PR #143).
 *
 * Screens that must stay responsive (rule 24) bound their wait on
 * `supabase.auth.signOut()` with a timeout and navigate on — but the
 * underlying operation keeps running. If a user then completes a fresh
 * sign-in before that stale sign-out reaches GoTrue's local
 * session-removal step, the late `_removeSession()` deletes the NEW
 * session and logs the user straight back out. GoTrue offers no way to
 * abort a sign-out, so the fix is sequencing: every sign-in path calls
 * `waitForPendingSignOut()` first, ensuring the stale operation has
 * settled (or is hung past any realistic completion) before a new session
 * can exist for it to clobber.
 */

let pending: Promise<unknown> | null = null;

/** Register a sign-out promise; returns it for chaining. Never throws. */
export function trackPendingSignOut<T>(signOutPromise: Promise<T>): Promise<T> {
  const settled = signOutPromise
    .catch(() => {})
    .finally(() => {
      if (pending === settled) pending = null;
    });
  pending = settled;
  return signOutPromise;
}

/**
 * Resolve once any tracked sign-out settles, or after timeoutMs — the bound
 * keeps sign-in usable if GoTrue hangs (rule 24). Returns `true` when it is
 * safe to authenticate (no pending sign-out, or it settled in time) and
 * `false` on timeout with the sign-out STILL running — callers must then
 * abort with a retryable error instead of authenticating: a sign-out that
 * settles after the timeout would delete the just-established session, the
 * exact race this module exists to prevent (Codex P2, PR #143).
 */
export async function waitForPendingSignOut(timeoutMs: number): Promise<boolean> {
  const current = pending;
  if (!current) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settledInTime = false;
  try {
    await Promise.race([
      // `current` is the settled-chain from trackPendingSignOut (never rejects).
      current.then(() => {
        settledInTime = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return settledInTime;
}

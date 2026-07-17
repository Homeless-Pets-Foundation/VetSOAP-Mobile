// Codex round-3 (PR #143): a timed-out GoTrue sign-out keeps running after the
// UI moves on; if its late _removeSession() lands after a fresh sign-in, the
// new session is deleted and the user is logged straight back out. Sign-out
// promises are tracked (pendingSignOut.ts) and every sign-in path waits for
// them, bounded per rule 24. Also covers the MFA setup-key accessibility
// ungrouping from the same review round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('every raw GoTrue sign-out that can outlive its screen is tracked', async () => {
  const pendingModule = await read('src/auth/pendingSignOut.ts');
  assert.match(pendingModule, /export function trackPendingSignOut/);
  assert.match(pendingModule, /export async function waitForPendingSignOut/);

  // Both reset-password sign-outs (Cancel + post-update success alert) race a
  // timeout / navigate on, so both must be tracked.
  const resetPassword = await read('app/(auth)/reset-password.tsx');
  const tracked = resetPassword.match(/trackPendingSignOut\(supabase\.auth\.signOut\(\)\)/g) ?? [];
  assert.ok(tracked.length >= 2, `expected both reset-password signOuts tracked, found ${tracked.length}`);
  assert.doesNotMatch(resetPassword, /(?<!trackPendingSignOut\()supabase\.auth\.signOut\(\)/);

  // handleSignOut bounds its GoTrue call at 3s but the call keeps running —
  // it must be tracked too.
  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /trackPendingSignOut\(supabase\.auth\.signOut\(\)\)/);
});

test('all sign-in paths wait for a pending sign-out before authenticating', async () => {
  const auth = await read('src/auth/AuthProvider.tsx');
  // password + Google + Apple — each establishes a session a stale sign-out
  // could clobber. Bounded wait keeps sign-in usable if GoTrue hangs (rule 24),
  // and a timed-out wait ABORTS with a retryable error instead of
  // authenticating into the race (Codex P2 round 4).
  const aborts = auth.match(/if \(!\(await waitForPendingSignOut\(10_000\)\)\)/g) ?? [];
  assert.ok(aborts.length >= 3, `expected >=3 abort-on-timeout waits, found ${aborts.length}`);
  const retryErrors = auth.match(/error: LOGIN_COPY\.signOutStillPending/g) ?? [];
  assert.ok(retryErrors.length >= 3, `expected >=3 retryable-error returns, found ${retryErrors.length}`);
  const signInStart = auth.indexOf('const signIn = useCallback');
  const passwordCall = auth.indexOf('supabase.auth.signInWithPassword', signInStart);
  const waitInSignIn = auth.indexOf('waitForPendingSignOut', signInStart);
  assert.ok(
    waitInSignIn > signInStart && waitInSignIn < passwordCall,
    'signIn must wait for the pending sign-out BEFORE signInWithPassword'
  );
  // waitForPendingSignOut reports whether the sign-out actually settled.
  const pendingModule = await read('src/auth/pendingSignOut.ts');
  assert.match(pendingModule, /Promise<boolean>/);
  assert.match(pendingModule, /return settledInTime/);
});

test('MFA copy-setup-key button is not swallowed by the accessible QR group', async () => {
  const mfa = await read('app/(auth)/mfa.tsx');
  // The accessible group must close before the container holding the Copy
  // button — grouping it made the button unreachable for VoiceOver/TalkBack.
  assert.match(
    mfa,
    /accessibilityLabel="QR code for authenticator app setup[^"]*"[\s\S]*?<\/View>\s*<View className="mt-3">/
  );
  assert.match(mfa, /Copy setup key/);
});

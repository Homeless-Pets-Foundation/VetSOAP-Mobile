/**
 * Guards the fix for the production request-amplification storm.
 *
 * Symptom (Sentry, 1.13.11 -> 1.13.18): `slow_phase_fetchUser` up to 16.7s,
 * `init_watchdog_fired` firing 36/39 times on `auth_init_get_session` with the
 * app ACTIVE and the network reachable, and a single event carrying THREE
 * concurrent `fetchUser` phases (22.1s / 11.9s / 11.7s). Server-side the same
 * endpoints are p95 < 600ms, so the cost was repetition and queueing on the
 * device, not latency on the server.
 *
 * Cause: `usePathname()` was a dependency of `handleMfaRequiredResponse`, which
 * is a dependency of `registerDevice`, which is a dependency of `fetchUser`,
 * which is a dependency of the startup `useEffect`. Every navigation therefore
 * re-ran the whole auth init: a new watchdog, a new `getSession()`, a new
 * `onAuthStateChange` subscription and another `/auth/me` + device-register
 * round trip, with the previous ones never cancelled.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('pathname is read through a ref and is not an auth-callback dependency', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(provider, /const pathnameRef = useRef\(pathname\);\s*\n\s*pathnameRef\.current = pathname;/);
  assert.match(provider, /const currentPath = pathnameRef\.current \|\| '\/';/);

  // handleMfaRequiredResponse closes over the ref and depends only on `router`.
  assert.match(
    provider,
    /const handleMfaRequiredResponse = useCallback\([\s\S]*?\n\s*\[router\]\s*\n\s*\);/
  );

  // Exactly three bare `pathname` references may exist: the usePathname()
  // binding, the useRef seed, and the per-render mirror assignment. A fourth
  // means it leaked back into a dependency array and the whole auth chain
  // re-identifies on every navigation again.
  const code = provider
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  const occurrences = code.match(/(?<![A-Za-z])pathname(?![A-Za-z])/g) ?? [];
  assert.equal(occurrences.length, 3, 'pathname must only be bound and mirrored into the ref');
});

test('the auth init effect depends only on stable identities', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  // Walking the chain: each link must not re-identify on navigation.
  assert.match(provider, /\}, \[handleMfaRequiredResponse\]\);/);
  assert.match(
    provider,
    /\}, \[applyFetchedUser, handleMfaRequiredResponse, registerDevice\]\);/
  );
  assert.match(provider, /\}, \[fetchUser, registerDevice, setRecoveryDraftSlotId\]\);/);

  // The init effect still exists and still owns the watchdog + getSession.
  assert.match(provider, /const initWatchdog = setTimeout\(\(\) => \{/);
  assert.match(provider, /withTimeout\(supabase\.auth\.getSession\(\), 10_000, 'auth_init_get_session'\)/);
});

test('fetchUser is single-flight with an identity-checked release', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(provider, /const fetchUserInFlightRef = useRef<Promise<boolean> \| null>\(null\)/);
  assert.match(provider, /if \(fetchUserInFlightRef\.current\) \{\s*return fetchUserInFlightRef\.current;\s*\}/);
  assert.match(provider, /fetchUserInFlightRef\.current = promise;/);
  // Releasing unconditionally would let an earlier call drop a later call's
  // handle, reopening the duplicate-request window.
  assert.match(
    provider,
    /if \(fetchUserInFlightRef\.current === promise\) \{\s*fetchUserInFlightRef\.current = null;\s*\}/
  );
  // Both settlement paths observed — a bare `.then()` would leave an unhandled
  // rejection (rule 4).
  assert.equal((provider.match(/promise\.then\(releaseSlot, releaseSlot\);/g) ?? []).length, 2);
});

test('registerDevice releases its single-flight slot only when it still owns it', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(
    provider,
    /if \(registerDeviceInFlightRef\.current === promise\) \{\s*registerDeviceInFlightRef\.current = null;\s*\}/
  );
  // The old unconditional clear lived in a `finally` INSIDE the measured body.
  assert.doesNotMatch(provider, /finally \{\s*registerDeviceInFlightRef\.current = null;\s*\}/);
});

test('fetchUser reports the nested registerDevice duration as a phase tag', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  // registerDevice is measured INSIDE fetchUser, so `slow_phase_fetchUser` and
  // `slow_phase_registerDevice` are not independent latencies. The tag lets
  // triage subtract instead of double-counting.
  assert.match(provider, /const phaseTags: Record<string, string \| number \| boolean \| null \| undefined> = \{\};/);
  assert.match(provider, /measurePhase\('fetchUser', phaseTags,/);
  assert.match(provider, /registerMsTotal \+= Math\.max\(0, Date\.now\(\) - startedAt\);/);
  assert.match(provider, /phaseTags\.register_ms = registerMsTotal;/);
});

test('the device id is memoized so a cold start reads the Keystore once', async () => {
  const storage = await read('src/lib/secureStorage.ts');

  assert.match(storage, /let cachedDeviceId: string \| null = null;/);
  assert.match(storage, /async getDeviceId\(\): Promise<string \| null> \{\s*if \(cachedDeviceId\) return cachedDeviceId;/);
  // Only successful reads are cached, so a transient Keystore failure retries.
  assert.match(storage, /if \(id\) cachedDeviceId = id;\s*\n\s*return id;/);
  // DEVICE_ID is device-scoped and deliberately survives clearAll(), so the
  // memo can never go stale within a process.
  assert.doesNotMatch(storage, /deleteItemAsync\(KEYS\.DEVICE_ID\)/);
});

test('the fetchUser single-flight handle is dropped on every sign-out path', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  // On a shared clinic tablet the next user's sign-in must start its own
  // /auth/me rather than be handed the departing session's in-flight promise.
  // Both the explicit sign-out and the involuntary SIGNED_OUT branch clear it.
  assert.equal(
    (provider.match(/fetchUserInFlightRef\.current = null;/g) ?? []).length,
    3,
    'expected the release helper plus both sign-out paths'
  );
  assert.match(
    provider,
    /trackEvent\(\{ name: 'session_signed_out', props: \{ trigger: 'user' \} \}\);[\s\S]{0,500}?fetchUserInFlightRef\.current = null;/
  );
  assert.match(
    provider,
    /clearTelemetryIdentity\(\);[\s\S]{0,400}?fetchUserInFlightRef\.current = null;\s*\n\s*setUser\(null\);\s*\n\s*setSession\(null\);\s*\n\s*setProfileSource\('live'\);/
  );
});

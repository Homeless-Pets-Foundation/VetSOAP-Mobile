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
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

/**
 * SecureStore double with independently controllable read/write faults, so the
 * device-ID path can be exercised against the three Keystore behaviours that
 * actually occur on device: a hard throw, a silent write that never lands, and
 * recovery partway through a process.
 */
function makeDeviceStore({ failReads = false, failWrites = false, silentWrites = false } = {}) {
  const store = new Map();
  const counts = { reads: 0, writes: 0 };
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      counts.reads += 1;
      if (store.__failReads ?? failReads) throw new Error('keystore read unavailable');
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      counts.writes += 1;
      if (store.__failWrites ?? failWrites) throw new Error('keystore write unavailable');
      // A silent write resolves but never persists — the rule-17 hazard.
      if (store.__silentWrites ?? silentWrites) return;
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
    __store: store,
    __counts: counts,
    recover() {
      store.__failReads = false;
      store.__failWrites = false;
      store.__silentWrites = false;
    },
  };
}

async function loadSecureStorage(mock) {
  // Every generation must yield a DIFFERENT uuid, otherwise "the pending id was
  // reused" and "a second identity was minted" would be indistinguishable.
  let seed = 0;
  const mod = await loadTsModule('src/lib/secureStorage.ts', {
    'expo-secure-store': mock,
    'expo-crypto': {
      getRandomBytes: (n) => {
        seed += 1;
        return Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed * 101) % 256);
      },
    },
  });
  return mod.secureStorage;
}

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
  assert.match(
    storage,
    /async getDeviceIdWithProvenance\(\): Promise<\{ id: string \| null; persisted: boolean \}> \{\s*if \(cachedDeviceId\) return \{ id: cachedDeviceId, persisted: true \};/
  );
  // Only an ID storage is KNOWN to hold is memoized. The unconditional
  // `if (id) cachedDeviceId = id` promoted a value whose two write attempts had
  // both failed, so the process never retried persistence and the next launch
  // minted a second device identity.
  assert.doesNotMatch(storage, /if \(id\) cachedDeviceId = id;/);
  assert.match(storage, /let pendingDeviceId: string \| null = null;/);
  // DEVICE_ID is device-scoped and deliberately survives clearAll(), so the
  // memo can never go stale within a process.
  assert.doesNotMatch(storage, /deleteItemAsync\(KEYS\.DEVICE_ID\)/);
});

test('the api client never pins a device id that storage has not accepted', async () => {
  const client = await read('src/api/client.ts');

  // ApiClient keeps its OWN device-id cache. Caching an unpersisted id there
  // stops every later request from re-entering getDeviceId, so secureStorage's
  // retry never runs and the next launch registers a second identity.
  assert.match(client, /const \{ id, persisted \} = await secureStorage\.getDeviceIdWithProvenance\(\);/);
  assert.match(client, /if \(id && persisted\) this\.cachedDeviceId = id;/);
  // The header is still sent from the unpersisted value (rule 21).
  assert.match(client, /deviceId = id;/);
  assert.doesNotMatch(client, /const id = await secureStorage\.getDeviceId\(\);\s*\n\s*if \(id\) this\.cachedDeviceId = id;/);
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
    /clearTelemetryIdentity\(\);[\s\S]{0,400}?fetchUserInFlightRef\.current = null;\s*\n\s*registerDeviceInFlightRef\.current = null;\s*\n\s*authGenerationRef\.current \+= 1;\s*\n\s*setUser\(null\);\s*\n\s*setSession\(null\);\s*\n\s*setProfileSource\('live'\);/
  );
});

// --- device ID persistence (Codex round 4) -----------------------------------
// An ID that only ever existed in memory used to be memoized as if it were
// durable, so the process stopped retrying the write and the NEXT launch
// generated and registered a second identity — stranding a device session
// against the organization's device limit.

test('a device id whose writes both failed is not memoized as persisted', async () => {
  const mock = makeDeviceStore({ failWrites: true });
  const secureStorage = await loadSecureStorage(mock);

  const first = await secureStorage.getDeviceId();
  assert.ok(first, 'the in-flight request still needs an X-Device-Id (rule 21)');
  assert.equal(mock.__store.size, 0, 'nothing reached storage');

  const writesAfterFirst = mock.__counts.writes;
  const second = await secureStorage.getDeviceId();
  assert.equal(second, first, 'the process must present ONE identity while broken');
  assert.ok(mock.__counts.writes > writesAfterFirst, 'persistence is retried, not short-circuited');

  // Keystore recovers mid-process: the SAME id must be the one that lands.
  mock.recover();
  const third = await secureStorage.getDeviceId();
  assert.equal(third, first);
  assert.equal(mock.__store.get('captivet_device_id'), first);

  // Now it is proven durable, so it is memoized and storage is left alone.
  const writesAfterRecovery = mock.__counts.writes;
  const readsAfterRecovery = mock.__counts.reads;
  assert.equal(await secureStorage.getDeviceId(), first);
  assert.equal(mock.__counts.writes, writesAfterRecovery);
  assert.equal(mock.__counts.reads, readsAfterRecovery);
});

test('a silently-dropped device id write is not treated as persisted', async () => {
  // setItemAsync resolving is not proof the value landed (rule 17); only the
  // read-back is.
  const mock = makeDeviceStore({ silentWrites: true });
  const secureStorage = await loadSecureStorage(mock);

  const first = await secureStorage.getDeviceId();
  assert.ok(first);
  assert.equal(mock.__store.size, 0);

  mock.recover();
  assert.equal(await secureStorage.getDeviceId(), first, 'no second identity minted');
  assert.equal(mock.__store.get('captivet_device_id'), first);
});

test('an existing stored device id wins over one generated during an outage', async () => {
  const mock = makeDeviceStore({ failReads: true });
  const secureStorage = await loadSecureStorage(mock);

  const generated = await secureStorage.getDeviceId();
  assert.ok(generated);

  // The Keystore recovers and turns out to have held an ID all along. Storage
  // is the authority: adopt it rather than registering the generated one.
  mock.__store.set('captivet_device_id', 'pre-existing-device-id');
  mock.recover();
  assert.equal(await secureStorage.getDeviceId(), 'pre-existing-device-id');
  assert.equal(await secureStorage.getDeviceId(), 'pre-existing-device-id');
});

test('a device id already in storage is read once and then memoized', async () => {
  const mock = makeDeviceStore();
  mock.__store.set('captivet_device_id', 'stored-device-id');
  const secureStorage = await loadSecureStorage(mock);

  assert.equal(await secureStorage.getDeviceId(), 'stored-device-id');
  assert.equal(mock.__counts.reads, 1);
  assert.equal(await secureStorage.getDeviceId(), 'stored-device-id');
  assert.equal(mock.__counts.reads, 1, 'the memo serves repeat calls');
  assert.equal(mock.__counts.writes, 0, 'an existing id is never rewritten');
});

// --- account-scoped registration flight (Codex round 6) ----------------------

test('the registerDevice flight is scoped to the signed-in account', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  // `POST /api/device-sessions/register` is authenticated and creates a session
  // row for the ACCOUNT, so the single-flight promise is user-scoped even though
  // the device id is not. Handing A's flight to B left B with no session row
  // (every request 428s) and could paint the device-limit modal with A's device
  // names on a shared clinic tablet.
  assert.match(provider, /const authGenerationRef = useRef\(0\);/);
  assert.match(provider, /const generation = authGenerationRef\.current;/);
  assert.match(
    provider,
    /const isCurrentAccount = \(\) => authGenerationRef\.current === generation;/
  );
  // The old comment claimed the handle deliberately survives sign-out.
  assert.doesNotMatch(provider, /registerDevice's handle is deliberately NOT cleared/);

  // Both sign-out paths drop the handle AND bump the generation, so an
  // already-running flight cannot apply its result to the next session.
  assert.equal(
    (provider.match(/registerDeviceInFlightRef\.current = null;/g) ?? []).length,
    3,
    'expected the release helper plus both sign-out paths'
  );
  assert.equal((provider.match(/authGenerationRef\.current \+= 1;/g) ?? []).length, 2);

  // Every state write in the flight is behind the guard: success, the no-device-id
  // early return, and the whole error branch (which owns the limit-block state).
  assert.match(provider, /if \(!isCurrentAccount\(\)\) return false;\s*\n\s*if \(!deviceId\) \{/);
  assert.match(
    provider,
    /if \(!isCurrentAccount\(\)\) return false;[\s\S]{0,300}?setDeviceRegistrationBlock\(null\);/
  );
  assert.match(
    provider,
    /\} catch \(error\) \{\s*\n\s*if \(!isCurrentAccount\(\)\) return false;/
  );
});

test('the device-limit modal accepts an empty live device list', async () => {
  const hook = await read('src/hooks/useDeviceCapacity.ts');
  const modal = await read('src/components/DeviceLimitModal.tsx');

  // `devices` flattens "not loaded yet" and "loaded, genuinely none" into `[]`.
  // Now that the query actually runs while blocked, rejecting the empty answer
  // restored the stale 403 snapshot: the modal hid its empty-state Retry
  // Registration action and kept offering IDs whose revokes now fail.
  assert.match(hook, /hasData: boolean;/);
  assert.match(hook, /hasData: query\.data !== undefined,/);
  assert.match(modal, /hasData: hasLiveDevices,/);
  assert.match(modal, /if \(hasLiveDevices\) return liveDevices;/);
  assert.doesNotMatch(modal, /if \(liveDevices && liveDevices\.length > 0\) return liveDevices;/);
});

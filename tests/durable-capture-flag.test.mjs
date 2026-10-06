/**
 * Guards the durable-capture flag's persistence and provenance (Sentry
 * REACT-NATIVE-1X).
 *
 * The flag lived only in memory, started OFF in every process, and flipped OFF
 * on any response without the header. A fresh recording therefore took the
 * expo-audio path — whose MPEG-4 file does not survive a process death — on
 * every cold start until the first API response, for a whole offline session,
 * and after any edge-proxy error page. In production a tablet froze (ANR,
 * REACT-NATIVE-22) and was killed with an EXPO capture in flight while the
 * server had durable capture enabled.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');
const KEY = 'captivet_durable_capture_flag';

function makeStore({ stored = undefined, failWrites = 0, hangReads = false } = {}) {
  const map = new Map();
  if (stored !== undefined) map.set(KEY, stored);
  const counts = { reads: 0, writes: 0 };
  let writesToFail = failWrites;
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      counts.reads += 1;
      if (hangReads) return new Promise(() => {});
      return map.has(key) ? map.get(key) : null;
    },
    async setItemAsync(key, value) {
      counts.writes += 1;
      if (writesToFail > 0) {
        writesToFail -= 1;
        throw new Error('keystore write unavailable');
      }
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
    map,
    counts,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const load = (store, globals = {}) =>
  loadTsModule('src/lib/durableFlag.ts', { 'expo-secure-store': store }, globals);

test('unknown is OFF; an API response turns it on and is persisted once', async () => {
  const store = makeStore();
  const flag = await load(store);
  assert.equal(flag.isDurableCaptureEnabled(), false);

  flag.applyDurableCaptureHeader('true', true);
  await flush();
  assert.equal(flag.isDurableCaptureEnabled(), true);
  assert.equal(store.map.get(KEY), 'true');
  assert.equal(store.counts.writes, 1);

  // Every API response carries the header; an unchanged value costs no write.
  flag.applyDurableCaptureHeader('true', true);
  flag.applyDurableCaptureHeader('true', true);
  await flush();
  assert.equal(store.counts.writes, 1);
});

test('only an API response can move the flag; from the API an absent header fails closed', async () => {
  const store = makeStore();
  const flag = await load(store);
  flag.applyDurableCaptureHeader('true', true);

  // An edge-proxy 502/503 page or captive portal: no request-id echo.
  flag.applyDurableCaptureHeader(null, false);
  flag.applyDurableCaptureHeader('false', false);
  assert.equal(flag.isDurableCaptureEnabled(), true, 'a non-API response must not disable capture');

  // The API itself without the header is the deploy that cannot take ADTS.
  flag.applyDurableCaptureHeader(null, true);
  await flush();
  assert.equal(flag.isDurableCaptureEnabled(), false);
  assert.equal(store.map.get(KEY), 'false');

  flag.applyDurableCaptureHeader('true', true);
  flag.applyDurableCaptureHeader('false', true);
  assert.equal(flag.isDurableCaptureEnabled(), false);
  flag.applyDurableCaptureHeader('1', true);
  assert.equal(flag.isDurableCaptureEnabled(), true);
});

test('a cold start without network uses the stored value', async () => {
  for (const [stored, expected] of [
    ['true', true],
    ['false', false],
    ['garbage', false],
    [undefined, false],
  ]) {
    const flag = await load(makeStore({ stored }));
    assert.equal(flag.isDurableCaptureEnabled(), false, 'nothing is known before hydration');
    await flag.ensureDurableCaptureFlagHydrated();
    assert.equal(flag.isDurableCaptureEnabled(), expected, `stored ${String(stored)}`);
  }
});

test('hydration never overrides a value learned in this process', async () => {
  // The write of the learned value fails, so storage still holds the STALE value
  // when hydration reads it — the case the "fill only if unknown" rule exists for.
  const learnedOff = await load(makeStore({ stored: 'true', failWrites: 1 }));
  learnedOff.applyDurableCaptureHeader(null, true);
  await learnedOff.ensureDurableCaptureFlagHydrated();
  assert.equal(learnedOff.isDurableCaptureEnabled(), false);

  const learnedOn = await load(makeStore({ stored: 'false', failWrites: 1 }));
  learnedOn.applyDurableCaptureHeader('true', true);
  await learnedOn.ensureDurableCaptureFlagHydrated();
  assert.equal(learnedOn.isDurableCaptureEnabled(), true);
});

test('a failed write is retried on the next response instead of being remembered as done', async () => {
  const store = makeStore({ failWrites: 2 });
  const flag = await load(store);
  flag.applyDurableCaptureHeader('true', true);
  await flush();
  await flush();
  assert.equal(flag.isDurableCaptureEnabled(), true, 'the in-memory value still gates this session');
  assert.equal(store.map.has(KEY), false);

  flag.applyDurableCaptureHeader('true', true);
  await flush();
  await flush();
  assert.equal(store.map.get(KEY), 'true');
});

test('hydration is bounded and settles to a synchronous fast path', async () => {
  let timers = 0;
  const countingTimers = {
    setTimeout: (fn, ms) => {
      timers += 1;
      return setTimeout(fn, ms);
    },
  };
  const flag = await load(makeStore({ stored: 'true' }), countingTimers);
  await flag.ensureDurableCaptureFlagHydrated();
  const afterFirst = timers;
  await flag.ensureDurableCaptureFlagHydrated();
  await flag.ensureDurableCaptureFlagHydrated();
  assert.equal(timers, afterFirst, 'a settled read must not arm a timer per record tap');

  // A hung Keystore read must not block record-start: it times out toward OFF.
  const hung = await load(makeStore({ hangReads: true }));
  const started = Date.now();
  await hung.ensureDurableCaptureFlagHydrated(50);
  assert.ok(Date.now() - started < 1000);
  assert.equal(hung.isDurableCaptureEnabled(), false);
});

test('EXPO_PUBLIC_FORCE_DURABLE_CAPTURE still wins', async () => {
  const previous = process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE;
  process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE = 'true';
  try {
    const flag = await load(makeStore({ stored: 'false' }));
    assert.equal(flag.isDurableCaptureEnabled(), true);
    flag.applyDurableCaptureHeader(null, true);
    assert.equal(flag.isDurableCaptureEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE;
    else process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE = previous;
  }
});

test('wiring: provenance from the request-id echo, hydration before the record-start decision', async () => {
  const client = await read('src/api/client.ts');
  assert.match(
    client,
    /applyDurableCaptureHeader\(durableFlag, resp\.headers\.get\('x-request-id'\) === requestId\);/
  );
  assert.doesNotMatch(client, /setDurableCaptureFlag\(/, 'the client must not bypass the provenance check');

  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /hydrateDurableCaptureFlag\(\)\.catch\(\(\) => \{\}\);/);

  const record = await read('app/(app)/(tabs)/record.tsx');
  const iHydrate = record.indexOf('await ensureDurableCaptureFlagHydrated();');
  const iResume = record.indexOf('if (!user?.id || !isDurableCaptureEnabled()');
  const iFresh = record.indexOf('const freshDurable =');
  assert.ok(iHydrate > 0, 'record-start awaits flag hydration');
  assert.ok(iHydrate < iResume && iHydrate < iFresh, 'hydration lands before both durable decisions read the flag');
});

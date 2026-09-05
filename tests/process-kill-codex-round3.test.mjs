/**
 * Codex review round 3 on PR #204.
 *
 * F1: the expo capture pointer must be COMMITTED before the mic opens. Expo is
 * the only backend running in production and has no manifest to rebuild from, so
 * a kill between "mic open" and "pointer committed" loses the audio AND the
 * ability to report the loss.
 *
 * F2: recovered_count must mean "recoverable from THIS kill", not "every durable
 * manifest on the device".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

function startHandler(src) {
  const start = src.indexOf('const startRecordingForSlot = useCallback(');
  const end = src.indexOf('startRecordingRef.current = startRecordingForSlot');
  assert.ok(start > 0 && end > start);
  return src.slice(start, end);
}

// ---- F1: pointer committed before the microphone opens --------------------

test('the expo pointer is awaited BEFORE recorder.start()', () => {
  const fn = startHandler(read(RECORD));
  const write = fn.indexOf('await racePreStartPointerWrite(');
  const start = fn.indexOf('await recorder.start();', write);
  assert.ok(write > 0, 'expo pointer write not found');
  assert.ok(start > write, 'the mic must not open before the pointer is committed');
});

test('the pre-start bound is far tighter than the overlapping-write bound', () => {
  const src = read(RECORD);
  // Time spent here is tap latency, in front of the microphone. The 3000 ms
  // budget is only acceptable for a write that overlaps native start.
  // Codex round 24 retired the looser overlapping-write budget: BOTH paths now
  // await the pointer write in front of the mic, so there is one bound and it
  // has to stay short enough to sit there.
  const pre = /const EXPO_PRESTART_POINTER_TIMEOUT_MS = (\d+);/.exec(src);
  assert.ok(pre);
  assert.ok(Number(pre[1]) <= 500, `pre-start bound ${pre[1]}ms is too long to sit in front of the mic`);
  assert.doesNotMatch(src, /DURABLE_ACTIVE_WRITE_TIMEOUT_MS/);
});

test('the bound RESOLVES, so a degraded Keystore delays the mic but never blocks it', () => {
  const src = read(RECORD);
  const fnIdx = src.indexOf('function racePreStartPointerWrite(');
  const body = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx));
  assert.match(body, /setTimeout\(resolve, EXPO_PRESTART_POINTER_TIMEOUT_MS\)/);
  assert.match(body, /p\.catch\(\(\) => \{\}\)/, 'a rejected write must not reject the race');
});

test('the durable pointer write is awaited BEFORE native start', () => {
  // Reversed deliberately at Codex round 24. Dispatching it and joining after
  // the native start made the before-first-frame ordering probabilistic: it
  // relied on encoder priming beating SecureStore, so a kill in that window
  // produced frames with no breadcrumb and went uncounted. Safe to await only
  // because the bound RESOLVES on timeout, and durable capture is off in
  // production so the fleet's tap latency is unaffected.
  const fn = startHandler(read(RECORD));
  assert.doesNotMatch(fn, /raceDurableActiveWrite/);
  assert.doesNotMatch(fn, /const activePointerWrite/);
  const durableWrites = fn.match(
    /await racePreStartPointerWrite\(\s*\n\s*durableActiveStore\.setActive\((recordingId|existingDurable\.recordingId)/g,
  );
  assert.equal(durableWrites?.length, 2, 'fresh start and resume both await it');
});

// ---- F2: recovered_count must describe THIS kill --------------------------

test('recovered_count intersects stale durable pointers with actual manifests', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /manifestIds: ReadonlySet<string>,/);
  // The old `manifests.length` also counted finished recordings already shown as
  // drafts/stashes, uploaded ones awaiting self-heal, and suppressed sessions.
  assert.doesNotMatch(src, /reportPriorUncleanExit\(manifests\.length\)/);
  assert.match(src, /if \(manifestIds\.has\(e\.recordingId\)\) recovered\+\+/);
  // Expo pointers can never be recoverable — no manifest exists for them.
  const probe = src.slice(src.indexOf('async function reportPriorUncleanExit'));
  const body = probe.slice(0, probe.indexOf('\n}\n'));
  const expoBranch = body.slice(body.indexOf("if (e.backend === 'expo')"), body.indexOf('} else {'));
  assert.doesNotMatch(expoBranch, /recovered\+\+/);
});

test('a failed manifest enumeration reports zero recoverable, not an unknown count', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /const EMPTY_MANIFEST_IDS: ReadonlySet<string> = new Set<string>\(\)/);
  assert.equal((src.match(/reportPriorUncleanExitDetached\(userId, EMPTY_MANIFEST_IDS, isCancelled\)/g) ?? []).length, 2);
});

// ---- behavioural: the counting rule itself --------------------------------

test('capturesAtLastExit still separates the two backends after the changes', async () => {
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('durable-1', 'slot-1', '2026-09-04T10:00:00.000Z', 'durable');
  await s.setActive('slot-2', 'slot-2', '2026-09-04T10:00:00.000Z', 'expo');
  const counts = await s.capturesAtLastExit();
  assert.equal(counts.durable, 1);
  assert.equal(counts.expo, 1);
});

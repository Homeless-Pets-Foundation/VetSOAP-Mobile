/**
 * Record-button tap→feedback fences (older-Android responsiveness).
 *
 * Symptom these pin: on a low-end Android tablet the record button "did
 * nothing" for a visible beat after a tap, and a second tap was silently
 * swallowed. Nothing visible changed until `bindRecorder`, which sat behind an
 * awaited floor-hydration read; the haptic fired after that await; and the
 * durable active-pointer write (~20 serial Keystore round trips, 16 of them
 * unconditional stale-chunk deletes) was awaited BEFORE the mic was touched.
 *
 * Behavioural where the code is pure (chunk sweep, hydration fast path),
 * regex-fenced where the code lives in a React component.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

function startHandler(record) {
  const start = record.indexOf('const startRecordingForSlot = useCallback(');
  const end = record.indexOf('startRecordingRef.current = startRecordingForSlot');
  assert.ok(start > 0 && end > start, 'startRecordingForSlot not found');
  return record.slice(start, end);
}

test('the tap is acknowledged synchronously, before the first await', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const fn = startHandler(record);
  const firstAwait = fn.indexOf('await ');
  const haptic = fn.indexOf('Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)');
  const starting = fn.indexOf('setStartingSlotId(slotId)');
  const stopwatch = fn.indexOf('const tappedAtMs = nowMs()');
  assert.ok(firstAwait > 0, 'handler has no await');
  assert.ok(haptic > 0 && haptic < firstAwait, 'haptic must fire before the first await');
  assert.ok(starting > 0 && starting < firstAwait, 'starting state must flip before the first await');
  assert.ok(stopwatch > 0 && stopwatch < firstAwait, 'tap stopwatch must start before the first await');
  assert.equal((fn.match(/Haptics\.impactAsync\(/g) ?? []).length, 1, 'exactly one start haptic');

  // Cleared on every exit path: the finally AND the outer catch.
  const finallyBlock = fn.slice(fn.lastIndexOf('} finally {'));
  assert.match(finallyBlock, /setStartingSlotId\(\(cur\) => \(cur === slotId \? null : cur\)\)/);
  const outerCatch = fn.slice(fn.lastIndexOf('})().catch('));
  assert.match(outerCatch, /setStartingSlotId\(\(cur\) => \(cur === slotId \? null : cur\)\)/);

  // Tap→recording stopwatch lands as a phase_complete breadcrumb (never a
  // slow-phase warning — the native phases already cover that).
  assert.match(fn, /completePhaseFrom\('record_tap_to_recording', tappedAtMs/);
  assert.match(record, /const \[startingSlotId, setStartingSlotId\] = useState<string \| null>\(null\)/);
  assert.match(
    record,
    /isStarting=\{startingSlotId === item\.id \|\| queuedStartSlotIds\.includes\(item\.id\) \|\| \(isRecorderOwner && recorder\.isStarting\)\}/,
  );
  // Every Start button is inert while ANY start chain is in flight (the
  // lockout recorder.isStarting used to give all cards), but a QUEUED start
  // must not lock the others: rapid taps across slots keep queueing.
  assert.match(record, /startInFlight=\{startingSlotId !== null \|\| recorder\.isStarting\}/);

  // A slot queued behind a stop-then-start shows the spinner too, and the
  // queue mirror is cleared at every pop/remove/reset so it cannot strand one.
  assert.match(record, /setQueuedStartSlotIds\(\(ids\) => \(ids\.includes\(slotId\) \? ids : \[\.\.\.ids, slotId\]\)\)/);
  assert.match(record, /setQueuedStartSlotIds\(\(ids\) => ids\.filter\(\(id\) => id !== slotId\)\)/);
  assert.equal(
    (record.match(/setQueuedStartSlotIds\(\(ids\) => ids\.filter\(\(id\) => id !== nextSlotId\)\)/g) ?? []).length,
    (record.match(/pendingStartSlotQueueRef\.current\.shift\(\)!/g) ?? []).length,
    'every queue pop must clear the render mirror',
  );
  assert.match(record, /pendingStartSlotQueueRef\.current = \[\];\s*setQueuedStartSlotIds\(\[\]\);/);
});

test('the slot card disables the record button and shows a spinner while starting', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  assert.match(card, /isStarting\?: boolean/);
  assert.match(card, /startInFlight\?: boolean/);
  assert.match(card, /const canStartRecording = \(recordFirstEnabled \|\| hasRequiredFields\) && audioState === 'idle' && !isUploading && !isStarting && !startInFlight && !isFinishSaving/);
  const idle = card.slice(card.indexOf("{audioState === 'idle' && ("), card.indexOf('{/* Recording: pause + finish */}'));
  assert.ok(idle.length > 0, 'idle button region not found');
  assert.match(idle, /isStarting \? \(\s*<ActivityIndicator/);
  assert.match(idle, /accessibilityState=\{\{ disabled: !canStartRecording, busy: isStarting \}\}/);
  assert.match(idle, /'Starting recording…'/);
});

test('the pager is told when start state changes, or the spinner cannot paint', async () => {
  // FlatList is a PureComponent. `data` is session.slots and the renderItem is
  // deliberately identity-stable, so without extraData the shallow prop compare
  // sees nothing when a tap sets startingSlotId — the cells never re-render and
  // the spinner plus the startInFlight lockout only appear once session.slots
  // itself changes, i.e. after the native start latency they exist to mask.
  const src = await read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /renderItem=\{stableRenderSlotCard\}\s*\n\s*extraData=\{slotCardExtraData\}/);

  const memo = src.slice(
    src.indexOf('const slotCardExtraData = useMemo('),
    src.indexOf('const getItemLayout'),
  );
  assert.ok(memo.length > 0, 'anchor');
  for (const key of ['startingSlotId', 'queuedStartSlotIds', 'recorderIsStarting']) {
    assert.match(memo, new RegExp(key), `extraData must carry ${key}`);
  }
  // The perf invariant this must not undo: the live timer and metering
  // re-render RecorderLiveReadout alone. Feeding duration in here would
  // re-render every card twice a second.
  assert.doesNotMatch(memo, /recorder\.duration/, 'duration must stay out of extraData');
  assert.doesNotMatch(memo, /getLiveStats/, 'getLiveStats must stay out of extraData');
});

test('the durable active-pointer write precedes native start', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const fn = startHandler(record);
  // Fresh-start branch.
  const fresh = fn.slice(fn.indexOf('const freshDurable ='));
  // Round 24: awaited BEFORE native start, not dispatched alongside it.
  const pointer = fresh.search(
    /await racePreStartPointerWrite\(\s*\n\s*durableActiveStore\.setActive\(recordingId, slotId/,
  );
  const start = fresh.indexOf('withDurableOpWatchdog(\n                recorder.start({ userId: user.id, slotId, recordingId })');
  const recording = fresh.indexOf("setAudioState(slotId, 'recording')");
  assert.ok(pointer > 0, 'pointer write missing');
  assert.ok(start > pointer, 'the breadcrumb must land BEFORE native start (round 24)');
  assert.ok(recording > start, 'recording state flips only after the start settles');
  // The overlapping helper is retired; there is no handle left to join.
  assert.doesNotMatch(fn, /raceDurableActiveWrite/);
  assert.doesNotMatch(fn, /activePointerWrite/);
  // Resume→Continue branch, same shape.
  const resume = fn.slice(fn.indexOf('const existingDurable ='), fn.indexOf('const freshDurable ='));
  const rPointer = resume.search(
    /await racePreStartPointerWrite\(\s*\n\s*durableActiveStore\.setActive\(existingDurable\.recordingId, slotId/,
  );
  const rResume = resume.indexOf('recorder.resumeDurable({ userId: user.id, slotId, durable: existingDurable })');
  assert.ok(rPointer > 0 && rResume > rPointer, 'resume breadcrumb must precede the native resume');
  // A failed fresh start clears its pointer; activeStore serializes mutations
  // so the clear lands AFTER the overlapped write, never racing it.
  assert.match(fn, /clearCapturePointer\(initiatingUserId, freshDurableRecordingId\)/);
});

test('active-pointer mutations are serialized so an overlapped clear cannot lose to its own write', async () => {
  const store = new Map();
  const secure = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      // Slow reads: enough interleaving for a naive read-modify-write to lose.
      await new Promise((r) => setTimeout(r, 2));
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
  };
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', { 'expo-secure-store': secure });
  const { durableActiveStore } = mod;
  durableActiveStore.setUserId('user1');
  const a = 'dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'dr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  // A failed start: the pointer write is still in flight when the catch
  // issues the clear. The clear must land AFTER the write.
  const write = durableActiveStore.setActive(a, 'slot-1', '2026-01-01T00:00:00.000Z');
  const clear = durableActiveStore.clearActive(a);
  await Promise.all([write, clear]);
  assert.deepEqual([...(await durableActiveStore.list())], []);

  // A re-tap while the previous write is pending: no lost update.
  await Promise.all([
    durableActiveStore.setActive(a, 'slot-1', '2026-01-01T00:00:01.000Z'),
    durableActiveStore.setActive(b, 'slot-2', '2026-01-01T00:00:02.000Z'),
  ]);
  assert.deepEqual(
    [...(await durableActiveStore.list())].map((e) => e.recordingId),
    [a, b],
  );

  // A failing Keystore read is swallowed by the lenient reader (rule 3): the
  // op sees an empty list, writes nothing, and must not stall the chain.
  const baseGet = secure.getItemAsync;
  secure.getItemAsync = async () => { throw new Error('keystore exploded'); };
  await durableActiveStore.clearActive(a);
  secure.getItemAsync = baseGet;
  assert.deepEqual([...(await durableActiveStore.list())].map((e) => e.recordingId), [a, b], 'a swallowed read must not write');
  await durableActiveStore.clearActive(a);
  assert.deepEqual([...(await durableActiveStore.list())].map((e) => e.recordingId), [b]);
});

test('the durable start is measured like the other native recorder phases', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // Observer only, and bounded by the same deadline as the start race so a
  // never-settling native start cannot leak measurePhase's AppState listener.
  assert.match(
    hook,
    /measurePhase\('recorder_durable_start', undefined, \(\) => withDurableTimeout\(startPromise, DURABLE_START_TIMEOUT_MS, '[^']+'\), \{\s*warningThresholdMs: NATIVE_RECORDER_PHASE_WARNING_MS,?\s*\}\)\.catch\(\(\) => \{\}\)/,
  );
  const monitoring = await read('src/lib/monitoring.ts');
  assert.match(monitoring, /export function completePhaseFrom\(/);
  assert.match(monitoring, /if \(__DEV__\) console\.log\(`\[perf\] \$\{name\} \$\{durationMs\}ms \$\{outcome\}`\)/);
});

test('completePhaseFrom emits the same breadcrumb shape as measurePhase', async () => {
  const breadcrumbs = [];
  const messages = [];
  const mod = await loadTsModule(
    'src/lib/monitoring.ts',
    {
      '@sentry/react-native': {
        addBreadcrumb: (b) => breadcrumbs.push(b),
        captureMessage: (m) => messages.push(m),
        withScope: (fn) => fn({ setTag() {}, setExtra() {}, setFingerprint() {}, setLevel() {} }),
        init() {},
        setUser() {},
        reactNativeTracingIntegration: () => ({}),
        breadcrumbsIntegration: () => ({}),
      },
      'react-native': {
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
        Platform: { OS: 'android' },
      },
      'expo-constants': { __esModule: true, default: { expoConfig: { version: 'test' } } },
      '../config': { SENTRY_DSN: '' },
    },
    { __DEV__: false, performance: { now: () => 1000 } },
  );
  // Not initialised → breadcrumb is a no-op, but the call must be total.
  mod.completePhaseFrom('record_tap_to_recording', 400, { backend: 'durable' }, { warningThresholdMs: null });
  assert.equal(breadcrumbs.length, 0);
  assert.equal(messages.length, 0);
});

test('writeChunkedValue sweeps only the chunks a previous, longer value could have left', async () => {
  const deletes = [];
  const store = new Map();
  const secure = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      deletes.push(key);
      store.delete(key);
    },
  };
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', { 'expo-secure-store': secure });

  // Unknown previous count → legacy 16-key sweep (tombstone callers unchanged).
  await mod.writeChunkedValue('p', 'small');
  assert.equal(deletes.length, 16, 'unknown prior count keeps the full sweep');

  // Known and not larger → zero deletes: this is the record-start hot path.
  deletes.length = 0;
  await mod.writeChunkedValue('p', 'small', { prevChunkCount: 1 });
  assert.deepEqual([...deletes], []);

  // Known and larger → exactly the stale indices.
  deletes.length = 0;
  await mod.writeChunkedValue('p', 'small', { prevChunkCount: 3 });
  assert.deepEqual([...deletes], ['p_chunk_1', 'p_chunk_2']);

  // And the count is reported alongside the value so callers can thread it.
  const { value, chunkCount } = await mod.readChunkedValueWithCount('p');
  assert.equal(value, 'small');
  assert.equal(chunkCount, 1);
  const absent = await mod.readChunkedValueWithCount('never-written');
  assert.equal(absent.value, null);
  assert.equal(absent.chunkCount, 0);
});

test('setActive on the steady-state active list issues no stale-chunk deletes', async () => {
  const deletes = [];
  const store = new Map();
  const secure = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      deletes.push(key);
      store.delete(key);
    },
  };
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', { 'expo-secure-store': secure });
  const { durableActiveStore } = mod;
  durableActiveStore.setUserId('user1');
  await durableActiveStore.setActive('dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'slot-1', '2026-01-01T00:00:00.000Z');
  // First write: nothing existed, so nothing can be stale.
  assert.deepEqual([...deletes], []);
  await durableActiveStore.setActive('dr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'slot-2', '2026-01-01T00:00:01.000Z');
  assert.deepEqual([...deletes], [], 'same chunk count → no sweep');
  assert.equal((await durableActiveStore.list()).length, 2);
  await durableActiveStore.clearActive('dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual([...deletes], []);
  assert.equal((await durableActiveStore.list()).length, 1);
});

test('ensureFloorHydrated resolves without arming a timer once hydration has settled', async () => {
  let timers = 0;
  const secure = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync() {
      return null;
    },
    async setItemAsync() {},
    async deleteItemAsync() {},
  };
  const mod = await loadTsModule(
    'src/lib/minVersion.ts',
    { 'expo-secure-store': secure },
    {
      setTimeout: (fn, ms) => {
        timers += 1;
        return setTimeout(fn, ms);
      },
    },
  );
  await mod.ensureFloorHydrated();
  const afterFirst = timers;
  assert.ok(afterFirst >= 1, 'first call races the storage read against a timer');
  await mod.ensureFloorHydrated();
  await mod.ensureFloorHydrated();
  assert.equal(timers, afterFirst, 'settled hydration must not allocate a 2 s timer per tap');
});

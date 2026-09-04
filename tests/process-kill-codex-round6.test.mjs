/**
 * Codex review round 6 on PR #204.
 *
 * Round 6 found that three earlier fixes were incomplete in the same way: a
 * deadline that settles the WRAPPER while the original work keeps running, and a
 * guard evaluated once before an await that can go stale. Plus one fix
 * (the discard clear) that could never have fired.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

// ---- F1: a stalled WRITE must not be overtaken and then clobber -----------

test('a hung setItemAsync stops later mutations writing underneath it', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const store = new Map();
  let hangWrites = false;
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        if (hangWrites) return new Promise(() => {}); // never settles
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('before', 'slot-before', '2026-09-04T09:00:00.000Z', 'expo');

  hangWrites = true;
  await s.setActive('hung', 'slot-hung', '2026-09-04T10:00:00.000Z', 'expo'); // abandoned at deadline

  // While the stalled write is unsettled, later mutations must stand off rather
  // than write state the stalled one could revert.
  hangWrites = false;
  await s.clearActive('before');

  const list = await s.list();
  assert.ok(
    list.some((e) => e.recordingId === 'before'),
    'the stand-off must prevent a write that the stalled op could later revert',
  );
});

test('a rejected op is not treated as a stall', async () => {
  // Only a genuinely hung op becomes the barrier; a fast rejection must not
  // wedge the store read-only.
  let failNext = true;
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failNext) { failNext = false; throw new Error('keystore blip'); }
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('boom', 'slot-boom', '2026-09-04T10:00:00.000Z', 'expo');
  await s.setActive('after', 'slot-after', '2026-09-04T10:01:00.000Z', 'expo');
  const list = await s.list();
  assert.ok(list.some((e) => e.recordingId === 'after'), 'a blip must not wedge the store');
});

test('the stall barrier is wired and explains why mid-write abort is unsafe', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  assert.match(src, /let stalledOp: Promise<void> \| null = null;/);
  assert.match(src, /if \(stalledOp\) return;/);
  assert.match(src, /if \(!workSettled\)/);
});

// ---- F2: the recording-activity guard must be rechecked before the Alert ---

test('the battery prompt rechecks recording activity immediately before the Alert', () => {
  const src = read('src/lib/batteryOptimization.ts');
  const alertIdx = src.indexOf('Alert.alert(');
  const checks = [...src.matchAll(/recordingActivity\.isActive\(\)/g)].map((m) => m.index);
  assert.ok(checks.length >= 2, 'one check before two awaits is stale by the time the Alert shows');
  assert.ok(checks.some((i) => i < alertIdx && i > src.indexOf('setRawItem(PROMPTED_KEY')),
    'must recheck AFTER the storage writes and BEFORE the Alert');
});

test('a prompt deferred at the recheck releases the one-shot marker', () => {
  // Otherwise the single chance to ask is burned on a prompt nobody saw.
  const src = read('src/lib/batteryOptimization.ts');
  const alertIdx = src.indexOf('Alert.alert(');
  const before = src.slice(0, alertIdx);
  assert.match(before, /deleteRawItem\(PROMPTED_KEY/);
});

// ---- F4: an expired sweep must stop, not run beside the next one ----------

test('serialized sweeps fold the expiry flag into their scope predicate', () => {
  const src = read(RECORD);
  assert.match(src, /work: \(isExpired: \(\) => boolean\) => Promise<void>/);
  assert.match(src, /scheduleNonUrgentWork\('orphan_cleanup', async \(isExpired\) =>/);
  assert.match(src, /scheduleNonUrgentWork\('thirty_day_eviction', async \(isExpired\) =>/);
  // Both must actually consult it, or the timeout only settles the wrapper and
  // the work races the job that overtook it.
  assert.equal((src.match(/!isExpired\(\) &&/g) ?? []).length, 2);
  assert.match(src, /expired = true;/);
});

// ---- F5: the discard handlers must clear directly ------------------------

test('discardCurrentSession clears both pointers before it erases the lookup state', () => {
  const src = read(RECORD);
  const idx = src.indexOf('if (shouldResetRecorder) {');
  const block = src.slice(idx, idx + 1600);
  const capture = block.indexOf('const discardedSlotId = session.recorderBoundToSlotId');
  const unbind = block.indexOf('unbindRecorder();');
  const clear = block.indexOf('durableActiveStore.clearActive(discardedSlotId)');
  assert.ok(capture > 0, 'ids must be captured');
  assert.ok(unbind > capture, 'captured before unbind erases them');
  assert.ok(clear > 0 && clear < unbind, 'cleared before the state is torn down');
  assert.match(block, /durableActiveStore\.clearActive\(discardedDurableId\)/);
});

test('the active-slot Remove flow clears both pointers too', () => {
  const src = read(RECORD);
  const idx = src.indexOf('const removedDurableId = recorder.activeDurableRecordingId;');
  assert.ok(idx > 0, 'durable id not captured in the Remove flow');
  const block = src.slice(idx, idx + 700);
  assert.match(block, /durableActiveStore\.clearActive\(slotId\)/);
  assert.match(block, /durableActiveStore\.clearActive\(removedDurableId\)/);
  assert.ok(block.indexOf('unbindRecorder();') > block.indexOf('clearActive(slotId)'));
});

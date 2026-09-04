/**
 * Codex review round 7 on PR #204.
 *
 * The headline finding is a regression in MY round-6 fix: the stand-off that
 * stopped a stalled write clobbering newer state also silently dropped
 * clearActive, which leaves a pointer behind for a recording that finished
 * normally — manufacturing exactly the false kill report this detector exists to
 * prevent. Dropping a WRITE is safe (missing evidence); dropping a CLEAR is not.
 *
 * The rest are user-scope drift across awaits.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

// ---- F4: a clear deferred by the stand-off must be replayed ---------------

test('a clear deferred by the stand-off is replayed once the stall settles', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const store = new Map();
  let hangWrites = false;
  let releaseWrite;
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        if (hangWrites) { await gate; }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('finished', 'slot-finished', '2026-09-04T09:00:00.000Z', 'expo');

  // A write stalls past the deadline.
  hangWrites = true;
  await s.setActive('stuck', 'slot-stuck', '2026-09-04T10:00:00.000Z', 'expo');

  // A recording finishes normally while the store is standing off. Previously
  // this reported success without clearing, and the pointer survived to the next
  // launch as a phantom kill.
  hangWrites = false;
  await s.clearActive('finished');

  releaseWrite();
  // Give the replay a chance to run through the queue.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 60));

  const list = await s.list();
  assert.ok(
    !list.some((e) => e.recordingId === 'finished'),
    'the deferred clear must be replayed, not dropped',
  );
});

test('the replay path is wired, and only clears are queued', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  assert.match(src, /let pendingClearTasks: \(\(\) => Promise<void>\)\[\] = \[\];/);
  assert.match(src, /function replayPendingClears\(\)/);
  assert.match(src, /replayPendingClears\(\);/);
  assert.match(src, /pendingClearTasks\.push\(run\)/);
  // setActive must NOT queue: a dropped write is a missing pointer, which is the
  // safe direction. Only clearActive passes an onDeferred callback.
  assert.equal((src.match(/pendingClearTasks\.push/g) ?? []).length, 1);
});

// ---- F1: a handled interruption is a clean exit ---------------------------

test('the expo interruption path clears the pointer, like the durable one', () => {
  const src = read(RECORD);
  const idx = src.indexOf("dispatch({ type: 'CONTINUE_RECORDING', slotId });");
  assert.ok(idx > 0);
  const block = src.slice(idx, idx + 800);
  assert.match(block, /durableActiveStore\.clearActive\(slotId\)/);
});

// ---- F2: the pre-start write belongs to the user who tapped Start ---------

test('pre-start pointer writes verify the initiating user', () => {
  const src = read(RECORD);
  assert.match(src, /const initiatingUserId = user\?\.id \?\? null;/);
  assert.match(src, /durableActiveStore\.getUserId\(\) === initiatingUserId/);
  // Both write sites are guarded: the plain expo start and the durable->expo
  // re-key, each of which runs after several awaits.
  assert.match(src, /if \(scopeUnchanged\(\)\) \{\n\s*expoPointerSlotId = slotId;/);
  assert.match(src, /getSelectedBackend\(\) === 'expo' && scopeUnchanged\(\)/);
});

// ---- F3: an in-flight prompt must notice a user switch --------------------

test('the battery prompt takes a scope predicate and rechecks it before the Alert', () => {
  const src = read('src/lib/batteryOptimization.ts');
  assert.match(src, /isScopeValid: \(\) => boolean = \(\) => true/);
  const alertIdx = src.indexOf('Alert.alert(');
  const guard = src.lastIndexOf('!isScopeValid()', alertIdx);
  assert.ok(guard > 0 && guard < alertIdx, 'must recheck scope immediately before the Alert');
  // And releasing the marker on that path, so the prompt is not consumed by a
  // user it was never meant for.
  assert.match(src.slice(0, alertIdx), /deleteRawItem\(PROMPTED_KEY/);
});

test('the Record screen passes a live scope predicate, not a captured boolean', () => {
  const src = read(RECORD);
  assert.match(src, /const promptUserId = user\.id;/);
  assert.match(src, /\(\) => !isExpired\(\) && durableActiveStore\.getUserId\(\) === promptUserId/);
});

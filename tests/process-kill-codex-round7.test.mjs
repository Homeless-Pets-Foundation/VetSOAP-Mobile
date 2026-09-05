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

test('a clean-finish clear is never lost, however an earlier op failed', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  // Round 7 fixed this with a replay queue on top of the stand-off; round 8
  // removed both, because the stand-off wedged permanently on a call that never
  // settled. The invariant is unchanged and is what this asserts: a clear that a
  // recording's clean finish issues must actually clear.
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
  await s.setActive('finished', 'slot-finished', '2026-09-04T09:00:00.000Z', 'expo');

  hangWrites = true;
  await s.setActive('stuck', 'slot-stuck', '2026-09-04T10:00:00.000Z', 'expo');
  hangWrites = false;
  await s.clearActive('finished');

  const list = await s.list();
  assert.ok(
    !list.some((e) => e.recordingId === 'finished'),
    'the clear must take effect, or the next launch reports a kill that never happened',
  );
});

// ---- F1: a handled interruption is a clean exit ---------------------------

test('the expo interruption path clears the pointer, like the durable one', () => {
  const src = read(RECORD);
  const idx = src.indexOf("dispatch({ type: 'CONTINUE_RECORDING', slotId });");
  assert.ok(idx > 0);
  const block = src.slice(idx, idx + 800);
  assert.match(block, /clearCapturePointer\(user\?\.id \?\? null, slotId\)/);
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
  // Round 23: the predicate gained a start-in-flight term and wrapped.
  assert.match(src, /!isExpired\(\) &&\s*\n\s*!startInFlightRef\.current &&\s*\n\s*durableActiveStore\.getUserId\(\) === promptUserId/);
});

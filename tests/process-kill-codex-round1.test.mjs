/**
 * Codex review round 1 on PR #204 — regression fences for all six findings.
 *
 * Every one is a way the process-kill detector produces a FALSE report, or a way
 * the pointer store it depends on stops working. A false "Android killed your
 * recording" is worse than no detector: it tells a vet their audio was
 * truncated when it never was.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

function secureStoreMock(seed = new Map()) {
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(k) { return seed.has(k) ? seed.get(k) : null; },
    async setItemAsync(k, v) { seed.set(k, v); },
    async deleteItemAsync(k) { seed.delete(k); },
    __store: seed,
  };
}

// ---- F1 (P2): user scope captured at call time, not at execution time ------

test('a queued setActive that lands after a user switch keeps the ORIGINAL scope', async () => {
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': secureStoreMock(store),
  });
  const s = mod.durableActiveStore;

  s.setUserId('userA');
  const pending = s.setActive('recA', 'slot-a', '2026-09-04T10:00:00.000Z', 'expo');
  // Sign-out + a different user signs in while the write is still queued.
  s.setUserId('userB');
  await pending;

  s.setUserId('userB');
  // Compare length, not deepEqual: vm-sandbox arrays carry a different
  // Array.prototype, so deepEqual's prototype check fails on identical values.
  assert.equal((await s.list()).length, 0, "user B must not inherit user A's pointer");

  s.setUserId('userA');
  const a = await s.list();
  assert.equal(a.length, 1, "user A's own pointer must survive");
  assert.equal(a[0].recordingId, 'recA');
});

test('a queued clearActive that lands after a user switch does not touch the new user', async () => {
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': secureStoreMock(store),
  });
  const s = mod.durableActiveStore;

  s.setUserId('userB');
  await s.setActive('shared-id', 'slot-b', '2026-09-04T11:00:00.000Z', 'expo');
  s.setUserId('userA');
  const pending = s.clearActive('shared-id');
  s.setUserId('userB');
  await pending;

  s.setUserId('userB');
  const b = await s.list();
  assert.equal(b.length, 1, "user B's pointer must not be cleared by user A's queued op");
});

// ---- F4 (P2): a not-credible chunk count must never become a sweep bound ---

test('a corrupt chunk count is not forwarded as a sweep bound', async () => {
  // MAX_CHUNKS_PER_VALUE is 512. Forwarding 999999999 made the next write run
  // that many sequential Keystore deletes, occupying activeStore's mutation
  // queue effectively forever and silently killing the detector.
  const store = new Map([['p_count', '999999999']]);
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': secureStoreMock(store),
  });
  const res = await mod.readChunkedValueWithCount('p');
  assert.equal(res.value, null);
  assert.equal(res.chunkCount, null, 'not-credible count must be null, not the corrupt number');
});

test('a TORN set still forwards its count — that bound is legitimate', async () => {
  // count says 3, only chunk 0 exists: the prior writer really did intend 3, so
  // it stays a usable sweep bound. Only `count_too_large` is discarded.
  const store = new Map([['p_count', '3'], ['p_chunk_0', 'aa']]);
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': secureStoreMock(store),
  });
  const res = await mod.readChunkedValueWithCount('p');
  assert.equal(res.value, null);
  assert.equal(res.chunkCount, 3);
});

test('writeChunkedValue clamps an absurd prevChunkCount instead of looping on it', async () => {
  const store = new Map();
  let deletes = 0;
  const mock = secureStoreMock(store);
  const counting = {
    ...mock,
    async deleteItemAsync(k) { deletes++; store.delete(k); },
  };
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': counting,
  });
  await mod.writeChunkedValue('p', 'hello', { prevChunkCount: 999999999 });
  assert.ok(deletes <= 512, `sweep must stay bounded, ran ${deletes} deletes`);
});

// ---- F5 (P2): the probe is a mutating side effect, so cancellation binds ---

test('every kill-probe call site is cancellation-guarded', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  // The probe reads AND clears activeStore; a stale scan resuming after a user
  // switch would report and clear the NEXT user's pointers.
  const calls = [...src.matchAll(/reportPriorProcessKillDetached\(/g)];
  // Definition + three guarded call sites (two early returns, one main path).
  assert.ok(calls.length >= 4, `expected the helper plus >=3 call sites, found ${calls.length}`);
  assert.equal(
    (src.match(/if \(!isCancelled\(\)\) reportPriorProcessKillDetached\(userId, EMPTY_MANIFEST_IDS, isCancelled\);/g) ?? []).length,
    2,
    'both early-return probes must be guarded',
  );
  assert.match(src, /reportPriorProcessKillDetached\(userId, new Set\(manifests\.map/);
});

// ---- F2 (P2): a failed start must not leave an expo pointer ----------------

test('a failed recorder start clears the expo capture pointer', () => {
  const src = read(RECORD);
  assert.match(src, /let expoPointerSlotId: string \| null = null;/);
  // Set as soon as the pointer write is issued, so the catch can always undo it.
  assert.match(src, /expoPointerSlotId = slotId;\n\s*await racePreStartPointerWrite\(/);
  // Must be cleared in the catch, alongside the durable ids.
  const catchStart = src.indexOf("} catch (error) {", src.indexOf('record_tap_to_recording'));
  const catchBlock = src.slice(catchStart, catchStart + 2500);
  assert.match(catchBlock, /durableActiveStore\.clearActive\(expoPointerSlotId\)/);
  assert.match(catchBlock, /durableActiveStore\.clearActive\(freshDurableRecordingId\)/);
});

// ---- F6 (P2): a deliberate discard must not read as a kill -----------------

test('the deliberate-discard path clears both capture pointers', () => {
  const src = read(RECORD);
  // discardCurrentSession and the slot-Remove flow both set skipNextAudioCaptureRef
  // and land in this one branch, which returns before the normal cleanup below.
  const skipIdx = src.indexOf('if (skipNextAudioCaptureRef.current && !audioCaptureDoneRef.current) {');
  assert.ok(skipIdx > 0);
  const branch = src.slice(skipIdx, skipIdx + 1800);
  assert.match(branch, /durableActiveStore\.clearActive\(discardedSlotId\)/);
  // A durably-recording slot has no slot.durable yet, so the discard loop's own
  // cleanup cannot reach it — clear the live id here too.
  assert.match(branch, /durableActiveStore\.clearActive\(discardedDurableId\)/);
  assert.match(branch, /recorder\.activeDurableRecordingId/);
});

// ---- F3 (P1): no false assurance about data safety ------------------------

test('the battery copy promises risk reduction, never prevention', () => {
  const strings = read('src/constants/strings.ts');
  const start = strings.indexOf('export const BATTERY_OPTIMIZATION_COPY');
  const block = strings.slice(start, strings.indexOf('} as const;', start));
  // The flow only opens a settings list; it cannot verify the exemption, OEM
  // killers ignore it, and durable capture is still off in production.
  assert.doesNotMatch(block, /prevents that/);
  assert.match(block, /less likely/);
  assert.match(block, /does not remove it/);
});

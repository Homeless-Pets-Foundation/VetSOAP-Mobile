/**
 * Codex review round 10 on PR #204.
 *
 * F1: the generation ring isolates CHUNK writes, but the single `_ptr` publish
 * can itself stall past the deadline and land after a newer publish, regressing
 * the pointer to a generation whose chunks the ring deliberately keeps.
 *
 * F2: the round-9 sign-out teardown was dead code. AuthProvider rebinds
 * durableActiveStore to null BEFORE clearing the React user state that unmounts
 * the Record screen, so the cleanup captured a null scope and did nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---- F1: a late _ptr write must not regress the pointer -------------------

test('a delayed pointer write cannot resurrect an older generation', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const store = new Map();
  let gatePtr = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        // Stall ONLY the publish, so the abandoned op's chunks are fully written
        // and its pointer write is in flight — exactly the round-10 case.
        if (gatePtr && k.endsWith('_ptr')) { await gate; }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('live', 'slot-live', '2026-09-04T09:00:00.000Z', 'expo');

  gatePtr = true;
  await s.setActive('stale', 'slot-stale', '2026-09-04T10:00:00.000Z', 'expo');

  gatePtr = false;
  await s.clearActive('live');

  // The abandoned publish finally lands, overwriting the newer pointer.
  release();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 40));

  const list = await s.list();
  assert.ok(!list.some((e) => e.recordingId === 'live'), 'a cleared pointer must stay cleared');
  assert.ok(!list.some((e) => e.recordingId === 'stale'), 'an abandoned publish must not win');
});

test('the publish carries a monotonic sequence and a high-water mark guards it', () => {
  const src = read('src/lib/durableAudio/chunkedStore.ts');
  assert.match(src, /const lastPublished = new Map<string, VersionedPointer>\(\);/);
  // Marked ONLY after a SUCCESSFUL publish. Marking before the write made a
  // stalled publish authoritative — a read would then prefer the very state the
  // deadline abandoned.
  const w = src.slice(src.indexOf('export async function writeChunkedValueVersioned'));
  const writeIdx = w.indexOf("setRawItem(\n    `${prefix}_ptr`");
  const markIdx = w.indexOf('lastPublished.set(prefix, pointer);');
  assert.ok(writeIdx > 0 && markIdx > writeIdx, 'mark must follow a successful pointer write');
  assert.match(src, /if \(ok\) \{/);
  assert.match(src, /const nextSeq = new Map<string, number>\(\);/);
  assert.match(src, /\(persisted\.s \?\? 0\) < \(known\.s \?\? 0\)/);
});

// ---- F2: sign-out ordering ------------------------------------------------

test('sign-out drops the store scope BEFORE the screen unmounts', () => {
  // The premise of the finding. If this ordering ever changes, the explicit-user
  // API below is still correct, but this test documents why it is needed.
  const auth = read('src/auth/AuthProvider.tsx');
  const scopeNull = auth.indexOf('durableActiveStore.setUserId(null)');
  const userNull = auth.indexOf('setUser(null)', scopeNull);
  assert.ok(scopeNull > 0 && userNull > scopeNull);
});

test('the unmount teardown clears by explicit user, not ambient scope', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /userId: user\?\.id \?\? null,/);
  assert.match(src, /durableActiveStore\.clearActiveForUser\(userId, slotId\)/);
  assert.match(src, /durableActiveStore\.clearActiveForUser\(userId, durableId\)/);
  // The ambient-scope version would silently no-op at sign-out.
  const idx = src.indexOf('const liveCaptureRef');
  // Bounded by the next declaration. A doesNotMatch inside a FIXED window is the
  // dangerous shape: as the block grows past it the assertion stops covering the
  // tail and passes vacuously, unlike a match, which fails loudly. The teardown
  // has roughly doubled since this was written (round 17's native finalize).
  const block = src.slice(idx, src.indexOf('const handlePause = useCallback(', idx));
  assert.ok(block.length > 0, 'anchor');
  assert.doesNotMatch(block, /durableActiveStore\.clearActive\(/);
});

test('clearActiveForUser ignores the ambient scope entirely', async () => {
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
  await s.setActive('rec', 'slot-1', '2026-09-04T09:00:00.000Z', 'expo');

  // Sign-out: scope dropped first, exactly as AuthProvider does it.
  s.setUserId(null);
  await s.clearActiveForUser('u1', 'rec');

  s.setUserId('u1');
  assert.equal((await s.list()).length, 0, 'the pointer must be cleared despite the null scope');
});

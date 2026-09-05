/**
 * Codex review round 11 on PR #204. Both findings are in the versioned pointer
 * READ path, and both fixes are subtractive.
 *
 * F1: when the high-water branch proved the persisted pointer superseded but the
 * known-good generation failed to read back, the code fell through and returned
 * the known-stale value. A caller that read-modify-writes it republishes cleared
 * capture ids — the one direction that FABRICATES a kill report.
 *
 * F2: the branch also best-effort republished the pointer. That repair was a
 * second uncontrolled writer of `_ptr`, outside the mutation queue sequencing
 * every other publish: stall it past a later clearActive and it lands after,
 * resurrecting the entry that clear removed.
 *
 * These exercise chunkedStore directly rather than driving activeStore, so a
 * late pointer write is simulated by rewriting the key instead of waiting out
 * the 5s mutation deadline.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

/**
 * Publishes two values, then rewrites `_ptr` back to the first publish — exactly
 * the state a stalled pointer write leaves behind once a newer one has landed.
 */
async function withRegressedPointer() {
  const store = new Map();
  let failGeneration = null;
  const reads = [];
  const ptrWrites = [];
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        reads.push(k);
        if (failGeneration !== null && k.includes(`_g${failGeneration}_chunk_`)) return null;
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) {
        if (k.endsWith('_ptr')) ptrWrites.push(v);
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });

  const superseded = JSON.stringify([{ recordingId: 'live', slotId: 's1' }]);
  const current = JSON.stringify([{ recordingId: 'keep', slotId: 's2' }]);
  await mod.writeChunkedValueVersioned(PREFIX, superseded);
  const stalePtr = store.get(`${PREFIX}_ptr`);
  await mod.writeChunkedValueVersioned(PREFIX, current);
  const knownPtr = JSON.parse(store.get(`${PREFIX}_ptr`));

  // The stalled publish finally lands, regressing the pointer.
  store.set(`${PREFIX}_ptr`, stalePtr);
  ptrWrites.length = 0;

  return {
    mod, store, knownPtr, superseded, current, ptrWrites,
    failKnownGeneration() { failGeneration = knownPtr.g; },
  };
}

test('a regressed pointer reads through the high-water mark, not the late write', async () => {
  const h = await withRegressedPointer();
  assert.equal(await h.mod.readChunkedValueVersioned(PREFIX), h.current);
});

test('the read never repairs the pointer', async () => {
  const h = await withRegressedPointer();
  const before = h.store.get(`${PREFIX}_ptr`);
  await h.mod.readChunkedValueVersioned(PREFIX);
  // A repair write here would be a second uncontrolled `_ptr` writer: if it
  // stalled past a later clearActive it would land afterwards and resurrect the
  // entry that clear removed. The next ordinary publish converges the pointer.
  assert.deepEqual(h.ptrWrites, [], 'a read must not write the pointer');
  assert.equal(h.store.get(`${PREFIX}_ptr`), before);
});

test('an unreadable known generation reads as absent, never as the superseded value', async () => {
  const h = await withRegressedPointer();
  h.failKnownGeneration();
  const got = await h.mod.readChunkedValueVersioned(PREFIX);
  assert.notEqual(got, h.superseded, 'must not serve state already proven superseded');
  // Absent is the safe answer: activeStore.readList maps null to [], which only
  // under-reports a kill. Returning the superseded list would let the next
  // read-modify-write republish the cleared 'live' id and fabricate one.
  assert.equal(got, null);
});

test('the pointer-regression branch has no write in it', () => {
  const src = read('src/lib/durableAudio/chunkedStore.ts');
  // The logic lives in readVersionedInternal since round 22 split the lenient
  // and strict readers; the public readers are thin wrappers over it.
  const fn = src.slice(
    src.indexOf('async function readVersionedInternal('),
    src.indexOf('const GEN_RING'),
  );
  assert.ok(fn.length > 0, 'anchor');
  assert.doesNotMatch(fn, /setRawItem\(/, 'the read path must not write');
  assert.match(fn, /return \{ value: null, readable: false \};/);
});

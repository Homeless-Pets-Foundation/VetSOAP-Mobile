/**
 * Codex review round 5 on PR #204.
 *
 * The activeStore mutation queue could hang forever. SecureStore HANGS rather
 * than rejects on a degraded Keystore, and `run.catch()` only fires on a SETTLED
 * rejection — so one stuck op stranded every later setActive/clearActive for the
 * session. Later captures would then carry no kill pointer at all, or keep a
 * false one, which quietly defeats the whole detector.
 *
 * Codex asked specifically for a never-settling storage call rather than another
 * rejection test. These are behavioural.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** SecureStore mock whose reads hang forever until released. */
function hangingSecureStore() {
  const store = new Map();
  let hangReads = false;
  return {
    mock: {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (hangReads) return new Promise(() => {}); // never settles
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
    hang() { hangReads = true; },
    release() { hangReads = false; },
    store,
  };
}

test('a never-settling storage call does not strand the mutation queue', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const h = hangingSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': h.mock,
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');

  // First op hangs forever inside the Keystore read.
  h.hang();
  const stuck = s.setActive('rec-hung', 'slot-hung', '2026-09-04T10:00:00.000Z', 'expo');

  // A later capture must still be able to record its pointer.
  h.release();
  const later = s.setActive('rec-later', 'slot-later', '2026-09-04T10:01:00.000Z', 'expo');

  await stuck;   // resolves via the deadline, not the hung call
  await later;

  const list = await s.list();
  assert.ok(
    list.some((e) => e.recordingId === 'rec-later'),
    'the queue must advance past a hung op so later captures still get a pointer',
  );
});

test('an op abandoned at the deadline cannot clobber later state', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  // Round 6 changed the correct OUTCOME here. A stalled op is not cancellable,
  // and aborting mid-write would leave new chunk bytes under the old count
  // pointer — a torn value, worse than the clobber. So the store now STANDS OFF
  // while a stalled op is unsettled: later mutations resolve without writing.
  // The invariant is therefore "no clobber, no torn state", not "the newer write
  // wins" — losing pointer updates on an already-failing Keystore is the
  // deliberate trade.
  const seeded = new Map();
  let gateOpen = false;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (gateOpen) await gate;
        return seeded.has(k) ? seeded.get(k) : null;
      },
      async setItemAsync(k, v) { seeded.set(k, v); },
      async deleteItemAsync(k) { seeded.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('seed', 'slot-seed', '2026-09-04T09:00:00.000Z', 'expo');

  gateOpen = true;
  await s.setActive('stale', 'slot-stale', '2026-09-04T09:30:00.000Z', 'expo'); // abandoned
  gateOpen = false;
  await s.setActive('fresh', 'slot-fresh', '2026-09-04T10:00:00.000Z', 'expo'); // stands off
  releaseRead();
  await new Promise((r) => setTimeout(r, 50));

  const list = await s.list();
  // The abandoned op must not have written once the queue moved on.
  assert.ok(!list.some((e) => e.recordingId === 'stale'), 'abandoned op must not write');
  // And the pre-existing entry must be intact — no torn or reverted state.
  assert.ok(list.some((e) => e.recordingId === 'seed'), 'existing state must survive');
});

test('the queue bound and abandon-generation are wired, not just declared', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  assert.match(src, /const MUTATION_TIMEOUT_MS = [\d_]+;/);
  assert.match(src, /withPromiseTimeout\(op\(isAbandoned\), MUTATION_TIMEOUT_MS/);
  assert.match(src, /let abandonGeneration = 0;/);
  assert.match(src, /abandonGeneration\+\+;/);
  // Both read-modify-write ops consult it after their read AND again at the
  // commit point, since the read may be fast while the write is what hangs.
  // Three read-modify-write ops now: setActive, clearActive, clearActiveForUser.
  assert.equal((src.match(/if \(isAbandoned\(\)\) return;/g) ?? []).length, 3);
  assert.equal((src.match(/\(\) => !isAbandoned\(\)/g) ?? []).length, 3);
});

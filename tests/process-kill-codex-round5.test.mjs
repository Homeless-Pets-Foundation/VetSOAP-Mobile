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

test('an op abandoned at the deadline cannot clobber the ops that overtook it', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const h = hangingSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': h.mock,
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');

  // Seed one entry so the hung op's stale read has content to revert to.
  await s.setActive('seed', 'slot-seed', '2026-09-04T09:00:00.000Z', 'expo');

  // Hang a read, then let it complete AFTER a newer op has written.
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const seeded = new Map(h.store);
  const gatedMock = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(k) {
      if (gatedMock.__gate) { await gate; }
      return seeded.has(k) ? seeded.get(k) : null;
    },
    async setItemAsync(k, v) { seeded.set(k, v); },
    async deleteItemAsync(k) { seeded.delete(k); },
    __gate: false,
  };
  const mod2 = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': gatedMock,
  });
  const s2 = mod2.durableActiveStore;
  s2.setUserId('u1');
  await s2.setActive('seed', 'slot-seed', '2026-09-04T09:00:00.000Z', 'expo');

  gatedMock.__gate = true;
  const stale = s2.setActive('stale', 'slot-stale', '2026-09-04T09:30:00.000Z', 'expo');
  await stale;              // abandoned at the deadline
  gatedMock.__gate = false;
  await s2.setActive('fresh', 'slot-fresh', '2026-09-04T10:00:00.000Z', 'expo');
  releaseRead();            // the hung read finally completes
  await new Promise((r) => setTimeout(r, 50));

  const list = await s2.list();
  assert.ok(list.some((e) => e.recordingId === 'fresh'), 'the newer write must survive');
});

test('the queue bound and abandon-generation are wired, not just declared', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  assert.match(src, /const MUTATION_TIMEOUT_MS = [\d_]+;/);
  assert.match(src, /withPromiseTimeout\(op\(isAbandoned\), MUTATION_TIMEOUT_MS/);
  assert.match(src, /let abandonGeneration = 0;/);
  assert.match(src, /abandonGeneration\+\+;/);
  // Both read-modify-write ops must consult it AFTER their read, or a late
  // completion silently reverts newer state.
  assert.equal((src.match(/if \(isAbandoned\(\)\) return;/g) ?? []).length, 2);
});

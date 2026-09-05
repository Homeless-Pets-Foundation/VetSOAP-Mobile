/**
 * Codex review round 24 on PR #204 — three P2s; two fixed here, one declined
 * and escalated (see the PR discussion / commit message).
 *
 * F1: the eight-entry ring alone did not stop recycling. A chunk write that
 * hangs past its op deadline keeps running, and after GEN_RING further
 * mutations — four ordinary start/finish cycles — its generation comes round
 * again and may be the one the CURRENT pointer names. The late write then
 * overwrites live chunks with a stale list WITHOUT touching the pointer
 * sequence, so neither the sequence nor the high-water mark can see it.
 *
 * F2: setActive still read leniently, so a transient read failure read as [] and
 * the publish DISCARDED prior-process pointers — a genuinely interrupted capture
 * would then never be reported. Round 22 fixed only the clears.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

test('a hung write keeps its generation reserved across a full ring wrap', async () => {
  const store = new Map();
  let hangGen = null;
  let release;
  let reached;
  const gate = new Promise((r) => { release = r; });
  // Synchronise on the mock actually BLOCKING. writeChunkedValueVersioned awaits
  // the `_ptr` read first, so the call yields before it ever reaches
  // setItemAsync — clearing the selector on the next line meant the chunk was
  // never gated, the test performed only sequential completed writes, and it
  // passed even with the reservation removed (Codex round 31).
  const atGate = new Promise((r) => { reached = r; });
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        if (hangGen !== null && k.includes(`_g${hangGen}_chunk_`)) {
          reached();
          await gate;
        }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });

  // First write establishes generation 0 and then hangs on its chunk. It carries
  // the same shouldCommit guard activeStore always passes, so once its deadline
  // passes it must not publish — mirroring a real abandoned mutation rather than
  // a bare writer call, which would legitimately publish on release.
  let abandoned = false;
  hangGen = 0;
  const hung = mod.writeChunkedValueVersioned(PREFIX, JSON.stringify(['stale']), {
    shouldCommit: () => !abandoned,
  });
  await atGate;
  hangGen = null;
  // Wrap the ring with more mutations than it has slots.
  for (let i = 0; i < 10; i++) {
    await mod.writeChunkedValueVersioned(PREFIX, JSON.stringify([`v${i}`]));
  }
  const current = JSON.parse(store.get(`${PREFIX}_ptr`));
  assert.notEqual(current.g, 0, 'the pointer must not name a generation still in flight');

  abandoned = true;
  release();
  assert.equal(await hung, false, 'an abandoned write must not publish');
  // The late chunk write landed on its OWN reserved slot, so the generation the
  // live pointer names was never touched. Without the reservation, one of the
  // ten wrapping writes would have taken generation 0 and this would read
  // '["stale"]'.
  assert.equal(await mod.readChunkedValueVersioned(PREFIX), JSON.stringify(['v9']));
});

test('setActive refuses to publish over an unreadable list', async () => {
  const store = new Map();
  let failReads = false;
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failReads) throw new Error('keystore exploded');
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  const prior = 'dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await s.setActive(prior, 'slot-prior', '2026-09-04T09:00:00.000Z', 'expo');

  // A new capture begins while the store cannot be read.
  failReads = true;
  await s.setActive('dr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'slot-new', '2026-09-04T10:00:00.000Z', 'expo');
  failReads = false;

  const ids = (await s.list()).map((e) => e.recordingId);
  assert.deepEqual(ids, [prior], 'a prior-process pointer must survive an unreadable read');
});

test('both mutation paths read strictly', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  assert.equal(
    (src.match(/await readListStrict\(userId\)/g) ?? []).length,
    5,
    'setActive + both clears + replaceActive + prune',
  );
  assert.doesNotMatch(src, /const existing = await readList\(userId\);/);
});

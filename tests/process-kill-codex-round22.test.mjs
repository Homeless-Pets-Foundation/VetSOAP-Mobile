/**
 * Codex review round 22 on PR #204 (P2): a clear that publishes nothing cannot
 * beat a late write.
 *
 * `shouldCommit` is checked BEFORE the `_ptr` write is issued, not after, so a
 * setActive abandoned by the 5s mutation deadline can still have its pointer
 * write in flight. The store then reads empty, and the clear's
 * `next.length !== list.length` check skipped the write entirely — leaving the
 * late write as the ONLY publication, so the next launch reported a cleanly
 * finished recording as interrupted.
 *
 * The round-10 test missed this because it seeds an existing pointer, which
 * forces the clear to publish.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('a clear publishes even when the snapshot looks empty', async (t) => {
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
        // Stall only the publish: the chunks land, the pointer hangs.
        if (gatePtr && k.endsWith('_ptr')) { await gate; }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');

  // The FIRST write of this prefix stalls, so the store still reads empty.
  gatePtr = true;
  await s.setActive('live', 'slot-live', '2026-09-04T09:00:00.000Z', 'expo');
  gatePtr = false;

  // A normal Finish. The snapshot has no 'live' entry to remove.
  await s.clearActive('live');

  // The abandoned publish finally lands.
  release();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 40));

  const list = await s.list();
  assert.ok(
    !list.some((e) => e.recordingId === 'live'),
    'a finished recording must not be resurrected by the stalled write',
  );
});

test('both clears publish unconditionally', () => {
  const src = read('src/lib/durableAudio/activeStore.ts');
  const body = src.slice(src.indexOf('clearActive(recordingId'), src.indexOf('replaceActive('));
  assert.ok(body.length > 0, 'anchor');
  assert.doesNotMatch(
    body,
    /if \(next\.length !== list\.length\) \{/,
    'the length check is what skipped the publish',
  );
  assert.equal((body.match(/await writeList\(userId, next, \(\) => !isAbandoned\(\)\);/g) ?? []).length, 2);
});

test('the prune keeps its conditional write, deliberately', () => {
  // Opposite reasoning: at launch a late setActive describes a CURRENT capture
  // (startedAt >= cutoff), which must not be pruned — so there is nothing to
  // contend with and an unconditional write would only add a Keystore round
  // trip to every start.
  const src = read('src/lib/durableAudio/activeStore.ts');
  const prune = src.slice(src.indexOf('pruneStartedBefore(userId: string'));
  assert.match(prune.slice(0, 900), /if \(next\.length !== list\.length\) \{/);
});

test('an unreadable store is never published over as empty', async () => {
  // The counterweight to publishing unconditionally. Both cases READ as empty:
  // a genuinely empty store (publish, or a late write wins) and a failed
  // Keystore read (publish and you destroy live pointers). Only a strict read
  // separates them, so the clears use one.
  const store = new Map();
  let failReads = false;
  const secure = {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(k) {
      if (failReads) throw new Error('keystore exploded');
      return store.has(k) ? store.get(k) : null;
    },
    async setItemAsync(k, v) { store.set(k, v); },
    async deleteItemAsync(k) { store.delete(k); },
  };
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', { 'expo-secure-store': secure });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  const a = 'dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await s.setActive(a, 'slot-a', '2026-09-04T09:00:00.000Z', 'expo');

  failReads = true;
  await s.clearActive('dr-something-else');
  failReads = false;

  const ids = (await s.list()).map((e) => e.recordingId);
  assert.deepEqual(ids, [a], 'a failed read must not wipe a live pointer');
});

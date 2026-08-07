import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

function makeSecureStoreMock() {
  const store = new Map();
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
    __store: store,
  };
}

async function loadTombstone() {
  const secureMock = makeSecureStoreMock();
  const mod = await loadTsModule('src/lib/durableAudio/tombstone.ts', {
    'expo-secure-store': secureMock,
  });
  return { mod, secureMock };
}

test('add/has/remove round-trip under a user scope', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec1'), false);
  await durableTombstone.add('rec1');
  await durableTombstone.add('rec2');
  assert.equal(await durableTombstone.has('rec1'), true);
  assert.equal(await durableTombstone.has('rec2'), true);
  await durableTombstone.remove('rec1');
  assert.equal(await durableTombstone.has('rec1'), false);
  assert.equal(await durableTombstone.has('rec2'), true);
});

test('no-op without a user scope (Rule 13)', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId(null);
  await durableTombstone.add('rec1');
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec1'), false);
});

test('rejects path-traversal recordingIds', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  await durableTombstone.add('../evil');
  assert.equal((await durableTombstone.list()).length, 0);
});

test('dedupes repeated adds', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');
  await durableTombstone.add('rec1');
  assert.equal((await durableTombstone.list()).length, 1);
});

test('FIFO-caps at MAX_TOMBSTONES, dropping oldest', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone, MAX_TOMBSTONES } = mod;
  durableTombstone.setUserId('user1');
  for (let i = 0; i < MAX_TOMBSTONES + 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await durableTombstone.add(`rec${i}`);
  }
  const list = await durableTombstone.list();
  assert.equal(list.length, MAX_TOMBSTONES);
  assert.equal(await durableTombstone.has('rec0'), false); // oldest dropped
  assert.equal(await durableTombstone.has(`rec${MAX_TOMBSTONES + 4}`), true);
});

test('user-scoped: user2 cannot read user1 tombstones', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');
  durableTombstone.setUserId('user2');
  assert.equal(await durableTombstone.has('rec1'), false);
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec1'), true);
});

test('prune keeps only still-referenced entries', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  await durableTombstone.add('keep');
  await durableTombstone.add('drop');
  await durableTombstone.prune(async (id) => id === 'keep');
  assert.equal(await durableTombstone.has('keep'), true);
  assert.equal(await durableTombstone.has('drop'), false);
});

test('chunked storage round-trips a value larger than 2KB', async () => {
  const { mod } = await loadTombstone();
  const { durableTombstone } = mod;
  durableTombstone.setUserId('user1');
  // ~100 ids * ~12 chars JSON each > 2KB single-key limit -> exercises chunking.
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop
    await durableTombstone.add(`recording-${i}`);
  }
  assert.equal((await durableTombstone.list()).length, 100);
  assert.equal(await durableTombstone.has('recording-50'), true);
});

// --- write-failure semantics (Codex round 4) ---------------------------------
// `writeChunkedValue` reports a rejected write by resolving false rather than
// throwing. Ignoring that result cached a list storage never took: `add()`
// claimed success, `has()` answered from the phantom entry instead of retrying
// storage, and after the next launch the tombstone was simply gone — letting
// `cleanupOrphaned` delete an already-uploaded server row.

/** SecureStore double whose writes can be switched to failing mid-test. */
function makeFaultyStore() {
  const store = new Map();
  const state = { failWrites: false };
  return {
    mock: {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async setItemAsync(key, value) {
        if (state.failWrites) throw new Error('keystore write unavailable');
        store.set(key, value);
      },
      async deleteItemAsync(key) {
        store.delete(key);
      },
    },
    state,
    store,
  };
}

async function loadFaultyTombstone() {
  const { mock, state, store } = makeFaultyStore();
  const mod = await loadTsModule('src/lib/durableAudio/tombstone.ts', {
    'expo-secure-store': mock,
  });
  return { durableTombstone: mod.durableTombstone, state, store };
}

test('add reports failure and caches nothing when the write is rejected', async () => {
  const { durableTombstone, state } = await loadFaultyTombstone();
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.add('kept-recording'), true);

  state.failWrites = true;
  assert.equal(
    await durableTombstone.add('rejected-recording'),
    false,
    'a mutation storage refused must not report success'
  );

  // The phantom entry must not be served from memory, and the entry that DID
  // persist must survive the failed rewrite.
  assert.equal(await durableTombstone.has('rejected-recording'), false);
  assert.equal(await durableTombstone.has('kept-recording'), true);
  assert.deepEqual([...(await durableTombstone.list())], ['kept-recording']);

  // Once storage recovers the retry lands, proving the cache was not poisoned.
  state.failWrites = false;
  assert.equal(await durableTombstone.add('rejected-recording'), true);
  assert.equal(await durableTombstone.has('rejected-recording'), true);
});

test('a rejected write leaves the previously persisted list intact on disk', async () => {
  const { durableTombstone, state, store } = await loadFaultyTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec-a');
  await durableTombstone.add('rec-b');
  const before = new Map(store);

  state.failWrites = true;
  await durableTombstone.add('rec-c');
  assert.deepEqual([...store.entries()], [...before.entries()], 'storage is untouched');
});

test('remove and prune report failure when the rewrite is rejected', async () => {
  const { durableTombstone, state } = await loadFaultyTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec-a');
  await durableTombstone.add('rec-b');

  state.failWrites = true;
  assert.equal(await durableTombstone.remove('rec-a'), false);
  assert.equal(await durableTombstone.prune(async () => false), false);

  // Nothing was dropped from the durable list by either refused rewrite.
  state.failWrites = false;
  assert.deepEqual([...(await durableTombstone.list())], ['rec-a', 'rec-b']);
});

test('remove and prune report success when there is nothing to change', async () => {
  const { durableTombstone } = await loadFaultyTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec-a');
  assert.equal(await durableTombstone.remove('not-present'), true);
  assert.equal(await durableTombstone.prune(async () => true), true);
  assert.deepEqual([...(await durableTombstone.list())], ['rec-a']);
});

test('the self-heal call sites surface a refused tombstone instead of swallowing it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(
    fileURLToPath(new URL('../src/lib/durableAudio/durableRecovery.ts', import.meta.url)),
    'utf8'
  );

  // `add()` fails closed, so a discarded result silently drops the guard that
  // stops cleanupOrphaned deleting an already-uploaded server row.
  assert.doesNotMatch(src, /durableTombstone\.add\([^)]*\)\.catch\(\(\) => \{\}\)/);
  assert.match(src, /await tombstoneOrReport\(recordingId, 'draft_unverified'\)/);
  assert.match(src, /await tombstoneOrReport\(recordingId, 'post_purge'\)/);
  // Retried once, then reported — the post-purge site cannot self-heal on the
  // next launch because its manifest is already gone.
  assert.match(src, /if \(!ok\) ok = await durableTombstone\.add\(recordingId\)\.catch\(\(\) => false\)/);
  assert.match(src, /captureMessage\('durable_tombstone_write_failed', 'warning'/);
  // The rate-limit channel key must stay coarse (no per-recording dimension).
  assert.doesNotMatch(src, /durable_tombstone_write_failed[\s\S]{0,200}recording_id/);
});

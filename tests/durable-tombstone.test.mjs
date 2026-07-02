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

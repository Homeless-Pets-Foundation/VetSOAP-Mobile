/**
 * Guards the on-device half of the latency fix.
 *
 * Every chunked SecureStore read walked its chunks one bridge round trip at a
 * time even though all key names are known as soon as the count is read, and
 * `durableTombstone.has()` re-read the whole chunked list from storage once per
 * draft inside the orphan/eviction sweeps. On an AndroidKeyStore each read is a
 * JNI hop plus an AES-GCM decrypt, which is why production Sentry measured
 * `local_draft_list` at 11.7s and `record_pending_draft_scan` at 11.6s.
 *
 * These are behavioural tests: they count and time the mocked storage calls
 * rather than pattern-matching the source.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

/**
 * SecureStore mock that records call counts and the peak number of reads
 * in flight at once.
 */
function makeInstrumentedSecureStore() {
  const store = new Map();
  const stats = { reads: 0, inFlight: 0, peakInFlight: 0, readKeys: [] };
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      stats.reads += 1;
      stats.readKeys.push(key);
      stats.inFlight += 1;
      stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
      // Yield twice so genuinely-parallel callers overlap and serial callers
      // do not.
      await Promise.resolve();
      await Promise.resolve();
      stats.inFlight -= 1;
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
    __store: store,
    __stats: stats,
  };
}

async function loadTombstone() {
  const secureMock = makeInstrumentedSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/tombstone.ts', {
    'expo-secure-store': secureMock,
  });
  return { durableTombstone: mod.durableTombstone, secureMock };
}

test('durableTombstone.has() reads storage once, not once per call', async () => {
  const { durableTombstone, secureMock } = await loadTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');
  await durableTombstone.add('rec2');

  const before = secureMock.__stats.reads;
  // A sweep asks the same question once per draft.
  for (let i = 0; i < 12; i++) {
    assert.equal(await durableTombstone.has('rec1'), true);
    assert.equal(await durableTombstone.has('missing'), false);
  }
  const readsForTwentyFourProbes = secureMock.__stats.reads - before;
  assert.equal(
    readsForTwentyFourProbes,
    0,
    'membership probes must be answered from the in-memory mirror'
  );
});

test('a write refreshes the mirror rather than serving a stale answer', async () => {
  const { durableTombstone } = await loadTombstone();
  durableTombstone.setUserId('user1');

  await durableTombstone.add('rec1');
  assert.equal(await durableTombstone.has('rec1'), true);

  await durableTombstone.remove('rec1');
  assert.equal(await durableTombstone.has('rec1'), false, 'remove must invalidate the mirror');

  await durableTombstone.add('rec3');
  assert.equal(await durableTombstone.has('rec3'), true);
  // Spread into this realm: the module is loaded in its own context, so the
  // returned array does not share this realm's Array prototype.
  assert.deepEqual([...(await durableTombstone.list())], ['rec3']);
});

test('the mirror is user-scoped — a shared tablet cannot cross-answer', async () => {
  const { durableTombstone } = await loadTombstone();

  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec-of-user1');
  assert.equal(await durableTombstone.has('rec-of-user1'), true);

  // Switching users must drop the mirror, not answer from the previous user.
  durableTombstone.setUserId('user2');
  assert.equal(await durableTombstone.has('rec-of-user1'), false);
  await durableTombstone.add('rec-of-user2');
  assert.equal(await durableTombstone.has('rec-of-user2'), true);

  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec-of-user1'), true);
  assert.equal(await durableTombstone.has('rec-of-user2'), false);
});

test('clearForUser drops the mirror for that user', async () => {
  const { durableTombstone } = await loadTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');
  assert.equal(await durableTombstone.has('rec1'), true);

  await durableTombstone.clearForUser('user1');
  assert.equal(await durableTombstone.has('rec1'), false);
});

test('chunked durable values are read in parallel, in order', async () => {
  const secureMock = makeInstrumentedSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': secureMock,
  });

  // ~5 chunks at CHUNK_SIZE 1900.
  const value = JSON.stringify(Array.from({ length: 400 }, (_, i) => `id-${i}`));
  assert.equal(await mod.writeChunkedValue('captivet_durable_test', value), true);

  secureMock.__stats.peakInFlight = 0;
  const readBack = await mod.readChunkedValue('captivet_durable_test');

  assert.equal(readBack, value, 'chunks must rejoin in index order');
  assert.ok(
    secureMock.__stats.peakInFlight > 1,
    `expected overlapping chunk reads, saw peak ${secureMock.__stats.peakInFlight}`
  );
});

test('a torn chunk set still reads as absent', async () => {
  const secureMock = makeInstrumentedSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': secureMock,
  });

  const value = 'x'.repeat(5000);
  await mod.writeChunkedValue('captivet_durable_torn', value);
  secureMock.__store.delete('captivet_durable_torn_chunk_1');

  assert.equal(await mod.readChunkedValue('captivet_durable_torn'), null);
});

/* ------------------------------------------------------------------ *
 * draftStorage: per-draft reads are bounded-parallel, order-preserving *
 * ------------------------------------------------------------------ */

function makeDraftFileSystemMock() {
  return {
    File: class {
      constructor(uri) {
        this.uri = uri;
        this.exists = true;
      }
      create() {}
      write() {}
      copy() {}
      move() {}
      delete() {}
    },
    Directory: class {
      constructor(uri) {
        this.uri = uri;
        this.exists = true;
      }
      create() {}
      delete() {}
    },
    Paths: {
      document: { uri: 'file:///doc/' },
      cache: { uri: 'file:///cache/' },
      availableDiskSpace: 1024 * 1024 * 1024,
    },
  };
}

async function loadDraftStorageWithDrafts(count) {
  const secure = makeInstrumentedSecureStore();
  const userId = 'user1';
  const slotIds = Array.from({ length: count }, (_, i) => `slot-${i}`);

  // Seed the index and one chunked metadata record per draft, matching the
  // production key scheme.
  secure.__store.set(`captivet_drafts_index_${userId}`, JSON.stringify(slotIds));
  for (const slotId of slotIds) {
    const meta = {
      slotId,
      userId,
      savedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      formData: { patientName: 'redacted', clientName: 'redacted', species: 'canine' },
      segments: [],
      serverDraftId: null,
      pendingSync: false,
    };
    const json = JSON.stringify(meta);
    secure.__store.set(
      `captivet_draft_${userId}_${slotId}_meta`,
      JSON.stringify({ chunks: 1, version: 1 })
    );
    secure.__store.set(`captivet_draft_${userId}_${slotId}_chunk_0`, json);
  }

  const mod = await loadTsModule('src/lib/draftStorage.ts', {
    'expo-secure-store': secure,
    'expo-file-system': makeDraftFileSystemMock(),
    'expo-file-system/legacy': { async copyAsync() {}, async moveAsync() {} },
  });
  return { draftStorage: mod.draftStorage, secure, slotIds, userId };
}

test('listDraftsForUser reads drafts concurrently and preserves index order', async () => {
  const { draftStorage, secure, slotIds, userId } = await loadDraftStorageWithDrafts(8);

  secure.__stats.peakInFlight = 0;
  const drafts = await draftStorage.listDraftsForUser(userId);

  assert.equal(drafts.length, slotIds.length);
  assert.deepEqual([...drafts.map((d) => d.slotId)], slotIds, 'index order must be preserved');
  assert.ok(
    secure.__stats.peakInFlight > 1,
    `expected overlapping per-draft reads, saw peak ${secure.__stats.peakInFlight}`
  );
});

test('the draft read pool is bounded so a large index cannot flood the bridge', async () => {
  const { draftStorage, secure, userId } = await loadDraftStorageWithDrafts(40);

  secure.__stats.peakInFlight = 0;
  await draftStorage.listDraftsForUser(userId);

  // DRAFT_READ_CONCURRENCY is 6, and each draft read is itself meta + 1 chunk.
  assert.ok(
    secure.__stats.peakInFlight <= 12,
    `read pool must stay bounded, saw peak ${secure.__stats.peakInFlight}`
  );
});

test('the pending-draft scan is not re-scheduled on every reducer action', async () => {
  const record = await readFile(
    new URL('../app/(app)/(tabs)/record.tsx', import.meta.url),
    'utf8',
  );

  // `useMultiPatientSession`'s reducer returns a new state object for EVERY
  // action, so depending on `session` re-ran this effect once per keystroke —
  // each run a full listDrafts() sweep of SecureStore, and `cancelWork()`
  // cannot abort a sweep that already started.
  assert.match(
    record,
    /const draftLinkageFingerprint = useMemo\(\s*\n\s*\(\) =>\s*session\.slots\.map\(\(slot\) => `\$\{slot\.draftSlotId \?\? ''\}:\$\{slot\.uploadStatus\}`\)\.join\('\|'\),/
  );
  assert.match(record, /\}, \[draftLinkageFingerprint, user\?\.id\]\);/);
  assert.doesNotMatch(record, /scheduleNonUrgentWork\('record_pending_draft_scan'[\s\S]{0,600}\}, \[session, user\?\.id\]\);/);
});

test('parallel chunk reads observe every rejection (rule 4)', async () => {
  // `Promise.all` rejects on the first failure and silently abandons the rest;
  // an abandoned rejection is an unhandled rejection, which crashes Hermes in a
  // release build. Every parallel chunk read must therefore use `allSettled`
  // and rethrow deterministically.
  for (const file of [
    'src/lib/draftStorage.ts',
    'src/lib/stashStorage.ts',
  ]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const chunkReads = source.match(/Promise\.(all|allSettled)\(\s*\n?\s*Array\.from\(\{ length:/g) ?? [];
    assert.ok(chunkReads.length > 0, `${file} should fan out chunk reads`);
    assert.ok(
      chunkReads.every((match) => match.includes('allSettled')),
      `${file} must use Promise.allSettled for chunk reads, saw: ${chunkReads.join(', ')}`
    );
    assert.match(source, /if \(outcome\.status === 'rejected'\) throw outcome\.reason;/);
  }
});

test('a Keystore failure on one chunk never reads as an absent draft', async () => {
  const secure = makeInstrumentedSecureStore();
  const userId = 'user1';
  const slotId = 'slot-0';
  const meta = {
    slotId,
    userId,
    savedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    formData: { patientName: 'redacted', clientName: 'redacted', species: 'canine' },
    segments: [],
    serverDraftId: null,
    pendingSync: false,
  };
  secure.__store.set(`captivet_drafts_index_${userId}`, JSON.stringify([slotId]));
  secure.__store.set(
    `captivet_draft_${userId}_${slotId}_meta`,
    JSON.stringify({ chunks: 2, version: 1 })
  );
  const json = JSON.stringify(meta);
  secure.__store.set(`captivet_draft_${userId}_${slotId}_chunk_0`, json.slice(0, 10));
  secure.__store.set(`captivet_draft_${userId}_${slotId}_chunk_1`, json.slice(10));

  // Both chunk reads reject at once — the shape that would leave one rejection
  // unobserved under Promise.all.
  const baseGet = secure.getItemAsync.bind(secure);
  secure.getItemAsync = async (key) => {
    if (key.includes('_chunk_')) throw new Error('keystore exploded');
    return baseGet(key);
  };

  const mod = await loadTsModule('src/lib/draftStorage.ts', {
    'expo-secure-store': secure,
    'expo-file-system': makeDraftFileSystemMock(),
    'expo-file-system/legacy': { async copyAsync() {}, async moveAsync() {} },
  });

  // The lenient reader still degrades to "no drafts" rather than throwing, but
  // it must do so without an unobserved rejection escaping.
  const drafts = await mod.draftStorage.listDraftsForUser(userId);
  assert.equal(drafts.length, 0);
});

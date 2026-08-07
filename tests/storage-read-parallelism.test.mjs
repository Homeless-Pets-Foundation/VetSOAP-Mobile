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
  assert.match(record, /\}, \[draftLinkageFingerprint, draftStoreRevision, user\?\.id\]\);/);
  assert.doesNotMatch(record, /scheduleNonUrgentWork\('record_pending_draft_scan'[\s\S]{0,600}\}, \[session, user\?\.id\]\);/);

  // ...but a storage write this screen never dispatched MUST still re-run it.
  // `usePendingDraftSync` clears `pendingSync` from the app layout without
  // touching any slot, so without this subscription the "syncing to server…"
  // banner would stay on screen after the sync had already succeeded.
  assert.match(record, /draftStorage\.subscribeDraftChanges\(\(\) => \{\s*setDraftStoreRevision\(\(n\) => n \+ 1\);/);

  const storage = await readFile(new URL('../src/lib/draftStorage.ts', import.meta.url), 'utf8');
  assert.match(storage, /subscribeDraftChanges\(listener: \(\) => void\): \(\) => void \{/);
  // Fired from the single choke point every write already goes through.
  assert.match(
    storage,
    /function invalidateDraftsCache\(\): void \{[\s\S]*?for \(const listener of draftChangeListeners\) \{/
  );
  // A listener must never break a storage write.
  assert.match(storage, /listener\(\);\s*\} catch \{/);
});

test('chunk fan-out is centralised, windowed and rejection-observing (rule 4)', async () => {
  // `Promise.all` rejects on the first failure and silently abandons the rest;
  // an abandoned rejection is an unhandled rejection, which crashes Hermes in a
  // release build. And an unbounded `Array.from({ length: count })` would let a
  // corrupt persisted count dispatch an arbitrary number of native calls before
  // discovering the first gap. Both concerns live in one place now.
  const reader = await readFile(new URL('../src/lib/chunkedRead.ts', import.meta.url), 'utf8');
  assert.match(reader, /export const MAX_CHUNKS_PER_VALUE = 512;/);
  assert.match(reader, /export const CHUNK_READ_WINDOW = 8;/);
  assert.match(reader, /Promise\.allSettled\(/);
  assert.match(reader, /if \(outcome\.status === 'rejected'\) throw outcome\.reason;/);
  assert.match(reader, /if \(outcome\.value === null\) return \{ ok: false, reason: 'torn' \};/);
  assert.match(reader, /count > maxChunks/);

  // No storage module may hand-roll its own unbounded fan-out again.
  for (const file of [
    'src/lib/draftStorage.ts',
    'src/lib/stashStorage.ts',
    'src/lib/durableAudio/chunkedStore.ts',
  ]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /readChunksBounded\(/, `${file} must delegate chunk reads`);
    assert.doesNotMatch(
      source,
      /Promise\.(all|allSettled)\(\s*\n?\s*Array\.from\(\{ length: count/,
      `${file} must not fan out chunk reads directly`
    );
  }
});

test('readChunksBounded stops at the first gap and rejects an implausible count', async () => {
  const mod = await loadTsModule('src/lib/chunkedRead.ts', {});
  const { readChunksBounded, MAX_CHUNKS_PER_VALUE } = mod;

  // Happy path: parts come back in index order.
  const ok = await readChunksBounded(5, async (i) => `p${i}`);
  assert.equal(ok.ok, true);
  assert.equal(ok.parts.join(''), 'p0p1p2p3p4');

  // A corrupt count must be rejected WITHOUT dispatching a single read — this is
  // the OOM guard. `parseStrictChunkCount` alone allows up to 999,999.
  let reads = 0;
  const tooLarge = await readChunksBounded(999_999, async (i) => {
    reads += 1;
    return `p${i}`;
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.reason, 'count_too_large');
  assert.equal(reads, 0, 'an implausible count must not dispatch any read');
  assert.equal((await readChunksBounded(MAX_CHUNKS_PER_VALUE + 1, async () => 'x')).ok, false);

  // Early exit: a gap at index 3 must stop the walk, not read all 400 chunks.
  reads = 0;
  const torn = await readChunksBounded(400, async (i) => {
    reads += 1;
    return i === 3 ? null : `p${i}`;
  });
  assert.equal(torn.ok, false);
  assert.equal(torn.reason, 'torn');
  assert.ok(reads <= 8, `must stop within one window, dispatched ${reads}`);

  // Concurrency stays bounded, and every rejection in a window is observed.
  let inFlight = 0;
  let peak = 0;
  const settledOk = await readChunksBounded(64, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return `p${i}`;
  });
  assert.equal(settledOk.ok, true);
  assert.ok(peak > 1 && peak <= 8, `window must bound concurrency, peak ${peak}`);

  await assert.rejects(
    () => readChunksBounded(4, async () => { throw new Error('keystore exploded'); }),
    /keystore exploded/
  );
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

test('an unreadable tombstone list is never cached as empty', async () => {
  // The tombstone is the guard that stops `cleanupOrphaned` deleting a
  // just-uploaded server row. Caching an unproven `[]` would make `has()` answer
  // "not uploaded" forever and let the next `add()` overwrite the real list.
  const { durableTombstone, secureMock } = await loadTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');
  await durableTombstone.add('rec2');
  assert.equal(await durableTombstone.has('rec1'), true);

  // Simulate a Keystore failure on the chunk reads: the count key still reads,
  // the chunks do not, so `readChunkedValue` returns null (torn).
  const baseGet = secureMock.getItemAsync.bind(secureMock);
  secureMock.getItemAsync = async (key) => (key.includes('_chunk_') ? null : baseGet(key));

  // Drop the mirror the way a user switch would, so the next read must hit
  // storage and observe the torn state.
  durableTombstone.setUserId(null);
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec1'), false, 'torn read degrades to empty');

  // ...but it must NOT have been cached. Once storage recovers the real list
  // comes back rather than a stuck empty answer.
  secureMock.getItemAsync = baseGet;
  assert.equal(await durableTombstone.has('rec1'), true, 'must retry storage after recovery');
  assert.equal(await durableTombstone.has('rec2'), true);
});

test('a corrupt tombstone payload is never cached as empty', async () => {
  const { durableTombstone, secureMock } = await loadTombstone();
  durableTombstone.setUserId('user1');
  await durableTombstone.add('rec1');

  // Corrupt the stored payload, then force a cold read.
  const chunkKey = [...secureMock.__store.keys()].find((k) => k.includes('_chunk_0'));
  const good = secureMock.__store.get(chunkKey);
  secureMock.__store.set(chunkKey, '{not json');
  durableTombstone.setUserId(null);
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.has('rec1'), false);

  secureMock.__store.set(chunkKey, good);
  assert.equal(await durableTombstone.has('rec1'), true, 'must retry after the payload is readable');
});

test('tombstone mutations fail closed when the existing list is unreadable', async () => {
  // Every write is a whole-list rewrite. Building one on an unproven-empty read
  // would erase up to MAX_TOMBSTONES confirmed-uploaded recordings because of a
  // single transient Keystore fault — and each erased entry is a recording
  // `cleanupOrphaned` could then destroy locally. Skipping ONE tombstone is
  // strictly less harmful than erasing every other one.
  const { durableTombstone, secureMock } = await loadTombstone();
  durableTombstone.setUserId('user1');
  assert.equal(await durableTombstone.add('rec1'), true);
  assert.equal(await durableTombstone.add('rec2'), true);

  // Make the chunk reads throw the way a Keystore failure does, and drop the
  // mirror so the next load must hit storage.
  const baseGet = secureMock.getItemAsync.bind(secureMock);
  secureMock.getItemAsync = async (key) => {
    if (key.includes('_chunk_')) throw new Error('keystore exploded');
    return baseGet(key);
  };
  durableTombstone.setUserId(null);
  durableTombstone.setUserId('user1');

  assert.equal(await durableTombstone.add('rec3'), false, 'add must refuse to write');
  await durableTombstone.remove('rec1');
  await durableTombstone.prune(async () => false);

  // Storage recovers: the original entries must still be there, and rec3 must
  // NOT have replaced them.
  secureMock.getItemAsync = baseGet;
  durableTombstone.setUserId(null);
  durableTombstone.setUserId('user1');
  const survived = [...(await durableTombstone.list())];
  assert.deepEqual(survived, ['rec1', 'rec2'], 'no mutation may land on an unreadable list');
  assert.equal(await durableTombstone.has('rec1'), true);
  assert.equal(await durableTombstone.has('rec3'), false);
});

test('a proven-absent tombstone list is still writable and cacheable', async () => {
  // Absence must stay distinguishable from unavailability in the OTHER
  // direction too: a first-ever tombstone must not be blocked by the guard.
  const { durableTombstone, secureMock } = await loadTombstone();
  durableTombstone.setUserId('fresh-user');

  assert.equal(await durableTombstone.has('rec1'), false);
  assert.equal(await durableTombstone.add('rec1'), true, 'first write must succeed');
  assert.equal(await durableTombstone.has('rec1'), true);

  // And the proven-absent read is cached, so an empty list costs nothing extra.
  durableTombstone.setUserId('another-fresh-user');
  const before = secureMock.__stats.reads;
  for (let i = 0; i < 5; i++) assert.equal(await durableTombstone.has('nope'), false);
  assert.ok(
    secureMock.__stats.reads - before <= 1,
    'proven absence must be cached, not re-read per probe'
  );
});

test('readChunkedValueStrict separates absence from unavailability', async () => {
  const secureMock = makeInstrumentedSecureStore();
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': secureMock,
  });

  assert.deepEqual(
    { ...(await mod.readChunkedValueStrict('captivet_durable_missing')) },
    { status: 'absent' },
    'no count pointer is the one situation that proves absence'
  );

  await mod.writeChunkedValue('captivet_durable_v', 'x'.repeat(5000));
  const ok = await mod.readChunkedValueStrict('captivet_durable_v');
  assert.equal(ok.status, 'value');
  assert.equal(ok.value, 'x'.repeat(5000));

  // Torn set: a chunk key existed, we just cannot read the whole value.
  secureMock.__store.delete('captivet_durable_v_chunk_1');
  assert.equal((await mod.readChunkedValueStrict('captivet_durable_v')).status, 'unavailable');

  // Corrupt count pointer.
  secureMock.__store.set('captivet_durable_bad_count', 'not-a-number');
  assert.equal((await mod.readChunkedValueStrict('captivet_durable_bad')).status, 'unavailable');
});

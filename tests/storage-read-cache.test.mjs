import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

// In-memory read caches for draftStorage.listDrafts() / stashStorage reads.
// The safety property under test: the cache is keyed by userId, so on shared
// clinic tablets a wrong-user hit is structurally impossible — including while
// syncPending temporarily rebinds currentUserId without going through
// setUserId. Plus: every write invalidates, and reads after a write see fresh
// data, never a stale cache entry.

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

/** Shared in-memory SecureStore double with read/write counters. */
function makeSecureStore(state = new Map()) {
  const counters = { reads: 0, writes: 0, deletes: 0 };
  const mock = {
    AFTER_FIRST_UNLOCK: 'after_first_unlock',
    async getItemAsync(key) {
      counters.reads++;
      return state.has(key) ? state.get(key) : null;
    },
    async setItemAsync(key, value) {
      counters.writes++;
      state.set(key, value);
    },
    async deleteItemAsync(key) {
      counters.deletes++;
      state.delete(key);
    },
  };
  return { state, counters, mock };
}

async function loadTsModuleWithMocks(path, mocks) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const module = { exports: {} };
  const requireShim = (id) => {
    if (id in mocks) return mocks[id];
    // Lazy analytics/monitoring requires sit inside try/catch in the module —
    // throwing here exercises their swallow paths.
    throw new Error(`module not mocked in test: ${id}`);
  };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireShim,
    Error,
    TypeError,
    RangeError,
    Promise,
    setTimeout,
    clearTimeout,
    console,
  });
  return module.exports;
}

// ─── stashStorage ────────────────────────────────────────────────────

async function loadStashStorage(state) {
  const store = makeSecureStore(state);
  const mod = await loadTsModuleWithMocks('src/lib/stashStorage.ts', {
    'expo-secure-store': store.mock,
  });
  return { stashStorage: mod.stashStorage, ...store };
}

function makeSession(id) {
  return {
    id,
    stashedAt: new Date(0).toISOString(),
    slots: [{ id: `${id}-slot`, segments: [] }],
  };
}

test('stashStorage: save write-through makes the next read SecureStore-free', async () => {
  const { stashStorage, counters } = await loadStashStorage();
  stashStorage.setUserId('userA');

  assert.equal(await stashStorage.saveStashedSessions([makeSession('s1')]), true);

  const readsAfterSave = counters.reads;
  const sessions = await stashStorage.getStashedSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 's1');
  assert.equal(counters.reads, readsAfterSave, 'cached read must not touch SecureStore');
});

test('stashStorage: cold read populates the cache; repeat reads are free', async () => {
  const { stashStorage: writer, state } = await loadStashStorage();
  writer.setUserId('userA');
  await writer.saveStashedSessions([makeSession('s1'), makeSession('s2')]);

  // Fresh module instance over the same backing store = cold cache.
  const { stashStorage, counters } = await loadStashStorage(state);
  stashStorage.setUserId('userA');

  const first = await stashStorage.getStashedSessions();
  assert.equal(first.length, 2);
  const readsAfterFirst = counters.reads;
  assert.ok(readsAfterFirst > 0, 'cold read must hit SecureStore');

  const second = await stashStorage.getStashedSessions();
  assert.equal(second.length, 2);
  assert.equal(counters.reads, readsAfterFirst, 'warm read must not touch SecureStore');
});

test('stashStorage: cache never leaks across users on a shared tablet', async () => {
  const { stashStorage } = await loadStashStorage();

  stashStorage.setUserId('userA');
  await stashStorage.saveStashedSessions([makeSession('a-session')]);
  assert.equal((await stashStorage.getStashedSessions()).length, 1);

  stashStorage.setUserId('userB');
  assert.equal((await stashStorage.getStashedSessions()).length, 0, 'user B must never see user A sessions');

  stashStorage.setUserId('userA');
  const back = await stashStorage.getStashedSessions();
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 'a-session');
});

test('stashStorage: a write after a cached read is visible on the next read', async () => {
  const { stashStorage } = await loadStashStorage();
  stashStorage.setUserId('userA');

  await stashStorage.saveStashedSessions([makeSession('s1')]);
  assert.equal((await stashStorage.getStashedSessions()).length, 1);

  await stashStorage.addStashedSession(makeSession('s2'));
  assert.equal((await stashStorage.getStashedSessions()).length, 2);

  await stashStorage.removeStashedSession('s1');
  const after = await stashStorage.getStashedSessions();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 's2');
});

test('stashStorage: clearAllStashes invalidates the cache', async () => {
  const { stashStorage } = await loadStashStorage();
  stashStorage.setUserId('userA');

  await stashStorage.saveStashedSessions([makeSession('s1')]);
  assert.equal((await stashStorage.getStashedSessions()).length, 1);

  await stashStorage.clearAllStashes();
  assert.equal((await stashStorage.getStashedSessions()).length, 0);
});

test('stashStorage: cached reads hand out fresh objects, not shared references', async () => {
  const { stashStorage } = await loadStashStorage();
  stashStorage.setUserId('userA');
  await stashStorage.saveStashedSessions([makeSession('s1')]);

  const first = await stashStorage.getStashedSessions();
  first[0].id = 'MUTATED';
  const second = await stashStorage.getStashedSessions();
  assert.equal(second[0].id, 's1', 'caller mutation must not poison the cache');
});

// ─── draftStorage ────────────────────────────────────────────────────

async function loadDraftStorage(state, opts = {}) {
  const store = makeSecureStore(state);
  const fileSystemMock = {
    File: class {
      constructor(uri) {
        this.uri = uri;
      }
      copy() {}
      move() {}
    },
    Paths: {
      document: { uri: 'file:///doc/' },
      cache: { uri: 'file:///cache/' },
      availableDiskSpace: 1024 * 1024 * 1024,
    },
  };
  const mod = await loadTsModuleWithMocks('src/lib/draftStorage.ts', {
    'expo-secure-store': store.mock,
    'expo-file-system': fileSystemMock,
    'expo-file-system/legacy': {
      async copyAsync() {},
      async moveAsync() {},
    },
    './fileOps': {
      fileExists: opts.fileExists ?? (() => true),
      safeDeleteFile: () => {},
      safeDeleteDirectory: () => {},
      ensureDirectory: () => true,
    },
    './durableAudio/paths': {
      isValidDurableId: (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
    },
    './durableAudio/tombstone': {
      durableTombstone: { has: async () => false },
    },
    './pendingConfirm': {
      clonePendingConfirm: (value) => value ? structuredClone(value) : null,
    },
    './uploadIntent': {
      normalizeUploadIntentId: (value, slotId) => value || `legacy:${slotId}`,
    },
  });
  return { draftStorage: mod.draftStorage, ...store };
}

function makeSlot(id) {
  return {
    id,
    formData: { patientName: 'redacted' },
    segments: [{ uri: `file:///rec/${id}-seg0.m4a`, duration: 5 }],
  };
}

test('draftStorage: second listDrafts is served from cache with zero SecureStore reads', async () => {
  const { draftStorage, counters } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const first = await draftStorage.listDrafts();
  assert.equal(first.length, 1);
  const readsAfterFirst = counters.reads;

  const second = await draftStorage.listDrafts();
  assert.equal(second.length, 1);
  assert.equal(counters.reads, readsAfterFirst, 'warm listDrafts must not touch SecureStore');
});

test('draftStorage: audio edits clear stale confirmation hints and retain a rotated intent', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft({
    ...makeSlot('slot-intent'),
    uploadIntentId: 'intent-before-edit',
    pendingConfirm: { recordingId: 'old-recording', fileKey: 'old-key' },
  });
  await draftStorage.updateServerDraftId('slot-intent', 'server-before-edit');
  await draftStorage.saveDraft({
    ...makeSlot('slot-intent'),
    uploadIntentId: 'intent-after-start-over',
    pendingConfirm: null,
  });
  const saved = await draftStorage.getDraft('slot-intent');
  assert.equal(saved.pendingConfirm, null);
  assert.equal(saved.uploadIntentId, 'intent-after-start-over');
  assert.equal(saved.serverDraftId, null);
  assert.equal(saved.pendingSync, true);
});

test('draftStorage: orphan cleanup preserves missing audio with pending confirmation proof', async () => {
  let filesPresent = true;
  let serverDeletes = 0;
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: () => filesPresent,
  });
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-confirm-only'));
  await draftStorage.updatePendingConfirm('slot-confirm-only', {
    recordingId: '11111111-1111-4111-8111-111111111111',
    fileKey: 'recordings/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.m4a',
  }, '11111111-1111-4111-8111-111111111111');
  filesPresent = false;

  const cleaned = await draftStorage.cleanupOrphaned(async () => { serverDeletes++; });
  assert.equal(cleaned, 0);
  assert.equal(serverDeletes, 0);
  assert.ok(await draftStorage.getDraft('slot-confirm-only'));
});

test('draftStorage: proof-only save persists metadata when every segment copy is missing', async () => {
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: () => false,
  });
  draftStorage.setUserId('userA');
  const proof = {
    recordingId: '11111111-1111-4111-8111-111111111111',
    fileKey: 'recordings/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.m4a',
  };

  const saved = await draftStorage.saveDraft({
    ...makeSlot('slot-proof-save'),
    audioDuration: 5,
    serverDraftId: proof.recordingId,
    pendingConfirm: proof,
  });

  assert.equal(saved.promotedSegments.length, 0);
  const draft = await draftStorage.getDraft('slot-proof-save');
  assert.equal(draft.segments.length, 0);
  assert.equal(draft.audioDuration, 5);
  assert.equal(draft.pendingConfirm.recordingId, proof.recordingId);
});

test('draftStorage: every write path invalidates the cache', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');

  await draftStorage.saveDraft(makeSlot('slot1'));
  assert.equal((await draftStorage.listDrafts()).length, 1);

  // saveDraft of a second slot must surface on the next list.
  await draftStorage.saveDraft(makeSlot('slot2'));
  assert.equal((await draftStorage.listDrafts()).length, 2);

  // updateServerDraftId must surface on the next list.
  await draftStorage.updateServerDraftId('slot1', 'server-123');
  let drafts = await draftStorage.listDrafts();
  assert.equal(drafts.find((d) => d.slotId === 'slot1').serverDraftId, 'server-123');

  // clearServerDraftId must surface on the next list.
  await draftStorage.clearServerDraftId('slot1');
  drafts = await draftStorage.listDrafts();
  assert.equal(drafts.find((d) => d.slotId === 'slot1').serverDraftId, null);

  // deleteDraft must surface on the next list.
  await draftStorage.deleteDraft('slot1');
  drafts = await draftStorage.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].slotId, 'slot2');

  // clearAll must empty the next list.
  await draftStorage.clearAll();
  assert.equal((await draftStorage.listDrafts()).length, 0);
});

test('draftStorage: cache never leaks across users on a shared tablet', async () => {
  const { draftStorage } = await loadDraftStorage();

  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('aslot'));
  assert.equal((await draftStorage.listDrafts()).length, 1);

  draftStorage.setUserId('userB');
  assert.equal((await draftStorage.listDrafts()).length, 0, 'user B must never see user A drafts');

  draftStorage.setUserId('userA');
  const back = await draftStorage.listDrafts();
  assert.equal(back.length, 1);
  assert.equal(back[0].slotId, 'aslot');
});

test('draftStorage: explicit server-draft detach remains scoped after the active user changes', async () => {
  const { draftStorage } = await loadDraftStorage();

  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('aslot'));
  await draftStorage.updateServerDraftId('aslot', 'server-a');

  draftStorage.setUserId('userB');
  await draftStorage.saveDraft(makeSlot('bslot'));
  await draftStorage.updateServerDraftId('bslot', 'server-b');

  await draftStorage.clearServerDraftIdForUser('userA', 'aslot');

  const aDrafts = await draftStorage.listDraftsForUser('userA');
  const bDrafts = await draftStorage.listDraftsForUser('userB');
  assert.equal(aDrafts[0].serverDraftId, null);
  assert.equal(bDrafts[0].serverDraftId, 'server-b');
  assert.equal(draftStorage.getUserId(), 'userB');
});

test('draftStorage: syncPending for user A while scoped to user B cannot poison B\'s cache', async () => {
  const { draftStorage } = await loadDraftStorage();

  // User A has a pending-sync draft.
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('aslot'));

  // Now scoped to B with a warm (empty) cache.
  draftStorage.setUserId('userB');
  assert.equal((await draftStorage.listDrafts()).length, 0);

  // syncPending rebinds currentUserId to A internally WITHOUT setUserId.
  const result = await draftStorage.syncPending('userA', async () => ({ id: 'server-xyz' }));
  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);

  // B's view stays B's. A's draft got the server id.
  assert.equal((await draftStorage.listDrafts()).length, 0, 'B must not see A data after syncPending(A)');
  const aDrafts = await draftStorage.listDraftsForUser('userA');
  assert.equal(aDrafts.length, 1);
  assert.equal(aDrafts[0].serverDraftId, 'server-xyz');
  assert.equal(aDrafts[0].pendingSync, false);
});

test('draftStorage: syncPending reports partial failures and leaves failed drafts pending', async () => {
  const { draftStorage } = await loadDraftStorage();

  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));
  await draftStorage.saveDraft(makeSlot('slot2'));

  let createAttempt = 0;
  const result = await draftStorage.syncPending('userA', async () => {
    createAttempt++;
    if (createAttempt === 1) return { id: 'server-slot1' };
    throw new Error('network failed');
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);

  const drafts = await draftStorage.listDraftsForUser('userA');
  const slot1 = drafts.find((draft) => draft.slotId === 'slot1');
  const slot2 = drafts.find((draft) => draft.slotId === 'slot2');
  assert.ok(slot1);
  assert.ok(slot2);
  assert.equal(slot1.serverDraftId, 'server-slot1');
  assert.equal(slot1.pendingSync, false);
  assert.equal(slot2.serverDraftId, null);
  assert.equal(slot2.pendingSync, true);
});

test('draftStorage: cached reads hand out defensive clones', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const first = await draftStorage.listDrafts();
  first[0].slotId = 'MUTATED';
  first[0].formData.patientName = 'MUTATED';
  first[0].segments[0].uri = 'MUTATED';

  const second = await draftStorage.listDrafts();
  assert.equal(second[0].slotId, 'slot1');
  assert.equal(second[0].formData.patientName, 'redacted');
  // saveDraft copies segments into the draft dir, so the stored URI is the
  // durable dest path, not the recorder-temp source.
  assert.equal(second[0].segments[0].uri, 'file:///doc/drafts/userA/slot1/seg_0.m4a');
});

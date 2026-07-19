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
      safeDeleteFile: opts.safeDeleteFile ?? (() => {}),
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
      normalizeUploadKeyOverride: (value) => value || null,
      normalizeSupersededUploadKey: (value) => value || null,
      isAudioChangeUploadIdempotencyKey: (value) =>
        typeof value === 'string' &&
        value.startsWith('recording-upload-v3:audio-change:'),
      effectiveUploadIdempotencyKey: ({ uploadKeyOverride, durableRecordingId, uploadIntentId }) =>
        uploadKeyOverride ||
        (durableRecordingId
          ? `recording-upload-v1:durable:${durableRecordingId}`
          : `recording-upload-v1:slot:${uploadIntentId}`),
    },
    './pimsPatientIdIntent': {
      isPimsPatientIdExplicitlyCleared: (value, persistedIntent) =>
        persistedIntent === true || value === null,
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

test('draftStorage: unknown batch status preserves a server-linked orphan', async () => {
  let filesPresent = true;
  let serverDeletes = 0;
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: () => filesPresent,
  });
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-unknown-orphan'));
  await draftStorage.updateServerDraftId(
    'slot-unknown-orphan',
    '11111111-1111-4111-8111-111111111111',
  );
  filesPresent = false;

  const cleaned = await draftStorage.cleanupOrphaned(
    async () => {
      serverDeletes++;
    },
    { getStatus: async () => null, isOnline: true },
  );
  assert.equal(cleaned, 0);
  assert.equal(serverDeletes, 0);
  assert.ok(await draftStorage.getDraft('slot-unknown-orphan'));
});

test('draftStorage: proven missing server row removes orphan metadata without a delete call', async () => {
  let filesPresent = true;
  let serverDeletes = 0;
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: () => filesPresent,
  });
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-missing-orphan'));
  await draftStorage.updateServerDraftId(
    'slot-missing-orphan',
    '11111111-1111-4111-8111-111111111111',
  );
  filesPresent = false;

  const cleaned = await draftStorage.cleanupOrphaned(
    async () => {
      serverDeletes++;
    },
    { getStatus: async () => 'missing', isOnline: true },
  );
  assert.equal(cleaned, 1);
  assert.equal(serverDeletes, 0);
  assert.equal(await draftStorage.getDraft('slot-missing-orphan'), null);
});

test('draftStorage: missing and unknown status never silently evict local audio', async () => {
  for (const status of ['missing', null]) {
    const { draftStorage } = await loadDraftStorage();
    draftStorage.setUserId('userA');
    await draftStorage.saveDraft(makeSlot(`slot-evict-${status ?? 'unknown'}`));
    await draftStorage.updateServerDraftId(
      `slot-evict-${status ?? 'unknown'}`,
      '11111111-1111-4111-8111-111111111111',
    );

    const result = await draftStorage.evictExpired(
      { maxAgeDays: -1, warnAgeDays: -2, isOnline: true },
      async () => status,
    );
    assert.equal(result.expired.length, 1);
    assert.ok(await draftStorage.getDraft(`slot-evict-${status ?? 'unknown'}`));
  }
});

test('draftStorage: orphan cleanup stops without mutating either user after an A-to-B switch', async () => {
  let filesPresent = true;
  let serverDeletes = 0;
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: () => filesPresent,
  });
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-a-orphan'));
  await draftStorage.updateServerDraftId(
    'slot-a-orphan',
    '11111111-1111-4111-8111-111111111111',
  );
  draftStorage.setUserId('userB');
  await draftStorage.saveDraft(makeSlot('slot-b-safe'));
  draftStorage.setUserId('userA');
  filesPresent = false;

  const scopeVersion = draftStorage.getUserScopeVersion();
  const isScopeValid = () =>
    draftStorage.getUserId() === 'userA' &&
    draftStorage.getUserScopeVersion() === scopeVersion;
  const cleaned = await draftStorage.cleanupOrphaned(
    async () => {
      serverDeletes++;
    },
    {
      userId: 'userA',
      isOnline: true,
      isScopeValid,
      getStatus: async () => {
        draftStorage.setUserId('userB');
        return 'draft';
      },
    },
  );

  assert.equal(cleaned, 0);
  assert.equal(serverDeletes, 0);
  assert.ok((await draftStorage.listDraftsForUser('userA')).some(
    (draft) => draft.slotId === 'slot-a-orphan',
  ));
  assert.ok((await draftStorage.listDraftsForUser('userB')).some(
    (draft) => draft.slotId === 'slot-b-safe',
  ));
});

test('draftStorage: age eviction publishes nothing after an A-to-B switch', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-a-old'));
  await draftStorage.updateServerDraftId(
    'slot-a-old',
    '11111111-1111-4111-8111-111111111111',
  );
  draftStorage.setUserId('userB');
  await draftStorage.saveDraft(makeSlot('slot-b-safe'));
  draftStorage.setUserId('userA');

  const scopeVersion = draftStorage.getUserScopeVersion();
  const isScopeValid = () =>
    draftStorage.getUserId() === 'userA' &&
    draftStorage.getUserScopeVersion() === scopeVersion;
  const result = await draftStorage.evictExpired(
    {
      maxAgeDays: -1,
      warnAgeDays: -2,
      isOnline: true,
      userId: 'userA',
      isScopeValid,
    },
    async () => {
      draftStorage.setUserId('userB');
      throw new Error('auth scope changed');
    },
  );

  assert.equal(result.expired.length, 0);
  assert.equal(result.expiring.length, 0);
  assert.ok((await draftStorage.listDraftsForUser('userA')).some(
    (draft) => draft.slotId === 'slot-a-old',
  ));
  assert.ok((await draftStorage.listDraftsForUser('userB')).some(
    (draft) => draft.slotId === 'slot-b-safe',
  ));
});

test('draftStorage: explicit-user deletion cannot rewrite the active successor user index', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot-a-delete'));
  draftStorage.setUserId('userB');
  await draftStorage.saveDraft(makeSlot('slot-b-safe'));

  await draftStorage.deleteDraftForUser('userA', 'slot-a-delete');

  assert.equal((await draftStorage.listDraftsForUser('userA')).length, 0);
  assert.ok((await draftStorage.listDraftsForUser('userB')).some(
    (draft) => draft.slotId === 'slot-b-safe',
  ));
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

test('draftStorage: complete-audio save rejects partial copies without replacing prior metadata', async () => {
  let missingSource = null;
  const { draftStorage } = await loadDraftStorage(undefined, {
    fileExists: (uri) => uri !== missingSource,
  });
  draftStorage.setUserId('userA');
  const initial = {
    ...makeSlot('slot-complete-save'),
    segments: [
      { uri: 'file:///rec/old-0.m4a', duration: 5 },
      { uri: 'file:///rec/old-1.m4a', duration: 7 },
    ],
  };
  await draftStorage.saveDraft(initial);
  const before = await draftStorage.getDraft(initial.id);

  missingSource = 'file:///rec/new-1.m4a';
  await assert.rejects(
    draftStorage.saveDraft(
      {
        ...initial,
        segments: [
          { uri: 'file:///rec/new-0.m4a', duration: 6 },
          { uri: missingSource, duration: 8 },
        ],
      },
      { requireCompleteAudio: true },
    ),
    /complete save copied 1 of 2 segments/,
  );

  const after = await draftStorage.getDraft(initial.id);
  assert.deepEqual(after.segments, before.segments);
  assert.equal(after.audioDuration, before.audioDuration);
});

test('draftStorage: complete-audio save removes only the superseded committed snapshot', async () => {
  const deleted = [];
  const { draftStorage, state } = await loadDraftStorage(undefined, {
    safeDeleteFile: (uri) => deleted.push(uri),
  });
  draftStorage.setUserId('userA');
  const slot = {
    ...makeSlot('slot-complete-replace'),
    segments: [
      { uri: 'file:///rec/first-0.m4a', duration: 5 },
      { uri: 'file:///rec/first-1.m4a', duration: 7 },
    ],
  };

  await draftStorage.saveDraft(slot, { requireCompleteAudio: true });
  const first = await draftStorage.getDraft(slot.id);
  const metaKey = `captivet_draft_userA_${slot.id}_meta`;
  const chunkPrefix = `captivet_draft_userA_${slot.id}_chunk_`;
  const chunkMeta = JSON.parse(state.get(metaKey));
  assert.equal(chunkMeta.chunks, 1, 'fixture must remain a single mutable metadata chunk');
  const priorMetadata = JSON.parse(state.get(`${chunkPrefix}0`));
  const unconfinedUri = 'file:///outside-user-scope/restart_snapshot.m4a';
  priorMetadata.segments[1].uri = unconfinedUri;
  state.set(`${chunkPrefix}0`, JSON.stringify(priorMetadata));

  await draftStorage.saveDraft(
    {
      ...slot,
      segments: [
        { uri: 'file:///rec/second-0.m4a', duration: 6 },
        { uri: 'file:///rec/second-1.m4a', duration: 8 },
      ],
    },
    { requireCompleteAudio: true },
  );
  const second = await draftStorage.getDraft(slot.id);

  assert.equal(first.segments.length, 2);
  assert.equal(second.segments.length, 2);
  assert.ok(deleted.includes(first.segments[0].uri));
  assert.equal(
    deleted.includes(unconfinedUri),
    false,
    'cleanup must never follow a corrupted metadata URI outside the slot directory',
  );
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

test('draftStorage: delayed reconciliation cannot clear a newer server-draft link', async () => {
  const { draftStorage } = await loadDraftStorage();

  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));
  await draftStorage.updateServerDraftId('slot1', 'server-old');

  // The server probe for server-old is still in flight when another path
  // relinks the slot. Its eventual 404 must not detach server-new.
  await draftStorage.updateServerDraftId('slot1', 'server-new');
  await draftStorage.clearServerDraftIdForUser('userA', 'slot1', 'server-old');

  let draft = await draftStorage.getDraft('slot1');
  assert.equal(draft.serverDraftId, 'server-new');

  await draftStorage.clearServerDraftIdForUser('userA', 'slot1', 'server-new');
  draft = await draftStorage.getDraft('slot1');
  assert.equal(draft.serverDraftId, null);
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

test('draftStorage: durable restart marker blocks sync until phase 2 commits', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  const slotId = 'slot-restart-two-phase';
  const oldKey = 'recording-upload-v1:slot:intent-before-restart';
  const replacementKey = 'recording-upload-v2:restart:intent-after-restart';

  await draftStorage.saveDraft({
    ...makeSlot(slotId),
    uploadIntentId: 'intent-before-restart',
  });
  await draftStorage.updateServerDraftId(slotId, 'server-before-restart');
  await draftStorage.updatePendingConfirm(slotId, {
    recordingId: '11111111-1111-4111-8111-111111111111',
    fileKey:
      'recordings/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.m4a',
  }, 'server-before-restart');

  assert.equal(
    await draftStorage.beginUploadAttemptReset(slotId, oldKey, replacementKey),
    true,
  );
  let draft = await draftStorage.getDraft(slotId);
  assert.equal(draft.uploadKeyOverride, null);
  assert.equal(draft.supersededUploadKey, null);
  assert.equal(draft.serverDraftId, 'server-before-restart');
  assert.ok(draft.pendingConfirm);
  assert.equal(draft.pendingSync, false);
  assert.deepEqual(
    { ...draft.uploadRestartPending },
    {
      expectedOldKey: oldKey,
      replacementKey,
      previousPendingSync: false,
    },
  );

  let creates = 0;
  let result = await draftStorage.syncPending('userA', async () => {
    creates++;
    return { id: 'must-not-create' };
  });
  assert.deepEqual({ ...result }, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(creates, 0);

  assert.equal(
    await draftStorage.commitUploadAttemptReset(slotId, oldKey, replacementKey),
    true,
  );
  draft = await draftStorage.getDraft(slotId);
  assert.equal(draft.uploadKeyOverride, replacementKey);
  assert.equal(draft.supersededUploadKey, oldKey);
  assert.equal(draft.uploadRestartPending, null);
  assert.equal(draft.serverDraftId, null);
  assert.equal(draft.pendingConfirm, null);
  assert.equal(draft.pendingSync, false);
});

test('draftStorage: re-saving a restarted draft cannot enter ordinary background creation', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  const slotId = 'slot-restart-resave';
  const oldKey = 'recording-upload-v1:slot:intent-before-restart';
  const replacementKey = 'recording-upload-v2:restart:intent-after-restart';
  const restartedSlot = {
    ...makeSlot(slotId),
    uploadIntentId: 'intent-before-restart',
    uploadKeyOverride: replacementKey,
    supersededUploadKey: oldKey,
  };

  await draftStorage.saveDraft({
    ...makeSlot(slotId),
    uploadIntentId: 'intent-before-restart',
  });
  assert.equal(await draftStorage.resetUploadAttempt(slotId, oldKey, replacementKey), true);
  await draftStorage.saveDraft(restartedSlot);

  const draft = await draftStorage.getDraft(slotId);
  assert.equal(draft.pendingSync, false);
  assert.equal(draft.supersededUploadKey, oldKey);
  let creates = 0;
  const result = await draftStorage.syncPending('userA', async () => {
    creates++;
    return { id: 'must-not-create' };
  });
  assert.deepEqual({ ...result }, { attempted: 0, succeeded: 0, failed: 0 });
  assert.equal(creates, 0);
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

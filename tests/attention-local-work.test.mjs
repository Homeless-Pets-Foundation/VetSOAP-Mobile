// Attention Feed — device-local work: STRICT reads must distinguish a
// legitimate absence from an unreadable store. A swallowed failure would render
// as "all clear", which is exactly the data-loss blindness this feed exists to
// fix. Covers verification section 4 of the 2026-07-29 plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
// vm-realm objects fail deepStrictEqual's prototype identity check.
const plain = (value) => JSON.parse(JSON.stringify(value));

const USER = 'user-1';
const OTHER = 'user-2';
const SERVER_ID = '11111111-1111-4111-8111-111111111111';

// ─── Mocks ─────────────────────────────────────────────────────────────────

function makeSecureStoreMock({ failKeys = new Set() } = {}) {
  const store = new Map();
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(k) {
      if (failKeys.has(k) || failKeys.has('*')) throw new Error('keystore exploded');
      return store.has(k) ? store.get(k) : null;
    },
    async setItemAsync(k, v) {
      store.set(k, v);
    },
    async deleteItemAsync(k) {
      store.delete(k);
    },
    __store: store,
    __failKeys: failKeys,
  };
}

function makeFileSystemMock({ present = new Set(), throwing = new Set() } = {}) {
  return {
    File: class {
      constructor(uri) {
        if (throwing.has(uri)) throw new Error('fs exploded');
        this.uri = uri;
        this.exists = present.has(uri);
      }
      create() {}
      write() {}
      copy() {}
      move() {}
      delete() {}
      open() {
        return { readBytes: () => new Uint8Array(), writeBytes: () => {}, close: () => {} };
      }
    },
    Directory: class {
      constructor(uri) {
        this.uri = uri;
        this.exists = false;
      }
      create() {
        this.exists = true;
      }
      delete() {}
    },
    Paths: {
      document: { uri: 'file:///doc/' },
      cache: { uri: 'file:///cache/' },
      availableDiskSpace: 1024 * 1024 * 1024,
    },
  };
}

const legacyFsMock = { async copyAsync() {}, async moveAsync() {} };

async function loadDraftStorage(secure, fs) {
  const mod = await loadTsModule('src/lib/draftStorage.ts', {
    'expo-secure-store': secure,
    'expo-file-system': fs,
    'expo-file-system/legacy': legacyFsMock,
  });
  return mod;
}

async function loadStashStorage(secure) {
  const mod = await loadTsModule('src/lib/stashStorage.ts', {
    'expo-secure-store': secure,
  });
  return mod.stashStorage;
}

function draftMetaKey(slotId) {
  return `captivet_draft_${USER}_${slotId}_meta`;
}
function draftChunkKey(slotId, i) {
  return `captivet_draft_${USER}_${slotId}_chunk_${i}`;
}
function draftIndexKey(userId = USER) {
  return `captivet_drafts_index_${userId}`;
}

function draftPayload(overrides = {}) {
  return JSON.stringify({
    slotId: 'slot-1',
    savedAt: '2026-07-29T00:00:00.000Z',
    formData: { patientName: 'Bella' },
    segments: [{ uri: 'file:///doc/drafts/user-1/slot-1/seg_0.m4a', duration: 10 }],
    audioDuration: 10,
    serverDraftId: SERVER_ID,
    pendingSync: false,
    ...overrides,
  });
}

function seedDraft(secure, slotId, payload) {
  secure.__store.set(draftIndexKey(), JSON.stringify([slotId]));
  secure.__store.set(draftMetaKey(slotId), JSON.stringify({ chunks: 1, version: 1 }));
  secure.__store.set(draftChunkKey(slotId, 0), payload);
}

function seedStash(secure, sessions, generation = 'a') {
  const raw = JSON.stringify(sessions);
  secure.__store.set(`captivet_stash_${USER}_active`, generation);
  secure.__store.set(`captivet_stash_${USER}_${generation}_count`, '1');
  secure.__store.set(`captivet_stash_${USER}_${generation}_chunk_0`, raw);
}

// ─── draftStorage strict reads ─────────────────────────────────────────────

test('a genuinely absent draft index is a KNOWN empty list', async () => {
  const secure = makeSecureStoreMock();
  const { draftStorage } = await loadDraftStorage(secure, makeFileSystemMock());
  assert.deepEqual(plain(await draftStorage.listDraftsForUserStrict(USER)), []);
});

test('a Keystore exception on the index is UNKNOWN, not empty', async () => {
  const secure = makeSecureStoreMock({ failKeys: new Set([draftIndexKey()]) });
  const { draftStorage } = await loadDraftStorage(secure, makeFileSystemMock());
  await assert.rejects(
    () => draftStorage.listDraftsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

test('a malformed index, invalid entry, torn chunk, or bad payload is UNKNOWN', async () => {
  const cases = [
    ['malformed index json', (secure) => secure.__store.set(draftIndexKey(), '{oops')],
    ['non-array index', (secure) => secure.__store.set(draftIndexKey(), '{"a":1}')],
    ['path-traversal entry', (secure) => secure.__store.set(draftIndexKey(), '["../evil"]')],
    [
      'torn chunk set',
      (secure) => {
        secure.__store.set(draftIndexKey(), JSON.stringify(['slot-1']));
        secure.__store.set(draftMetaKey('slot-1'), JSON.stringify({ chunks: 2 }));
        secure.__store.set(draftChunkKey('slot-1', 0), draftPayload());
      },
    ],
    [
      'unparseable payload',
      (secure) => {
        secure.__store.set(draftIndexKey(), JSON.stringify(['slot-1']));
        secure.__store.set(draftMetaKey('slot-1'), JSON.stringify({ chunks: 1 }));
        secure.__store.set(draftChunkKey('slot-1', 0), '{not json');
      },
    ],
    [
      'shape that fails normalization',
      (secure) => seedDraft(secure, 'slot-1', JSON.stringify({ slotId: 'slot-1' })),
    ],
  ];
  for (const [label, seed] of cases) {
    const secure = makeSecureStoreMock();
    seed(secure);
    const { draftStorage } = await loadDraftStorage(secure, makeFileSystemMock());
    await assert.rejects(
      () => draftStorage.listDraftsForUserStrict(USER),
      (error) => error.code === 'STRICT_READ_UNAVAILABLE',
      label
    );
  }
});

test('an indexed draft whose metadata is proven absent is skipped, not an error', async () => {
  const secure = makeSecureStoreMock();
  secure.__store.set(draftIndexKey(), JSON.stringify(['slot-gone']));
  const { draftStorage } = await loadDraftStorage(secure, makeFileSystemMock());
  assert.deepEqual(plain(await draftStorage.listDraftsForUserStrict(USER)), []);
});

test('strict audio proof: segment present / missing / unreadable', async () => {
  const uri = 'file:///doc/drafts/user-1/slot-1/seg_0.m4a';
  const meta = { segments: [{ uri, duration: 10 }], durable: null, pendingConfirm: null };

  const present = await loadDraftStorage(
    makeSecureStoreMock(),
    makeFileSystemMock({ present: new Set([uri]) })
  );
  assert.equal(await present.draftStorage.draftHasLocalAudioStrict(meta, new Map()), 'present');

  const missing = await loadDraftStorage(makeSecureStoreMock(), makeFileSystemMock());
  assert.equal(await missing.draftStorage.draftHasLocalAudioStrict(meta, new Map()), 'missing');

  const broken = await loadDraftStorage(
    makeSecureStoreMock(),
    makeFileSystemMock({ throwing: new Set([uri]) })
  );
  assert.equal(await broken.draftStorage.draftHasLocalAudioStrict(meta, new Map()), 'unknown');
});

test('a syntactically valid durable pointer alone is NOT audio proof', async () => {
  const { draftStorage } = await loadDraftStorage(makeSecureStoreMock(), makeFileSystemMock());
  const meta = { segments: [], durable: { recordingId: 'dr-abc123' }, pendingConfirm: null };

  // Native snapshot available but the manifest is gone → proven missing.
  assert.equal(await draftStorage.draftHasLocalAudioStrict(meta, new Map()), 'missing');
  // Native snapshot unavailable → unknown, never "no audio".
  assert.equal(await draftStorage.draftHasLocalAudioStrict(meta, null), 'unknown');
});

test('a validated non-uploaded manifest with on-disk audio IS proof', async () => {
  const audioUri = 'file:///doc/durable/user-1/dr-abc123/audio.aac';
  const { draftStorage, durableManifestHasCompleteAudio } = await loadDraftStorage(
    makeSecureStoreMock(),
    makeFileSystemMock({ present: new Set([audioUri]) })
  );
  const manifest = {
    schemaVersion: 3,
    recordingId: 'dr-abc123',
    userId: 'user-1',
    slotId: 'slot-1',
    state: 'stopped',
    startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z',
    container: 'adts',
    codec: 'aac_lc',
    bitrate: 48000,
    sampleRate: 16000,
    channels: 1,
    adtsFrameCount: 120,
    durationMs: 6400,
    capturedDurationMs: 6400,
    audioFile: { uri: audioUri, committedBytes: 4096, completeFrameBytes: 4096 },
    peakDb: -12,
    appVersion: '1.13.16',
    buildNumber: '1',
  };
  assert.equal(durableManifestHasCompleteAudio(manifest), true);
  assert.equal(
    durableManifestHasCompleteAudio({ ...manifest, confirmedUploadAt: '2026-07-29T00:02:00.000Z' }),
    false,
    'a confirmed-uploaded manifest is not un-sent work'
  );
  assert.equal(durableManifestHasCompleteAudio({ ...manifest, adtsFrameCount: 0 }), false);

  const meta = { segments: [], durable: { recordingId: 'dr-abc123' }, pendingConfirm: null };
  const snapshot = new Map([['dr-abc123', manifest]]);
  assert.equal(await draftStorage.draftHasLocalAudioStrict(meta, snapshot), 'present');
});

// ─── stashStorage strict reads ─────────────────────────────────────────────

test('an absent stash store is a KNOWN empty list; a Keystore failure is unknown', async () => {
  const clean = await loadStashStorage(makeSecureStoreMock());
  assert.deepEqual(plain(await clean.getStashedSessionsForUserStrict(USER)), []);

  const broken = await loadStashStorage(makeSecureStoreMock({ failKeys: new Set(['*']) }));
  await assert.rejects(
    () => broken.getStashedSessionsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

test('a corrupt session entry is UNKNOWN instead of being silently filtered out', async () => {
  const secure = makeSecureStoreMock();
  seedStash(secure, [{ id: 's1', stashedAt: 'x', slots: [{ id: 'a', segments: [] }] }, { id: 5 }]);
  const stashStorage = await loadStashStorage(secure);
  await assert.rejects(
    () => stashStorage.getStashedSessionsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

test('a TORN ACTIVE generation is unknown even when an older one is readable', async () => {
  // Codex P1: an older generation cannot disprove the active one. A stash
  // written into the broken active generation is absent from the fallback, so
  // returning the fallback as authoritative would publish a known-zero unsent
  // count and let findLocalRecoveryAnchor answer `none` — unlocking a
  // destructive server delete while that audio is still stashed here.
  const secure = makeSecureStoreMock();
  secure.__store.set(`captivet_stash_${USER}_active`, 'a');
  secure.__store.set(`captivet_stash_${USER}_a_count`, '2');
  secure.__store.set(`captivet_stash_${USER}_a_chunk_0`, '[');
  secure.__store.set(`captivet_stash_${USER}_b_count`, '1');
  secure.__store.set(
    `captivet_stash_${USER}_b_chunk_0`,
    JSON.stringify([{ id: 's1', stashedAt: '2026-07-29T00:00:00.000Z', slots: [{ id: 'a', segments: [] }] }])
  );
  const stashStorage = await loadStashStorage(secure);
  await assert.rejects(
    () => stashStorage.getStashedSessionsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

test('an ABSENT active POINTER still falls through to the legacy layout', async () => {
  // The pre-migration path must keep working. Note the pointer itself is absent
  // here — that, not a missing generation, is what licenses a fallback.
  const secure = makeSecureStoreMock();
  secure.__store.set(`captivet_stash_${USER}_count`, '1');
  secure.__store.set(
    `captivet_stash_${USER}_chunk_0`,
    JSON.stringify([{ id: 's1', stashedAt: '2026-07-29T00:00:00.000Z', slots: [{ id: 'a', segments: [] }] }])
  );
  const stashStorage = await loadStashStorage(secure);
  const sessions = await stashStorage.getStashedSessionsForUserStrict(USER);
  assert.equal(sessions.length, 1);
});

test('a DANGLING active pointer (no generation count) is unknown, not a fallback', async () => {
  // Codex round 2: saveSessions writes chunks + count and only THEN flips the
  // pointer, so a valid pointer asserts its generation was committed. A missing
  // count key is damage; using an older generation could omit the newest stash.
  const secure = makeSecureStoreMock();
  secure.__store.set(`captivet_stash_${USER}_active`, 'a');
  secure.__store.set(`captivet_stash_${USER}_count`, '1');
  secure.__store.set(
    `captivet_stash_${USER}_chunk_0`,
    JSON.stringify([{ id: 's1', stashedAt: '2026-07-29T00:00:00.000Z', slots: [{ id: 'a', segments: [] }] }])
  );
  const stashStorage = await loadStashStorage(secure);
  await assert.rejects(
    () => stashStorage.getStashedSessionsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

test('a count that merely STARTS with a number is unknown, never a proven empty store', async () => {
  // Codex round 2: parseInt('0junk') === 0 would certify the store as empty
  // without reading a chunk — the same false all-clear the strict path prevents.
  for (const corrupt of ['0junk', '0.5', ' 1', '-1', '1e3', '']) {
    const secure = makeSecureStoreMock();
    secure.__store.set(`captivet_stash_${USER}_active`, 'a');
    secure.__store.set(`captivet_stash_${USER}_a_count`, corrupt);
    const stashStorage = await loadStashStorage(secure);
    await assert.rejects(
      () => stashStorage.getStashedSessionsForUserStrict(USER),
      (error) => error.code === 'STRICT_READ_UNAVAILABLE',
      `count ${JSON.stringify(corrupt)} must be unknown`
    );
  }

  // A genuine "0" is still a PROVEN empty store.
  const clean = makeSecureStoreMock();
  clean.__store.set(`captivet_stash_${USER}_active`, 'a');
  clean.__store.set(`captivet_stash_${USER}_a_count`, '0');
  const ok = await loadStashStorage(clean);
  assert.deepEqual(plain(await ok.getStashedSessionsForUserStrict(USER)), []);
});

test('every present layout unusable and no healthy fallback is UNKNOWN', async () => {
  const secure = makeSecureStoreMock();
  secure.__store.set(`captivet_stash_${USER}_active`, 'a');
  secure.__store.set(`captivet_stash_${USER}_a_count`, '1');
  secure.__store.set(`captivet_stash_${USER}_a_chunk_0`, '[');
  const stashStorage = await loadStashStorage(secure);
  await assert.rejects(
    () => stashStorage.getStashedSessionsForUserStrict(USER),
    (error) => error.code === 'STRICT_READ_UNAVAILABLE'
  );
});

// ─── localRecordings orchestration ─────────────────────────────────────────

function makeLocalRecordingsHarness({
  scopedUserId = USER,
  drafts = [],
  draftsError = null,
  draftAudio = () => 'present',
  stashes = [],
  stashError = null,
  manifests = new Map(),
  manifestUnavailable = false,
  vault = { items: [], recoverabilityComplete: true },
  vaultError = null,
  filePresent = new Set(),
  fileThrowing = new Set(),
} = {}) {
  const draftStorage = {
    getUserId: () => scopedUserId,
    async listDraftsForUserStrict() {
      if (draftsError) throw draftsError;
      return drafts;
    },
    async draftHasLocalAudioStrict(meta, snapshot) {
      return draftAudio(meta, snapshot);
    },
  };
  const stashStorage = {
    getUserId: () => scopedUserId,
    async getStashedSessionsForUserStrict() {
      if (stashError) throw stashError;
      return stashes;
    },
  };
  return loadTsModule('src/lib/localRecordings.ts', {
    './draftStorage': {
      draftStorage,
      // Tri-state on purpose: `__audioUnknown` models a manifest whose audio
      // path could not be probed (locked/unavailable storage), which must never
      // collapse to "missing".
      durableManifestAudioExistence: (m) => {
        if (!m) return 'missing';
        if (m.__audioUnknown === true) return 'unknown';
        return m.__complete === true ? 'present' : 'missing';
      },
    },
    './stashStorage': { stashStorage },
    './fileOps': {
      fileExistsStrict: (uri) => {
        if (fileThrowing.has(uri)) return 'unknown';
        return filePresent.has(uri) ? 'present' : 'missing';
      },
    },
    './supportStaffRecoveryVault': {
      supportStaffRecoveryVault: {
        async listItemsForUserStrict() {
          if (vaultError) throw vaultError;
          return vault;
        },
      },
      // Slot-level proof, mirroring the real implementation closely enough to
      // exercise the anchor's present/missing/unknown branches.
      vaultSlotIsRecoverableStrict: (slot) => {
        if (slot?.pendingConfirm) return 'present';
        let sawUnknown = false;
        for (const segment of slot?.segments ?? []) {
          if (fileThrowing.has(segment.uri)) sawUnknown = true;
          else if (filePresent.has(segment.uri)) return 'present';
        }
        return sawUnknown ? 'unknown' : 'missing';
      },
    },
    '../../modules/captivet-durable-recorder': {
      isAvailable: () => !manifestUnavailable,
      async listRecoverableSessions() {
        if (manifestUnavailable) throw new Error('native unavailable');
        return [...manifests.values()];
      },
    },
  });
}

test('getUnsentWorkSummary is user-scoped: a scope mismatch is unknown, never zero', async () => {
  const mod = await makeLocalRecordingsHarness({ scopedUserId: OTHER });
  const summary = await mod.getUnsentWorkSummary(USER);
  assert.deepEqual(plain(summary), {
    draftCount: 0,
    stashSessionCount: 0,
    draftsKnown: false,
    stashesKnown: false,
  });
});

test('draft and saved-session counts stay separate and are both known when readable', async () => {
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'a' }, { slotId: 'b' }],
    stashes: [{ id: 's1', slots: [] }],
  });
  const summary = await mod.getUnsentWorkSummary(USER);
  assert.deepEqual(plain(summary), {
    draftCount: 2,
    stashSessionCount: 1,
    draftsKnown: true,
    stashesKnown: true,
  });
});

test('a resumed stash still counts as un-sent work', async () => {
  const mod = await makeLocalRecordingsHarness({
    stashes: [{ id: 's1', slots: [], resumedAt: '2026-07-29T00:00:00.000Z' }],
  });
  const summary = await mod.getUnsentWorkSummary(USER);
  assert.equal(summary.stashSessionCount, 1);
});

test('only drafts with proven audio count; an unclassifiable proof marks the SOURCE unknown', async () => {
  const partial = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'a' }, { slotId: 'b' }],
    draftAudio: (meta) => (meta.slotId === 'a' ? 'present' : 'missing'),
    stashes: [],
  });
  const counted = await partial.getUnsentWorkSummary(USER);
  assert.equal(counted.draftCount, 1);
  assert.equal(counted.draftsKnown, true);

  const ambiguous = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'a' }, { slotId: 'b' }],
    draftAudio: (meta) => (meta.slotId === 'a' ? 'present' : 'unknown'),
    stashes: [{ id: 's1', slots: [] }],
  });
  const summary = await ambiguous.getUnsentWorkSummary(USER);
  assert.equal(summary.draftsKnown, false);
  assert.equal(summary.draftCount, 0);
  assert.equal(summary.stashesKnown, true, 'one failing source must not erase the other');
  assert.equal(summary.stashSessionCount, 1);
});

test('one source failing leaves the other source known (partial, never all-clear)', async () => {
  const mod = await makeLocalRecordingsHarness({
    draftsError: Object.assign(new Error('x'), { code: 'STRICT_READ_UNAVAILABLE' }),
    stashes: [{ id: 's1', slots: [] }],
  });
  const summary = await mod.getUnsentWorkSummary(USER);
  assert.equal(summary.draftsKnown, false);
  assert.equal(summary.stashesKnown, true);
  assert.equal(summary.stashSessionCount, 1);
});

// ─── findLocalRecoveryAnchor ───────────────────────────────────────────────

const ANCHOR_USER = { id: USER, role: 'veterinarian', organizationId: 'org-1' };

test('anchor: a proven draft match routes to its slot', async () => {
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'present',
  });
  const anchor = await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID);
  assert.deepEqual(plain(anchor), { kind: 'draft', draftSlotId: 'slot-9' });
});

test('anchor: a matching draft with NO recoverable audio does not block deletion', async () => {
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'missing',
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), { kind: 'none' });
});

test('anchor: a matching draft with an UNREADABLE audio proof fails closed', async () => {
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'unknown',
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), { kind: 'unknown' });
});

test('anchor: a committed stash beats its crash-window draft duplicate', async () => {
  const segmentUri = 'file:///doc/stashed-audio/user-1/s1/seg_0.m4a';
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'present',
    stashes: [
      {
        id: 'stash-1',
        slots: [{ id: 'slot-9', serverDraftId: SERVER_ID, segments: [{ uri: segmentUri }] }],
      },
    ],
    filePresent: new Set([segmentUri]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'saved_session',
    stashSessionId: 'stash-1',
  });
});

test('anchor: stale stash metadata for a DIFFERENT slot does not block deletion', async () => {
  const otherUri = 'file:///doc/stashed-audio/user-1/s1/other.m4a';
  const mod = await makeLocalRecordingsHarness({
    stashes: [
      {
        id: 'stash-1',
        slots: [
          { id: 'slot-match', serverDraftId: SERVER_ID, segments: [] },
          { id: 'slot-other', serverDraftId: 'different', segments: [{ uri: otherUri }] },
        ],
      },
    ],
    filePresent: new Set([otherUri]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), { kind: 'none' });
});

test('anchor: a standalone durable manifest is used only when no indexed owner matches', async () => {
  const manifest = {
    recordingId: 'dr-1',
    serverRecordingId: SERVER_ID,
    __complete: true,
  };
  const mod = await makeLocalRecordingsHarness({
    manifests: new Map([['dr-1', manifest]]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'durable_recovery',
    durableRecordingId: 'dr-1',
  });

  const withDraft = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'present',
    manifests: new Map([['dr-1', manifest]]),
  });
  assert.equal((await withDraft.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)).kind, 'draft');
});

test('anchor: an authorized vault item matches and routes to recovery', async () => {
  const vaultUri = 'file:///vault/seg-0.m4a';
  const mod = await makeLocalRecordingsHarness({
    vault: {
      items: [
        {
          id: 'vault-1',
          slots: [{ sourceServerDraftId: SERVER_ID, segments: [{ uri: vaultUri }] }],
        },
      ],
      recoverabilityComplete: true,
    },
    filePresent: new Set([vaultUri]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'support_recovery',
    vaultItemId: 'vault-1',
  });
});

test('anchor: the MATCHING vault slot must prove its own audio, not a sibling slot', async () => {
  // Codex round 2: the item-level snapshot only says SOME slot is recoverable.
  // Slot A still has audio; the target-matching slot B has lost its segments, so
  // routing to recovery would promise a recovery that cannot happen.
  const siblingUri = 'file:///vault/other-0.m4a';
  const mod = await makeLocalRecordingsHarness({
    vault: {
      items: [
        {
          id: 'vault-1',
          slots: [
            { sourceServerDraftId: 'unrelated', segments: [{ uri: siblingUri }] },
            { sourceServerDraftId: SERVER_ID, segments: [{ uri: 'file:///vault/gone.m4a' }] },
          ],
        },
      ],
      recoverabilityComplete: true,
    },
    filePresent: new Set([siblingUri]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'none',
  });
});

test('anchor: an UNPROBEABLE matching vault slot is unknown, never none', async () => {
  const lockedUri = 'file:///vault/locked-0.m4a';
  const mod = await makeLocalRecordingsHarness({
    vault: {
      items: [
        { id: 'vault-1', slots: [{ sourceServerDraftId: SERVER_ID, segments: [{ uri: lockedUri }] }] },
      ],
      recoverabilityComplete: true,
    },
    fileThrowing: new Set([lockedUri]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'unknown',
  });
});

test('anchor: an unavailable native bridge or unreadable vault is unknown, not none', async () => {
  const noNative = await makeLocalRecordingsHarness({ manifestUnavailable: true });
  assert.equal((await noNative.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)).kind, 'unknown');

  const badVault = await makeLocalRecordingsHarness({
    vaultError: Object.assign(new Error('x'), { code: 'STRICT_READ_UNAVAILABLE' }),
  });
  assert.equal((await badVault.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)).kind, 'unknown');

  const uncertainVault = await makeLocalRecordingsHarness({
    vault: { items: [], recoverabilityComplete: false },
  });
  assert.equal(
    (await uncertainVault.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)).kind,
    'unknown'
  );
});

test('anchor: a PROVEN match wins even when another source is unknown', async () => {
  const mod = await makeLocalRecordingsHarness({
    drafts: [{ slotId: 'slot-9', serverDraftId: SERVER_ID }],
    draftAudio: () => 'present',
    vaultError: Object.assign(new Error('x'), { code: 'STRICT_READ_UNAVAILABLE' }),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'draft',
    draftSlotId: 'slot-9',
  });
});

test('anchor: none requires every source to complete and prove no match', async () => {
  const mod = await makeLocalRecordingsHarness({});
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), { kind: 'none' });
});

test('anchor: a scope mismatch or missing id never returns none', async () => {
  const wrongScope = await makeLocalRecordingsHarness({ scopedUserId: OTHER });
  assert.equal((await wrongScope.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)).kind, 'unknown');

  const mod = await makeLocalRecordingsHarness({});
  assert.equal((await mod.findLocalRecoveryAnchor(null, SERVER_ID)).kind, 'unknown');
  assert.equal((await mod.findLocalRecoveryAnchor(ANCHOR_USER, '')).kind, 'unknown');
});

// ─── Source fences ─────────────────────────────────────────────────────────

test('the new strict readers use the SecureStore adapter, never a raw native call', async () => {
  const local = await read('src/lib/localRecordings.ts');
  assert.ok(!local.includes('SecureStore.'), 'localRecordings must not call SecureStore directly');
  assert.match(local, /withPromiseTimeout\(/);
  assert.match(local, /LOCAL_ATTENTION_READ_TIMEOUT_MS = 8_000/);

  const draft = await read('src/lib/draftStorage.ts');
  const strictSection = draft.slice(draft.indexOf('── STRICT read path'), draft.indexOf('Delete every SecureStore entry'));
  assert.ok(
    !strictSection.includes('SecureStore.'),
    'the strict draft readers go through secureStorage.getRawItemStrict'
  );
  assert.match(strictSection, /secureStorage\.getRawItemStrict/);

  const stash = await read('src/lib/stashStorage.ts');
  const stashStrict = stash.slice(stash.indexOf('── STRICT read path'), stash.indexOf('Encrypted stash storage'));
  assert.ok(!stashStrict.includes('SecureStore.'));
  assert.match(stashStrict, /secureStorage\.getRawItemStrict/);

  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(vault, /listItemsForUserStrict/);
  const vaultStrict = vault.slice(vault.indexOf('── STRICT read path'), vault.indexOf('interface AddItemsResult'));
  assert.ok(
    !/await readValidItemsAndPrune\(/.test(vaultStrict),
    'the strict vault read must not prune'
  );
  assert.ok(!/await saveItems\(/.test(vaultStrict), 'the strict vault read must not write');
});

test('the SecureStore adapter reports Keystore failures without leaking native text', async () => {
  const src = await read('src/lib/secureStorage.ts');
  assert.match(src, /async getRawItemStrict/);
  assert.match(src, /reportSecureStoreFailure\(op, error\);\s*\n\s*throw new StrictReadUnavailableError/);
  const strictRead = await read('src/lib/strictRead.ts');
  assert.match(strictRead, /A local read could not be completed/);
  assert.ok(!strictRead.includes('error.message'));
});

// ─── Codex round: an older generation can never disprove the active one ────

test('the strict vault read reads the ACTIVE generation before any fallback', async () => {
  // Codex P1: catching the active generation's failure and returning the
  // inactive one certifies a stale snapshot as recoverability-complete, which
  // hides available recovery work and exposes a destructive delete.
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  const strict = vault.slice(
    vault.indexOf('async function readItemsStrict'),
    vault.indexOf('function vaultSlotHasDurableAudioStrict')
  );
  // The active read is NOT inside the try/catch that tolerates a failure.
  const activeRead = strict.slice(0, strict.indexOf('let sawUnrecoverable'));
  assert.match(activeRead, /if \(active === 'a' \|\| active === 'b'\) \{/);
  assert.match(activeRead, /await readItemsForGenerationStrict\(active\)/);
  assert.ok(!activeRead.includes('catch'), 'a failing active generation must propagate');
  // A dangling pointer is unknown, and the generation fallback below is reached
  // ONLY when the pointer itself is absent.
  assert.match(activeRead, /vault:dangling_active_pointer/);
  assert.match(activeRead, /return activeItems;/);
  assert.match(strict, /const order: Generation\[\] = \['b', 'a'\];/);
});

// ─── Codex round 4 ─────────────────────────────────────────────────────────

test('a stash segment with a missing or non-string uri makes the store unknown', async () => {
  // Codex P1: `stashSlotProof` turns a malformed uri into `missing` via
  // `segment?.uri ?? ''`, so accepting the payload let a corrupt store
  // contribute a KNOWN zero and expose deletion.
  for (const badSegments of [[{}], [{ uri: 42 }], [{ uri: '' }], [{ uri: null }], [null]]) {
    const secure = makeSecureStoreMock();
    secure.__store.set(`captivet_stash_${USER}_active`, 'a');
    secure.__store.set(`captivet_stash_${USER}_a_count`, '1');
    secure.__store.set(
      `captivet_stash_${USER}_a_chunk_0`,
      JSON.stringify([
        { id: 's1', stashedAt: '2026-07-29T00:00:00.000Z', slots: [{ id: 'a', segments: badSegments }] },
      ])
    );
    const stashStorage = await loadStashStorage(secure);
    await assert.rejects(
      () => stashStorage.getStashedSessionsForUserStrict(USER),
      (error) => error.code === 'STRICT_READ_UNAVAILABLE',
      `segments ${JSON.stringify(badSegments)} must be unknown`
    );
  }

  // A well-formed segment list is still readable.
  const clean = makeSecureStoreMock();
  clean.__store.set(`captivet_stash_${USER}_active`, 'a');
  clean.__store.set(`captivet_stash_${USER}_a_count`, '1');
  clean.__store.set(
    `captivet_stash_${USER}_a_chunk_0`,
    JSON.stringify([
      {
        id: 's1',
        stashedAt: '2026-07-29T00:00:00.000Z',
        slots: [{ id: 'a', segments: [{ uri: 'file:///a/seg-0.m4a' }] }],
      },
    ])
  );
  const ok = await loadStashStorage(clean);
  assert.equal((await ok.getStashedSessionsForUserStrict(USER)).length, 1);
});

test('a hanging durable bridge cannot starve the other anchor sources', async () => {
  // Codex P2: the manifest read was awaited FIRST and unbounded, so a hanging
  // native bridge left `remaining()` at 1ms and every other source reported
  // unknown — on every Recheck.
  const local = await read('src/lib/localRecordings.ts');
  assert.match(local, /export const MANIFEST_SNAPSHOT_BUDGET_MS = LOCAL_ANCHOR_LOOKUP_TIMEOUT_MS \/ 2;/);
  const anchorFn = local.slice(local.indexOf('export async function findLocalRecoveryAnchor'));
  // The manifest read is capped, not given the whole window…
  assert.match(anchorFn, /Math\.min\(remaining\(\), MANIFEST_SNAPSHOT_BUDGET_MS\)/);
  // …and the independent vault read runs alongside it rather than after it.
  assert.match(anchorFn, /await Promise\.all\(\[\s*\n\s*withPromiseTimeout\(\s*\n\s*loadDurableManifestSnapshot/);
  assert.ok(
    anchorFn.indexOf('findVaultAnchor') < anchorFn.indexOf('findDraftAnchor'),
    'the vault read is issued with the manifest read, before the dependent reads'
  );
});

test('anchor: a vet needs COMPLETE local audio to reuse a pending-confirm slot', async () => {
  // Codex P2: the role-agnostic proof certified a pending-confirm token alone,
  // so the anchor promised a recovery route the authorization-filtered listing
  // would have filtered out for a veterinarian.
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  const fn = vault.slice(
    vault.indexOf('export function vaultSlotIsRecoverableStrict'),
    vault.indexOf('function itemIsRecoverableStrict')
  );
  assert.match(fn, /user\?: Pick<RecoveryUser, 'role'> \| null/);
  assert.match(fn, /if \(!user \|\| user\.role === 'owner' \|\| user\.role === 'admin'\) return 'present';/);
  assert.match(fn, /return vaultSlotHasCompleteLocalAudioStrict\(slot\);/);
  // The anchor passes the viewer through.
  const local = await read('src/lib/localRecordings.ts');
  assert.match(local, /vaultSlotIsRecoverableStrict\(slot, user\)/);
});

test('a draft segment with a malformed uri makes the strict read unknown', async () => {
  // Codex round 6: normalizeDraftMetadata `continue`s past a bad entry and still
  // returns a draft. If the dropped entry was the only audio reference,
  // draftHasLocalAudioStrict said `missing` — a KNOWN zero, and a `none` anchor.
  for (const badSegments of [[{}], [{ uri: 42, duration: 1 }], [{ uri: '', duration: 1 }], [null], [{ uri: 'file:///a', duration: 'x' }]]) {
    const secure = makeSecureStoreMock();
    seedDraft(secure, 'slot-1', draftPayload({ segments: badSegments }));
    const { draftStorage } = await loadDraftStorage(secure, makeFileSystemMock());
    await assert.rejects(
      () => draftStorage.listDraftsForUserStrict(USER),
      (error) => error.code === 'STRICT_READ_UNAVAILABLE',
      `segments ${JSON.stringify(badSegments)} must be unknown`
    );
  }

  // A well-formed draft still reads.
  const clean = makeSecureStoreMock();
  seedDraft(clean, 'slot-1', draftPayload());
  const { draftStorage } = await loadDraftStorage(clean, makeFileSystemMock());
  assert.equal((await draftStorage.listDraftsForUserStrict(USER)).length, 1);
});

test('the strict vault parser validates nested slots and segments', async () => {
  // Codex round 6: validating only the item wrapper let a malformed segment uri
  // through, and fileExistsStrict then read it as `missing` — so the snapshot
  // could be certified COMPLETE and the anchor answer `none`.
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  const parser = vault.slice(
    vault.indexOf('function parseItemsStrict'),
    vault.indexOf('async function readItemsForGenerationStrict')
  );
  assert.match(parser, /vault:slot_shape/);
  assert.match(parser, /vault:segment_shape/);
  assert.match(parser, /typeof uri !== 'string' \|\| uri\.length === 0/);
});

test('the bounded vault-summary read does not retry, and keys on the ROLE', async () => {
  // Codex round 6: the global policy retries non-ApiError twice, so a hanging
  // native read held the hook in `loading` for ~3 timeout windows while Home
  // suppressed the banner; and the read is role-dependent, so the key must be.
  const hook = await read('src/hooks/useSupportRecoveryVault.ts');
  assert.match(hook, /retry: false,/);
  assert.match(hook, /role: string \| null \| undefined/);
  assert.match(hook, /role \?\? 'none',/);
  assert.match(hook, /supportRecoveryVaultQueryKey\(user\?\.id, user\?\.organizationId, user\?\.role\)/);
});

test('a PRESENT but malformed active pointer is unknown, never a fallback', async () => {
  // Codex round 5: only `null` means pre-migration. A corrupt pointer value fell
  // through and returned the first readable legacy/inactive generation, which may
  // predate the newest stash.
  for (const corrupt of ['x', 'A', 'ab', '', ' a']) {
    const secure = makeSecureStoreMock();
    secure.__store.set(`captivet_stash_${USER}_active`, corrupt);
    secure.__store.set(`captivet_stash_${USER}_count`, '1');
    secure.__store.set(
      `captivet_stash_${USER}_chunk_0`,
      JSON.stringify([
        { id: 's1', stashedAt: '2026-07-29T00:00:00.000Z', slots: [{ id: 'a', segments: [] }] },
      ])
    );
    const stashStorage = await loadStashStorage(secure);
    await assert.rejects(
      () => stashStorage.getStashedSessionsForUserStrict(USER),
      (error) => error.code === 'STRICT_READ_UNAVAILABLE',
      `pointer ${JSON.stringify(corrupt)} must be unknown`
    );
  }

  // Both readers guard it.
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(vault, /vault:invalid_active_pointer/);
  const stash = await read('src/lib/stashStorage.ts');
  assert.match(stash, /stash:invalid_active_pointer/);
});

test('both strict chunk-count readers use the whole-string integer parser', async () => {
  const strictRead = await read('src/lib/strictRead.ts');
  assert.match(strictRead, /export function parseStrictChunkCount/);
  assert.match(strictRead, /\/\^\[0-9\]\{1,6\}\$\//);

  // Bound each slice to the strict section only — the lenient best-effort
  // readers elsewhere in these files legitimately still use parseInt.
  for (const [file, endMarker] of [
    ['src/lib/stashStorage.ts', 'Encrypted stash storage'],
    ['src/lib/supportStaffRecoveryVault.ts', 'interface AddItemsResult'],
  ]) {
    const source = await read(file);
    const start = source.indexOf('── STRICT read path');
    const end = source.indexOf(endMarker);
    assert.ok(start > 0 && end > start, `${file} has a bounded strict section`);
    const strictSection = source.slice(start, end);
    assert.match(strictSection, /parseStrictChunkCount\(/);
    assert.ok(
      !/parseInt\(/.test(strictSection),
      `${file}: the strict path must not use parseInt (it accepts a numeric prefix)`
    );
  }
});

test('a MATCHING durable manifest whose audio cannot be probed is unknown, never none', async () => {
  // Codex P1: `fileExistsStrict` returns 'unknown' for locked/unavailable
  // storage; collapsing that to false made the anchor answer `none`, which is
  // exactly what unlocks the destructive server delete.
  const mod = await makeLocalRecordingsHarness({
    manifests: new Map([
      ['dur-1', { recordingId: 'dur-1', serverRecordingId: SERVER_ID, __audioUnknown: true }],
    ]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'unknown',
  });
});

test('a matching durable manifest with proven-absent audio still allows deletion', async () => {
  const mod = await makeLocalRecordingsHarness({
    manifests: new Map([
      ['dur-1', { recordingId: 'dur-1', serverRecordingId: SERVER_ID, __complete: false }],
    ]),
  });
  assert.deepEqual(plain(await mod.findLocalRecoveryAnchor(ANCHOR_USER, SERVER_ID)), {
    kind: 'none',
  });
});

test('the tri-state durable helper is what the strict paths call', async () => {
  const draft = await read('src/lib/draftStorage.ts');
  assert.match(draft, /export function durableManifestAudioExistence\(/);
  // The boolean form is derived from the tri-state, so they cannot drift.
  assert.match(
    draft,
    /export function durableManifestHasCompleteAudio\([\s\S]*?durableManifestAudioExistence\(manifest\) === 'present';/
  );
  // …and the strict draft proof propagates the tri-state rather than collapsing.
  assert.match(draft, /return durableManifestAudioExistence\(manifest\);/);

  const local = await read('src/lib/localRecordings.ts');
  assert.ok(
    !local.includes('durableManifestHasCompleteAudio'),
    'localRecordings is strict-only and must use the tri-state helper'
  );
  assert.match(local, /if \(durable === 'unknown'\) sawUnknown = true;/);
});

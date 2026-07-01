import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

function makeSecureStoreMock() {
  const store = new Map();
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async setItemAsync(k, v) {
      store.set(k, v);
    },
    async deleteItemAsync(k) {
      store.delete(k);
    },
    __store: store,
  };
}

const fileSystemMock = {
  File: class {
    exists = false;
    create() {}
    write() {}
    copy() {}
    move() {}
  },
  Directory: class {
    exists = false;
    create() {}
  },
  Paths: {
    document: { uri: 'file:///doc/' },
    cache: { uri: 'file:///cache/' },
    availableDiskSpace: 1024 * 1024 * 1024,
  },
};

async function loadDraftStorage() {
  const secure = makeSecureStoreMock();
  const mod = await loadTsModule('src/lib/draftStorage.ts', {
    'expo-secure-store': secure,
    'expo-file-system': fileSystemMock,
    'expo-file-system/legacy': { async copyAsync() {}, async moveAsync() {} },
  });
  return { draftStorage: mod.draftStorage, secure };
}

const DURABLE = {
  recordingId: 'dr-abc123',
  codec: 'aac_lc',
  sampleRate: 16000,
  bitrate: 48000,
  durationMs: 6400,
  peakDb: -12,
};

function durableSlot() {
  return {
    id: 'slot-durable-1',
    formData: { patientName: 'redacted', clientName: 'redacted', species: 'canine' },
    audioState: 'stopped',
    segments: [],
    durable: DURABLE,
    audioUri: null,
    audioDuration: 6.4,
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    serverRecordingId: null,
    draftSlotId: null,
    serverDraftId: null,
    draftMetadataDirty: false,
    pendingConfirm: null,
  };
}

test('durable pointer survives saveDraft -> getDraft (regression: normalizeDraftMetadata)', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  const { draftSlotId, promotedSegments } = await draftStorage.saveDraft(durableSlot());
  assert.equal(draftSlotId, 'slot-durable-1');
  assert.equal(promotedSegments.length, 0); // durable copies no segment files

  const read1 = await draftStorage.getDraft('slot-durable-1');
  assert.ok(read1, 'draft must exist');
  assert.equal(read1.segments.length, 0);
  assert.ok(read1.durable, 'durable pointer must survive the round-trip');
  assert.equal(read1.durable.recordingId, 'dr-abc123');
  assert.equal(read1.durable.sampleRate, 16000);
  assert.equal(read1.durable.bitrate, 48000);
});

test('durable pointer survives updateServerDraftId rewrite', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(durableSlot());
  await draftStorage.updateServerDraftId('slot-durable-1', 'srv-1');
  const meta = await draftStorage.getDraft('slot-durable-1');
  assert.equal(meta.serverDraftId, 'srv-1');
  assert.ok(meta.durable, 'durable must not be stripped when the server id is written back');
  assert.equal(meta.durable.recordingId, 'dr-abc123');
});

test('listDrafts exposes durable recordingId for recovery suppression', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(durableSlot());
  const drafts = await draftStorage.listDrafts();
  const ids = drafts.map((d) => d.durable?.recordingId).filter(Boolean);
  assert.equal(ids.join(','), 'dr-abc123');
});

// Source guards for the native audit fixes (A/B/C/E) — cannot compile natively.
test('native audit fixes present in source', async () => {
  const iosEngine = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(iosEngine, /edited: true,\s*\n\s*anchorsPending: nil/); // Fix A: orphan blocks Continue
  const iosManifest = await read('modules/captivet-durable-recorder/ios/DurableManifest.swift');
  assert.match(iosManifest, /manifest\.userId == userId/); // Fix D: userId match guard

  const andEngine = await read('modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt');
  assert.match(andEngine, /peakDb = -20\.0/); // Fix B: orphan not silent
  assert.match(andEngine, /RandomAccessFile\(audio, "rw"\)\.use \{ it\.setLength\(resumeBoundary\) \}/); // Fix C: resume truncate
  assert.match(andEngine, /parseFromOffset\(audio, anchor\)/); // Fix C: bounded tail reconcile

  const andManifest = await read('modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableManifest.kt');
  assert.match(andManifest, /manifest-\$\{java\.util\.UUID\.randomUUID\(\)\}\.json\.tmp/); // Fix E: unique temp
});

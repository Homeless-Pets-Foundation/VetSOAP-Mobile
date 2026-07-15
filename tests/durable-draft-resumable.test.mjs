// Regression: a finished durable draft (audio in audio.aac, segments[] empty)
// must count as resumable so it appears in the "Not Submitted" list + resume map
// and is NOT left unreachable. Guards the CRITICAL durable-blind-read-gate class.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

// fileExists is only consulted for the legacy segment path; a durable draft
// short-circuits before it. Mock expo-file-system so fileOps loads; make
// fileExists return false so ONLY the durable branch can make a draft resumable.
const mocks = {
  'expo-file-system': {
    File: class {
      constructor() {}
      get exists() {
        return false;
      }
    },
    Directory: class {},
  },
};

const durableDraft = {
  slotId: 'slot-1',
  savedAt: '2026-06-30T00:00:00.000Z',
  formData: { patientName: 'Rex' },
  segments: [],
  audioDuration: 42,
  serverDraftId: 'srv-abc',
  pendingSync: false,
  durable: { recordingId: 'dr-abc123', codec: 'aac_lc', sampleRate: 16000, bitrate: 48000, durationMs: 42000, peakDb: -12 },
};

const emptyLegacyDraft = {
  slotId: 'slot-2',
  savedAt: '2026-06-30T00:00:00.000Z',
  formData: { patientName: 'Milo' },
  segments: [],
  audioDuration: 0,
  serverDraftId: null,
  pendingSync: false,
  durable: null,
};

const durableBadIdDraft = {
  ...durableDraft,
  slotId: 'slot-3',
  durable: { ...durableDraft.durable, recordingId: '../escape' },
};

const pendingConfirmDraft = {
  ...emptyLegacyDraft,
  slotId: 'slot-4',
  pendingConfirm: {
    recordingId: '11111111-1111-4111-8111-111111111111',
    fileKey: 'recordings/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.m4a',
  },
};

test('isDraftResumable: durable draft with empty segments is resumable', async () => {
  const mod = await loadTsModule('src/lib/draftRecordings.ts', mocks);
  assert.equal(mod.isDraftResumable(durableDraft), true);
  // Legacy draft with no segments (and fileExists false) is NOT resumable.
  assert.equal(mod.isDraftResumable(emptyLegacyDraft), false);
  // A path-traversal durable id is rejected (Rule 15) -> not resumable via durable.
  assert.equal(mod.isDraftResumable(durableBadIdDraft), false);
  // R2 confirmation proof remains resumable even after local audio disappears.
  assert.equal(mod.isDraftResumable(pendingConfirmDraft), true);
});

test('buildDraftResumeMap: durable draft maps its serverDraftId -> slotId', async () => {
  const mod = await loadTsModule('src/lib/draftRecordings.ts', mocks);
  const map = mod.buildDraftResumeMap([durableDraft, emptyLegacyDraft, pendingConfirmDraft]);
  assert.equal(map['srv-abc'], 'slot-1');
  // The empty legacy draft is absent (nothing to resume).
  assert.equal(map['local-draft:slot-4'], 'slot-4');
  assert.equal(Object.keys(map).length, 2);
});

test('mergeDraftRecordings: durable draft surfaces as a Not-Submitted card', async () => {
  const mod = await loadTsModule('src/lib/draftRecordings.ts', mocks);
  const merged = mod.mergeDraftRecordings([durableDraft], [], 'user-1', 'org-1');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'srv-abc');
  assert.equal(merged[0].status, 'draft');
});

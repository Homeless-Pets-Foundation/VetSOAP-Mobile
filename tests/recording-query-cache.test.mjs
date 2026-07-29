import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const CACHE = await loadTsModule('src/lib/recordingQueryCache.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));

const ATTENTION_PREFIX = ['recordings', 'attention'];

function keysFor(mutation) {
  return plain(CACHE.recordingInvalidationKeysFor(mutation));
}

function hasKey(keys, target) {
  return keys.some((key) => JSON.stringify(key) === JSON.stringify(target));
}

test('recording cache helper narrows invalidation keys by mutation type', () => {
  assert.deepEqual(keysFor('draft_changed'), keysFor('draft_deleted'));
  assert.deepEqual(keysFor('draft_changed'), [
    ['recordings', 'recent'],
    ['recordings', 'list'],
    ['recordings', 'drafts'],
    ATTENTION_PREFIX,
    ['local-drafts'],
    ['attention', 'local-unsent'],
  ]);
  assert.deepEqual(keysFor('device_registration_recovered'), keysFor('draft_changed'));
  assert.deepEqual(keysFor('submit_success'), [
    ['recordings', 'recent'],
    ['recordings', 'list'],
    ['recordings', 'drafts'],
    ATTENTION_PREFIX,
    ['local-drafts'],
    ['attention', 'local-unsent'],
    ['dashboard', 'quality'],
  ]);
  assert.deepEqual(keysFor('detail_deleted'), keysFor('submit_success'));
  assert.deepEqual(keysFor('processing_retry'), [
    ['recordings', 'recent'],
    ['recordings', 'list'],
    ATTENTION_PREFIX,
    ['dashboard', 'quality'],
  ]);
  assert.deepEqual(keysFor('soap_regenerated'), keysFor('processing_retry'));
  assert.deepEqual(keysFor('metadata_update'), keysFor('processing_retry'));

  // Every mutation that can change an attention-relevant source state must
  // reach the attention page, or an already-mounted row goes stale.
  for (const mutation of [
    'draft_changed',
    'draft_deleted',
    'device_registration_recovered',
    'submit_success',
    'detail_deleted',
    'processing_retry',
    'soap_regenerated',
    'metadata_update',
  ]) {
    assert.ok(hasKey(keysFor(mutation), ATTENTION_PREFIX), `${mutation} must reach attention`);
  }
});

test('the dead review-update mutation is gone', async () => {
  const source = await read('src/lib/recordingQueryCache.ts');
  assert.ok(!source.includes('review_update'));
  assert.match(source, /refetchType: 'active'/);
  assert.doesNotMatch(source, /queryKey: \['recordings'\]/);
});

test('the attention cache stores only the narrow projection on a detail merge', () => {
  const detailRecording = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    status: 'completed',
    patientName: 'Bella',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    aiExtractedMetadata: null,
    submittedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    // Detail-only / raw-failure fields that must NOT reach the attention cache.
    errorMessage: 'TypeError: boom',
    errorCode: 'LEGACY_CODE',
    audioFileUrl: 'https://example.invalid/a.m4a',
    transcriptText: 'clinical text',
  };

  const stored = { data: [{ id: detailRecording.id, status: 'uploading' }], pagination: {} };
  const setCalls = [];
  const queryClient = {
    setQueriesData: (filters, updater) => {
      setCalls.push(JSON.stringify(filters.queryKey));
      if (JSON.stringify(filters.queryKey) === JSON.stringify(ATTENTION_PREFIX)) {
        stored.merged = updater(stored);
      }
    },
    removeQueries: () => {},
    invalidateQueries: () => Promise.resolve(),
  };

  CACHE.mergeRecordingIntoCachedLists(queryClient, detailRecording);
  assert.ok(setCalls.includes(JSON.stringify(ATTENTION_PREFIX)), 'attention must be merged');
  const merged = plain(stored.merged);
  assert.deepEqual(Object.keys(merged.data[0]).sort(), [
    'aiExtractedMetadata',
    'appointmentType',
    'breed',
    'clientName',
    'id',
    'patientName',
    'qualityWarnings',
    // Bounded truncation facts (counts/booleans only, never the dropped strings)
    // so a >20-warning row cannot under-report or read as clean.
    'qualityWarningsTotal',
    'qualityWarningsTruncated',
    'species',
    'status',
    'submittedAt',
    'updatedAt',
    'userId',
  ]);
  const serialized = JSON.stringify(merged);
  assert.ok(!serialized.includes('TypeError'));
  assert.ok(!serialized.includes('example.invalid'));
  assert.ok(!serialized.includes('clinical text'));
});

test('a terminal non-draft delete purges detail, SOAP, tasks, lists, and patient visits', () => {
  const removed = [];
  const invalidated = [];
  const setKeys = [];
  const queryClient = {
    removeQueries: ({ queryKey }) => removed.push(JSON.stringify(queryKey)),
    invalidateQueries: ({ queryKey }) => {
      invalidated.push(JSON.stringify(queryKey));
      return Promise.resolve();
    },
    setQueriesData: ({ queryKey }) => setKeys.push(JSON.stringify(queryKey)),
  };

  CACHE.purgeDeletedRecordingCaches(queryClient, { recordingId: 'rec-1', patientId: 'pat-1' });

  assert.ok(removed.includes(JSON.stringify(['recording', 'rec-1'])));
  assert.ok(removed.includes(JSON.stringify(['soapNote', 'rec-1'])));
  assert.ok(removed.includes(JSON.stringify(['recordingTasks', 'rec-1'])));
  // Every cached visit-page variant for the linked patient, not one filtered row.
  assert.ok(removed.includes(JSON.stringify(['patient', 'pat-1', 'recordings'])));
  // Row purged from every recordings list INCLUDING attention.
  assert.ok(setKeys.includes(JSON.stringify(ATTENTION_PREFIX)));
  assert.ok(setKeys.includes(JSON.stringify(['recordings', 'list'])));
  // Summaries invalidated after the purge.
  assert.ok(invalidated.includes(JSON.stringify(['patient', 'pat-1'])));
  assert.ok(invalidated.includes(JSON.stringify(['patients'])));
  assert.ok(invalidated.includes(JSON.stringify(['dashboard', 'quality'])));
});

test('hot recording mutations use central cache helper instead of broad invalidation', async () => {
  const card = await read('src/components/RecordingCard.tsx');
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const record = await read('app/(app)/(tabs)/record.tsx');

  // Status-aware terminal deletion: a draft invalidates, a non-draft PURGES
  // its cascaded SOAP note / tasks / patient visits before navigating.
  assert.match(detail, /invalidateRecordingCaches\(queryClient, 'draft_deleted'\)/);
  assert.match(detail, /purgeDeletedRecordingCaches\(queryClient, \{/);
  assert.match(detail, /patientId: recording\?\.patientId \?\? null/);
  assert.match(record, /invalidateRecordingCaches\(queryClient, 'submit_success'\)/);
  assert.match(await read('src/components/DeviceLimitModal.tsx'), /invalidateRecordingCaches\(queryClient, 'device_registration_recovered'\)/);

  assert.doesNotMatch(card, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
  assert.doesNotMatch(detail, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
  assert.doesNotMatch(record, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
});

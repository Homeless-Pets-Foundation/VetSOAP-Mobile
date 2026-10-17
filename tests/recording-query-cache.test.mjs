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

test('a mutation row that fails the LIST contract leaves the attention cache alone', () => {
  // Codex round 9: this path used only projectAttentionRecording, so a mutation
  // response with e.g. `review: null` could replace an already-validated row —
  // derivation would drop its only reason while the server phase still read as
  // successful, and the feed could briefly claim all-clear.
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    status: 'completed',
    patientName: 'Bella',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    submittedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };

  for (const [label, bad] of [
    ['null review', { ...base, aiExtractedMetadata: { review: null } }],
    ['non-uuid id', { ...base, id: 'not-a-uuid', aiExtractedMetadata: null }],
    ['drop reason without a reason', { ...base, aiExtractedMetadata: { dropReasons: [{ field: 'species' }] } }],
  ]) {
    const original = { id: base.id, status: 'uploading' };
    const stored = { data: [original], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } };
    const queryClient = {
      setQueriesData: (filters, updater) => {
        if (JSON.stringify(filters.queryKey) === JSON.stringify(ATTENTION_PREFIX)) {
          stored.merged = updater(stored);
        }
      },
      removeQueries: () => {},
      invalidateQueries: () => Promise.resolve(),
    };
    CACHE.mergeRecordingIntoCachedLists(queryClient, bad);
    // Untouched: the previously validated row survives.
    assert.deepEqual(plain(stored.merged.data[0]), plain(original), label);
  }

  // A VALID mutation row still merges.
  const valid = { ...base, aiExtractedMetadata: { review: 'unconfirmed' } };
  const stored = { data: [{ id: base.id, status: 'uploading' }], pagination: {} };
  const queryClient = {
    setQueriesData: (filters, updater) => {
      if (JSON.stringify(filters.queryKey) === JSON.stringify(ATTENTION_PREFIX)) {
        stored.merged = updater(stored);
      }
    },
    removeQueries: () => {},
    invalidateQueries: () => Promise.resolve(),
  };
  CACHE.mergeRecordingIntoCachedLists(queryClient, valid);
  assert.equal(plain(stored.merged.data[0]).status, 'completed');
});

test('a terminal non-draft delete purges detail, SOAP, tasks, lists, and patient visits', async () => {
  const removed = [];
  const invalidated = [];
  const recordingInvalidations = [];
  const setKeys = [];
  const h = await loadCoalescingHarness();
  const queryClient = {
    removeQueries: ({ queryKey }) => removed.push(JSON.stringify(queryKey)),
    invalidateQueries: (filters) => {
      if (filters.predicate) recordingInvalidations.push(filters);
      else invalidated.push(JSON.stringify(filters.queryKey));
      return Promise.resolve();
    },
    setQueriesData: ({ queryKey }) => setKeys.push(JSON.stringify(queryKey)),
  };

  h.cache.purgeDeletedRecordingCaches(queryClient, { recordingId: 'rec-1', patientId: 'pat-1' });
  // The purge itself is synchronous; only the summary refetch waits for the window.
  assert.equal(recordingInvalidations.length, 0);
  h.flush();

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
  assert.equal(recordingInvalidations.length, 1);
  assert.ok(matches(recordingInvalidations[0], ['dashboard', 'quality', 'org']));
  assert.ok(matches(recordingInvalidations[0], ['recordings', 'list', '', 'all', 'submittedAt-desc']));
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

// ─── coalesced invalidation ──────────────────────────────────────────
//
// Every recording mutation used to refetch each matching list separately: with
// Home and Recordings both mounted that was five `GET /api/recordings` per call,
// which fills OkHttp's five-requests-per-host limit on its own. A discarded
// three-slot session called it once per slot as each SecureStore delete settled,
// and an autosave called `draft_changed` twice. Requests inside one window now
// go out as ONE invalidateQueries over the union of their key sets.

async function loadCoalescingHarness() {
  const timers = [];
  const calls = [];
  const cache = await loadTsModule('src/lib/recordingQueryCache.ts', {}, {
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });
  const queryClient = {
    invalidateQueries(filters, options) {
      calls.push({ filters, options });
      return Promise.resolve();
    },
  };
  return {
    cache,
    queryClient,
    calls,
    timers,
    flush() {
      const due = timers.splice(0);
      for (const timer of due) timer.fn();
    },
  };
}

const matches = (filters, queryKey) => filters.predicate({ queryKey });

test('mutations inside one window become one invalidateQueries call', async () => {
  const h = await loadCoalescingHarness();
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_changed');
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_changed');
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_changed');
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_deleted');

  assert.equal(h.calls.length, 0, 'nothing may refetch before the window closes');
  assert.equal(h.timers.length, 1, 'one window, however many requests');
  assert.equal(h.timers[0].ms, h.cache.RECORDING_INVALIDATION_WINDOW_MS);

  h.flush();
  assert.equal(h.calls.length, 1);
  const [{ filters, options }] = h.calls;
  assert.equal(filters.refetchType, 'active');
  // Within the window there is one call; a later window describes a newer
  // state change, so it must restart an in-flight fetch rather than join it.
  // TanStack v5 reads cancelRefetch from the options argument, not the filters.
  assert.equal(options?.cancelRefetch, true);
  assert.equal(filters.cancelRefetch, undefined);
  assert.equal(filters.queryKey, undefined, 'the union goes out as a predicate');

  for (const key of [
    ['recordings', 'recent'],
    ['recordings', 'list', '', 'all', 'submittedAt-desc'],
    ['recordings', 'drafts', 'recent'],
    ['recordings', 'drafts', 'list', '', 'desc'],
    ['recordings', 'attention', 'updated-v1'],
    ['local-drafts', 'user-1'],
    ['attention', 'local-unsent', 'user-1'],
  ]) {
    assert.ok(matches(filters, key), `${JSON.stringify(key)} must be invalidated`);
  }
  for (const key of [
    ['dashboard', 'quality', 'org', 'user', 'vet'],
    ['recording', 'rec-1'],
    ['patients', 'list'],
    ['recordings'],
    ['attention'],
  ]) {
    assert.ok(!matches(filters, key), `${JSON.stringify(key)} must not be invalidated`);
  }
});

test('the window carries the union of every requested key set', async () => {
  const h = await loadCoalescingHarness();
  h.cache.invalidateRecordingCaches(h.queryClient, 'processing_retry');
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_deleted');
  h.flush();

  assert.equal(h.calls.length, 1);
  // From processing_retry only.
  assert.ok(matches(h.calls[0].filters, ['dashboard', 'quality', 'org']));
  // From draft_deleted only.
  assert.ok(matches(h.calls[0].filters, ['recordings', 'drafts', 'recent']));
  assert.ok(matches(h.calls[0].filters, ['local-drafts', 'user-1']));
});

test('a request after the window opens a new one', async () => {
  const h = await loadCoalescingHarness();
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_changed');
  h.flush();
  h.cache.invalidateRecordingCaches(h.queryClient, 'submit_success');

  assert.equal(h.timers.length, 1, 'the second request must schedule its own window');
  h.flush();
  assert.equal(h.calls.length, 2);
  assert.ok(matches(h.calls[1].filters, ['dashboard', 'quality', 'org']));
});

test('windows are per QueryClient', async () => {
  const h = await loadCoalescingHarness();
  const other = { invalidateQueries: () => Promise.resolve() };
  h.cache.invalidateRecordingCaches(h.queryClient, 'draft_changed');
  h.cache.invalidateRecordingCaches(other, 'draft_changed');
  assert.equal(h.timers.length, 2);
});

// Attention Feed — functional coverage of the PURE derivation
// (src/lib/attentionFeed.ts), per the 2026-07-29 plan's verification section.
// Fixtures are LIST-shaped rows, never fully-populated detail `Recording`s:
// the builder must never depend on a column the list select omits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

const FEED = await loadTsModule('src/lib/attentionFeed.ts');
const COPY = (await loadTsModule('src/constants/strings.ts')).ATTENTION_FEED_COPY;

const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const OWNER = { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'owner' };
const ADMIN = { id: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'admin' };
const VET = { id: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'veterinarian' };
const SUPPORT = { id: 'aaaaaaaa-0000-4000-8000-000000000004', role: 'support_staff' };
const OTHER_USER = 'aaaaaaaa-0000-4000-8000-000000000009';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function rec(overrides = {}) {
  return {
    id: ID_A,
    userId: VET.id,
    status: 'completed',
    patientName: '',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    aiExtractedMetadata: null,
    submittedAt: '2026-07-29T11:00:00.000Z',
    updatedAt: '2026-07-29T11:00:00.000Z',
    ...overrides,
  };
}

function derive(rows, user = VET, opts = {}) {
  return FEED.deriveRecordingAttention(Array.isArray(rows) ? rows : [rows], user, {
    nowMs: NOW,
    recordFirstEnabled: true,
    ...opts,
  });
}

function reasonCodes(item) {
  return item.reasons.map((reason) => reason.code);
}

// ─── Tier 1: AI metadata ───────────────────────────────────────────────────

test('already_filled alone produces NO item', () => {
  const r = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: [
        { field: 'patientName', reason: 'already_filled' },
        { field: 'species', reason: 'already_filled' },
      ],
    },
  });
  assert.deepEqual(plain(derive(r).items), []);
});

test("review:'none' with low_confidence drops STILL produces an item", () => {
  // The blindness this feed exists to fix: the server sets review to
  // 'unconfirmed' only when something was applied / multi-patient / conflict,
  // so an all-demoted extraction gets review:'none' and no card anywhere.
  const r = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'none',
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence', score: 0.42 }],
    },
  });
  const { items } = derive(r);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_low_confidence');
  assert.equal(items[0].primaryField, 'breed');
  assert.equal(items[0].body, COPY.lowConfidenceWithValue('Breed', 'Golden Retriever'));
});

test('a historical blob with ABSENT review state still surfaces applied/conflict signals', () => {
  const applied = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: { appliedFields: ['patientName', 'species'] },
  });
  const conflict = rec({
    id: ID_C,
    species: 'Canine',
    aiExtractedMetadata: {
      dropReasons: [{ field: 'species', reason: 'conflicts_with_existing' }],
    },
  });
  assert.equal(derive(applied).items[0].primaryReason, 'metadata_confirm');
  assert.equal(derive(conflict).items[0].primaryReason, 'metadata_conflict');
});

test("an explicit review:'unconfirmed' blob with no recoverable reason gets the generic confirm fallback", () => {
  const r = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: ['not_a_field'],
      dropReasons: [{ field: 'nope', reason: 'invented' }],
    },
  });
  const { items } = derive(r);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_confirm');
  assert.equal(items[0].body, COPY.confirmFallback);
});

test('confirmed / dismissed suppress the SAME drop reason (historical drops persist server-side)', () => {
  for (const review of ['confirmed', 'dismissed']) {
    const r = rec({
      aiExtractedMetadata: {
        review,
        appliedFields: [],
        fields: { breed: { value: 'Golden Retriever' } },
        dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
      },
    });
    assert.deepEqual(plain(derive(r).items), [], `review=${review} must suppress`);
  }
});

test('null extraction + blank patient name produces metadata_missing, and clears once details are added', () => {
  const blank = rec({ patientName: '', aiExtractedMetadata: null });
  const { items } = derive(blank);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_missing');
  assert.equal(items[0].body, COPY.missingDetails);

  const filled = rec({ patientName: 'Bella', aiExtractedMetadata: null });
  assert.deepEqual(plain(derive(filled).items), []);
});

test('capability-off suppresses ONLY the ambiguous null-blob inference', () => {
  const nullBlob = rec({ patientName: '', aiExtractedMetadata: null });
  assert.deepEqual(
    plain(derive(nullBlob, VET, { recordFirstEnabled: false }).items),
    [],
    'null-metadata origin is unknowable without the capability'
  );

  const explicit = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  const { items } = derive(explicit, VET, { recordFirstEnabled: false });
  assert.equal(items.length, 1, 'an explicit AI blob stays reviewable after record-first is disabled');
  assert.equal(items[0].primaryReason, 'metadata_low_confidence');
});

test('suggested values come from fields[].value, tolerate null, and NEVER from the drop reason', () => {
  const fromFields = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  assert.equal(
    derive(fromFields).items[0].body,
    COPY.lowConfidenceWithValue('Breed', 'Golden Retriever')
  );

  const nullValue = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: null } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  assert.equal(derive(nullValue).items[0].body, COPY.lowConfidenceGeneric('Breed'));

  const phiInDrop = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: [
        { field: 'breed', reason: 'low_confidence', suggestedValue: 'Golden Retriever', value: 'Golden Retriever' },
      ],
    },
  });
  const body = derive(phiInDrop).items[0].body;
  assert.equal(body, COPY.lowConfidenceGeneric('Breed'));
  assert.ok(!body.includes('Golden Retriever'), 'a PHI-bearing legacy drop key must be discarded');
});

test('conflict / not-verbatim reasons survive a missing extracted value with GENERIC copy', () => {
  const conflict = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: { dropReasons: [{ field: 'species', reason: 'conflicts_with_existing' }] },
  });
  assert.equal(derive(conflict).items[0].body, COPY.conflictGeneric('Species'));

  const conflictWithValue = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: {
      fields: { species: { value: 'Feline' } },
      dropReasons: [{ field: 'species', reason: 'conflicts_with_existing' }],
    },
  });
  assert.equal(
    derive(conflictWithValue).items[0].body,
    COPY.conflictWithValues('Species', 'Canine', 'Feline')
  );

  // Blank patient name + an unusable not-verbatim hit is BOTH "name not
  // confirmable" and "details missing"; the row keeps both reasons and ranks by
  // the higher-priority one.
  const notVerbatim = rec({
    aiExtractedMetadata: { dropReasons: [{ field: 'patientName', reason: 'not_verbatim' }] },
  });
  const notVerbatimItem = derive(notVerbatim).items[0];
  assert.equal(notVerbatimItem.primaryReason, 'metadata_missing');
  assert.deepEqual(plain(reasonCodes(notVerbatimItem)), ['metadata_missing', 'metadata_not_verbatim']);
  assert.equal(
    notVerbatimItem.reasons.find((r) => r.code === 'metadata_not_verbatim').message,
    COPY.notVerbatimPatientName
  );

  // With a patient name present the not-verbatim reason stands alone.
  const namedNotVerbatim = rec({
    patientName: 'Bella',
    aiExtractedMetadata: { dropReasons: [{ field: 'patientName', reason: 'not_verbatim' }] },
  });
  assert.equal(derive(namedNotVerbatim).items[0].body, COPY.notVerbatimPatientName);
});

test('array and legacy record drop shapes derive identical rows', () => {
  const arrayShape = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  const recordShape = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: { breed: 'low_confidence' },
    },
  });
  assert.deepEqual(plain(derive(arrayShape).items), plain(derive(recordShape).items));
});

test('a pre-C7 unresolved suggestion with NO drop reasons gets the unclassified fallback', () => {
  const preC7 = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
    },
  });
  const { items } = derive(preC7);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_suggestion_unclassified');
  assert.equal(items[0].body, COPY.unclassifiedSuggestion('Breed', 'Golden Retriever'));
});

test('a suggestion WITH a known reason does not also get the unclassified fallback', () => {
  const r = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  assert.deepEqual(plain(reasonCodes(derive(r).items[0])), ['metadata_low_confidence']);
});

test('the PRODUCTION multi-patient shape raises no alert (review:unconfirmed included)', () => {
  // Codex round 8, and the most important miss of the whole review: Connect sets
  // `review: 'unconfirmed'` when `appliedFields.length > 0 || multiplePatientsDetected
  // || hasConflict`, so the real payload for a multi-patient-only recording
  // ARRIVES with that flag. The generic confirm fallback then resurrected the
  // suppressed alert as `metadata_confirm` — the owner's removal did not hold in
  // production, only in a fixture that omitted `review`.
  const production = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      multiplePatientsDetected: true,
      appliedFields: [],
    },
  });
  assert.equal(derive(production).items.length, 0, 'no alert on the production shape');

  // The same via the drop-reason spelling.
  const viaDrop = rec({
    id: ID_B,
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: [],
      dropReasons: [{ field: 'species', reason: 'multi_patient' }],
    },
  });
  assert.equal(derive(viaDrop).items.length, 0);

  // The fallback still fires when something OTHER than multi-patient set the flag.
  const genuinelyUnrecoverable = rec({
    id: ID_C,
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: ['not_a_field'],
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  const { items } = derive(genuinelyUnrecoverable);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_low_confidence');
});

test('the detail review predicate agrees: multi-patient-only opens no review card', async () => {
  // Otherwise the card renders with an EMPTY reason list.
  const OBS = await loadTsModule('src/lib/recordFirstObservability.ts');
  const production = rec({
    patientName: 'Bella',
    aiExtractedMetadata: { review: 'unconfirmed', multiplePatientsDetected: true, appliedFields: [] },
  });
  assert.equal(OBS.hasUnresolvedAiMetadataAttention(production), false);
  // …but a real signal alongside it still opens the card.
  const withConflict = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      multiplePatientsDetected: true,
      appliedFields: [],
      fields: { species: { value: 'Feline' } },
      dropReasons: [{ field: 'species', reason: 'conflicts_with_existing' }],
    },
  });
  assert.equal(OBS.hasUnresolvedAiMetadataAttention(withConflict), true);
});

test('a quality-warning list longer than the scan window cannot read as clean', () => {
  // Codex round 8: the projection capped at 20 BEFORE derivation, so if the first
  // 20 normalized to empty while a real warning sat in the tail, the row emitted
  // no item and still counted as fully classified.
  const many = Array.from({ length: 25 }, (_, i) => (i < 20 ? '   ' : 'Audio was very quiet'));
  const projected = FEED.projectAttentionRecording(
    rec({ patientName: 'Bella', status: 'completed', qualityWarnings: many })
  );
  assert.equal(projected.qualityWarningsTruncated, true);
  assert.equal(projected.qualityWarningsTotal, 25);

  const derived = derive(projected);
  assert.equal(derived.items.length, 0, 'no fabricated row from the unscanned tail');
  assert.equal(derived.classificationComplete, false, 'but it is NOT clean either');
  assert.equal(derived.uncheckableMetadataRowCount, 1);

  // A truncated list whose scanned window DOES yield a warning reports the
  // server's total, not the scanned count.
  const usable = Array.from({ length: 25 }, () => 'Audio was very quiet');
  const p2 = FEED.projectAttentionRecording(
    rec({ patientName: 'Bella', status: 'completed', qualityWarnings: usable })
  );
  const d2 = derive(p2);
  assert.equal(d2.items.length, 1);
  assert.equal(d2.items[0].warningCount, 25, 'reports the server total, not the 20-item cap');
});

test('multi-patient raises NO alert, and does not resurface as an unclassified suggestion', () => {
  // Owner decision 2026-07-29: discussing several patients in one visit is
  // routine, so this is not an attention item on any surface. The signal must
  // still SUPPRESS the AI's unreliable per-field suggestions — otherwise
  // removing the alert would just replace it with a suggestion row per field.
  const r = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      multiplePatientsDetected: true,
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' }, species: { value: 'Canine' } },
    },
  });
  assert.equal(derive(r).items.length, 0, 'a multi-patient-only row produces no item at all');

  // Same via the drop-reason spelling of the signal.
  const viaDropReason = rec({
    id: ID_B,
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: [{ field: 'species', reason: 'multi_patient' }],
      fields: { species: { value: 'Canine' } },
    },
  });
  assert.equal(derive(viaDropReason).items.length, 0);

  // The vocabulary itself no longer carries the code.
  assert.ok(!FEED.ATTENTION_REASON_PRIORITY.includes('multiple_patients'));
  assert.equal(FEED.ATTENTION_CATEGORY_BY_REASON.multiple_patients, undefined);
  assert.equal(COPY.multiplePatients, undefined);
});

test('a multi-patient row with OTHER signals still appears, with the next reason promoted', () => {
  const r = rec({
    patientName: 'Bella',
    species: 'Canine',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      multiplePatientsDetected: true,
      appliedFields: ['patientName'],
      fields: { species: { value: 'Feline' } },
      dropReasons: [
        { field: 'species', reason: 'conflicts_with_existing' },
        { field: 'breed', reason: 'low_confidence' },
      ],
    },
  });
  const { items } = derive(r, OWNER);
  assert.equal(items.length, 1, 'one row per server recording');
  assert.equal(items[0].primaryReason, 'metadata_conflict');
  assert.deepEqual(plain(reasonCodes(items[0])), [
    'metadata_conflict',
    'metadata_confirm',
    'metadata_low_confidence',
  ]);
  assert.equal(items[0].extraIssueCount, 2);
});

test('reason order is payload-order independent and field-ordered within a code', () => {
  const build = (dropReasons) =>
    rec({
      patientName: 'Bella',
      aiExtractedMetadata: {
        appliedFields: [],
        dropReasons,
      },
    });
  const forward = derive(
    build([
      { field: 'appointmentType', reason: 'low_confidence' },
      { field: 'clientName', reason: 'low_confidence' },
      { field: 'patientName', reason: 'not_verbatim' },
    ]),
    OWNER
  ).items[0];
  const reversed = derive(
    build([
      { field: 'patientName', reason: 'not_verbatim' },
      { field: 'clientName', reason: 'low_confidence' },
      { field: 'appointmentType', reason: 'low_confidence' },
    ]),
    OWNER
  ).items[0];
  assert.deepEqual(plain(forward.reasons), plain(reversed.reasons));
  assert.deepEqual(
    plain(forward.reasons.map((r) => `${r.code}:${r.field}`)),
    [
      'metadata_low_confidence:clientName',
      'metadata_low_confidence:appointmentType',
      'metadata_not_verbatim:patientName',
    ]
  );
});

test('invalid / duplicate applied fields do not inflate the confirmed count', () => {
  const r = rec({
    patientName: 'Bella',
    species: 'Canine',
    breed: '',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: ['patientName', 'patientName', 'species', 'breed', 'bogus'],
    },
  });
  const { items } = derive(r, OWNER);
  assert.equal(items[0].body, COPY.confirmWithCount(2, 'Bella'));
});

test('a corrupt oversized payload yields bounded, deterministic reasons and a stable key', () => {
  const dropReasons = [];
  for (let i = 0; i < 4000; i++) {
    dropReasons.push({ field: 'breed', reason: 'low_confidence' });
    dropReasons.push({ field: 'clientName', reason: 'not_verbatim' });
  }
  const longValue = 'x'.repeat(5000);
  const r = rec({
    patientName: 'Bella',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { breed: { value: longValue } },
      dropReasons,
    },
  });
  const { items } = derive(r, OWNER);
  assert.equal(items.length, 1);
  assert.ok(items[0].reasons.length <= 30, 'reasons stay inside the finite (field, reason) vocabulary');
  assert.equal(items[0].key, `recording:${ID_A}`);
  assert.ok(items[0].body.length < 200, 'a legacy overlong value is bounded before it reaches copy');
});

// ─── Tier 2: status, timing, quality ───────────────────────────────────────

test('failed and retry_scheduled rows use generic copy and rank above stuck processing', () => {
  const failed = rec({ id: ID_A, status: 'failed' });
  const retry = rec({ id: ID_B, status: 'retry_scheduled' });
  const stuck = rec({
    id: ID_C,
    status: 'uploaded',
    updatedAt: new Date(NOW - 10 * MINUTE).toISOString(),
  });
  const { items } = derive([stuck, retry, failed], OWNER);
  const sorted = [...items].sort(FEED.compareAttentionItems);
  assert.deepEqual(plain(sorted.map((i) => i.primaryReason)), [
    'recording_failed',
    'retry_scheduled',
    'stuck_processing',
  ]);
  assert.equal(sorted[0].body, COPY.recordingFailed);
});

test('stuck thresholds are 5 min uploaded, 35 min uploading, 20 min active processing', () => {
  const at = (status, minutesAgo) =>
    rec({ status, updatedAt: new Date(NOW - minutesAgo * MINUTE).toISOString() });

  assert.equal(derive(at('uploaded', 4.9), OWNER).items.length, 0);
  assert.equal(derive(at('uploaded', 5), OWNER).items.length, 1);

  assert.equal(derive(at('uploading', 34), OWNER).items.length, 0);
  assert.equal(derive(at('uploading', 35), OWNER).items.length, 1);

  for (const status of ['transcribing', 'transcribed', 'generating']) {
    assert.equal(derive(at(status, 19), OWNER).items.length, 0, `${status} 19min`);
    assert.equal(derive(at(status, 20), OWNER).items.length, 1, `${status} 20min`);
  }

  // The exact audio-aware helper the detail screen uses.
  assert.equal(FEED.stuckThresholdMs('uploading', 'known_present'), FEED.STUCK_UPLOADED_MS);
  assert.equal(FEED.stuckThresholdMs('uploading', 'unknown'), FEED.STUCK_UPLOADING_MS);
  assert.equal(FEED.stuckThresholdMs('completed', 'unknown'), null);
});

test('invalid or future updatedAt never becomes stuck, and marks classification partial', () => {
  const invalid = rec({ status: 'uploaded', updatedAt: 'not-a-date' });
  const future = rec({ status: 'uploaded', updatedAt: new Date(NOW + 5 * MINUTE).toISOString() });
  for (const row of [invalid, future]) {
    const result = derive(row, OWNER);
    assert.deepEqual(plain(result.items), []);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.uncheckableTimingRowCount, 1);
  }
});

test('an invalid timestamp on a failed row keeps its deterministic signal complete', () => {
  const result = derive(rec({ status: 'failed', updatedAt: 'nope', submittedAt: 'nope' }), OWNER);
  assert.equal(result.items.length, 1);
  assert.equal(result.classificationComplete, true);
  assert.equal(result.uncheckableTimingRowCount, 0);
});

test('an invalid submittedAt on a clean completed row does not block metadata classification', () => {
  const result = derive(
    rec({
      submittedAt: null,
      aiExtractedMetadata: {
        appliedFields: [],
        fields: { breed: { value: 'Golden Retriever' } },
        dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
      },
    }),
    OWNER
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.classificationComplete, true);
});

test('pending_metadata does not masquerade as a retry or stuck item', () => {
  const r = rec({
    status: 'pending_metadata',
    updatedAt: new Date(NOW - 5 * DAY).toISOString(),
  });
  const result = derive(r, OWNER);
  assert.deepEqual(plain(result.items), []);
  assert.equal(result.classificationComplete, true);
});

test('draft rows are not derived (the list fetches them separately)', () => {
  const r = rec({ status: 'draft', updatedAt: new Date(NOW - 5 * DAY).toISOString() });
  assert.deepEqual(plain(derive(r, OWNER).items), []);
});

test('quality warnings show only for completed rows aged [0, 7 days]', () => {
  const withWarnings = (submittedAt) =>
    rec({
      patientName: 'Bella',
      qualityWarnings: ['Background noise made part of the audio hard to hear.', 'Second warning.'],
      submittedAt,
      aiExtractedMetadata: { review: 'confirmed' },
    });

  const fresh = derive(withWarnings(new Date(NOW - 2 * DAY).toISOString()), OWNER);
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.items[0].primaryReason, 'quality_warning');
  assert.equal(fresh.items[0].warningCount, 2);
  assert.equal(fresh.items[0].body, 'Background noise made part of the audio hard to hear.');
  assert.equal(fresh.items[0].reasons.length, 1, 'extra warnings are NOT inflated into reasons[]');

  const old = derive(withWarnings(new Date(NOW - 8 * DAY).toISOString()), OWNER);
  assert.deepEqual(plain(old.items), []);
  assert.equal(old.classificationComplete, true, 'an aged-out warning is a decided result');

  for (const bad of [null, 'nonsense', new Date(NOW + DAY).toISOString()]) {
    const result = derive(withWarnings(bad), OWNER);
    assert.deepEqual(plain(result.items), [], `submittedAt=${bad}`);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.uncheckableTimingRowCount, 1);
  }
});

test('quality warning copy is whitespace-collapsed and length bounded', () => {
  const r = rec({
    patientName: 'Bella',
    qualityWarnings: [`line one\nline two ${'y'.repeat(500)}`],
    submittedAt: new Date(NOW - DAY).toISOString(),
    aiExtractedMetadata: { review: 'confirmed' },
  });
  const item = derive(r, OWNER).items[0];
  assert.ok(!item.body.includes('\n'));
  assert.equal(item.body.length, FEED.QUALITY_WARNING_MAX_LENGTH);
});

test('a metadata row and a quality row on the SAME recording collapse into one ranked row', () => {
  const r = rec({
    patientName: 'Bella',
    qualityWarnings: ['Background noise made part of the audio hard to hear.'],
    submittedAt: new Date(NOW - DAY).toISOString(),
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: ['patientName'],
    },
  });
  const { items } = derive(r, OWNER);
  assert.equal(items.length, 1);
  assert.equal(items[0].primaryReason, 'metadata_confirm');
  assert.deepEqual(plain(reasonCodes(items[0])), ['metadata_confirm', 'quality_warning']);
  assert.equal(items[0].extraIssueCount, 1);
  assert.equal(items[0].category, 'metadata');
});

test('raw failure fields cannot enter the item, its copy, or its reasons', () => {
  const r = {
    ...rec({ status: 'failed' }),
    errorMessage: 'TypeError: cannot read property of undefined at Patient Bella',
    errorCode: 'SOME_LEGACY_CODE',
    audioFileUrl: 'https://example.invalid/audio.m4a',
    processingStartedAt: '2026-07-29T10:00:00.000Z',
  };
  const item = derive(r, OWNER).items[0];
  const serialized = JSON.stringify(item);
  assert.ok(!serialized.includes('TypeError'));
  assert.ok(!serialized.includes('SOME_LEGACY_CODE'));
  assert.ok(!serialized.includes('example.invalid'));
  assert.equal(item.body, COPY.recordingFailed);
});

// ─── Actionability ─────────────────────────────────────────────────────────

test("a colleague's metadata is read-only for a veterinarian but their retryable row is not", () => {
  const colleagueMetadata = rec({
    userId: OTHER_USER,
    patientName: 'Bella',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  const metadataItem = derive(colleagueMetadata, VET).items[0];
  assert.equal(metadataItem.actionable, false);
  assert.equal(metadataItem.ctaLabel, null);
  assert.equal(metadataItem.destination.focus, null, 'read-only rows never focus a mutation card');
  assert.ok(metadataItem.accessibilityLabel.includes(COPY.readOnlyNote));

  const colleagueFailed = rec({ userId: OTHER_USER, status: 'failed' });
  const failedItem = derive(colleagueFailed, VET).items[0];
  assert.equal(failedItem.actionable, true, 'retry is org-scoped for owner/admin/veterinarian');
  assert.equal(failedItem.ctaLabel, COPY.ctaOpenRecording);
  assert.equal(failedItem.destination.focus, 'processing');
});

test('support staff can act on neither metadata nor processing rows', () => {
  const metadata = rec({
    aiExtractedMetadata: { review: 'unconfirmed', appliedFields: ['patientName'] },
    patientName: 'Bella',
  });
  const failed = rec({ id: ID_B, status: 'failed' });
  const { items } = derive([metadata, failed], SUPPORT);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.actionable === false));
  assert.ok(items.every((item) => item.ctaLabel === null));
});

test('owner and admin may act on any recording in the practice', () => {
  const r = rec({
    userId: OTHER_USER,
    patientName: 'Bella',
    aiExtractedMetadata: { review: 'unconfirmed', appliedFields: ['patientName'] },
  });
  for (const user of [OWNER, ADMIN]) {
    const item = derive(r, user).items[0];
    assert.equal(item.actionable, true, user.role);
    assert.equal(item.ctaLabel, COPY.ctaReviewDetails);
    assert.equal(item.destination.focus, 'metadata');
  }
});

test('a signed-out viewer gets read-only rows, never a fix CTA', () => {
  const r = rec({ status: 'failed' });
  const item = derive(r, null).items[0];
  assert.equal(item.actionable, false);
  assert.equal(item.ctaLabel, null);
});

// ─── Ordering, grouping, local rows ────────────────────────────────────────

test('tie-breaking is stable and independent of input order', () => {
  const same = (id, submittedAt) =>
    rec({ id, status: 'failed', submittedAt, updatedAt: '2026-07-29T11:00:00.000Z' });
  const rows = [
    same(ID_C, '2026-07-29T10:00:00.000Z'),
    same(ID_A, '2026-07-29T10:00:00.000Z'),
    same(ID_B, '2026-07-29T11:00:00.000Z'),
  ];
  const forward = plain(
    derive(rows, OWNER).items.sort(FEED.compareAttentionItems).map((i) => i.recordingId)
  );
  const reversed = plain(
    derive([...rows].reverse(), OWNER)
      .items.sort(FEED.compareAttentionItems)
      .map((i) => i.recordingId)
  );
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, [ID_B, ID_A, ID_C]);
});

test('rows with a valid submittedAt sort ahead of rows without one', () => {
  const withDate = rec({ id: ID_A, status: 'failed', submittedAt: '2026-07-01T00:00:00.000Z' });
  const withoutDate = rec({ id: ID_B, status: 'failed', submittedAt: null });
  const sorted = plain(
    derive([withoutDate, withDate], OWNER)
      .items.sort(FEED.compareAttentionItems)
      .map((i) => i.recordingId)
  );
  assert.deepEqual(sorted, [ID_A, ID_B]);
});

test('local synthetic rows participate at their explicit ranks, never jumping a failed recording', () => {
  const failed = rec({ status: 'failed' });
  const server = derive(failed, VET).items;
  const local = FEED.buildLocalAttentionItems(
    { draftCount: 2, stashSessionCount: 1, draftsKnown: true, stashesKnown: true },
    VET
  );
  const all = [...server, ...local].sort(FEED.compareAttentionItems);
  assert.deepEqual(plain(all.map((i) => i.primaryReason)), [
    'recording_failed',
    'local_drafts',
    'local_saved_sessions',
  ]);
  assert.equal(local[0].key, `local:${VET.id}:local_drafts`);
  assert.equal(local[1].key, `local:${VET.id}:local_saved_sessions`);
  assert.equal(local[0].destination.kind, 'recordings_list');
  assert.equal(local[1].destination.kind, 'record_tab');
});

test('an unknown local source contributes NO row (never a false zero, never a false row)', () => {
  const unknown = FEED.buildLocalAttentionItems(
    { draftCount: 0, stashSessionCount: 0, draftsKnown: false, stashesKnown: false },
    VET
  );
  assert.deepEqual(plain(unknown), []);
  assert.equal(FEED.isUnsentWorkSummaryKnown({ draftsKnown: true, stashesKnown: false }), false);
  assert.equal(FEED.isUnsentWorkSummaryKnown({ draftsKnown: true, stashesKnown: true }), true);
});

test('support staff keep the local data-loss warning but get NO link, never Resume', () => {
  // Codex round 6: `/recording-recovery` is gated on canRecordAppointments, so it
  // renders "Recovery Not Available" for exactly this cohort, and their current
  // work is not in the owner/admin/vet vault until sign-out preservation runs —
  // so any destination was a dead end. The warning stays; the tap does not.
  const local = FEED.buildLocalAttentionItems(
    { draftCount: 1, stashSessionCount: 1, draftsKnown: true, stashesKnown: true },
    SUPPORT
  );
  assert.equal(local.length, 2);
  for (const item of local) {
    assert.equal(item.actionable, true, 'stays in Needs you — it is this account’s data');
    assert.equal(item.destination.kind, 'informational');
    assert.equal(item.ctaLabel, null, 'no CTA that would dead-end');
    // The body still names who can act on it.
    assert.ok(item.body.includes(COPY.localSupportStaffNote));
  }

  // A submitting role still gets its real routes.
  const vetLocal = FEED.buildLocalAttentionItems(
    { draftCount: 1, stashSessionCount: 1, draftsKnown: true, stashesKnown: true },
    VET
  );
  assert.deepEqual(
    plain(vetLocal.map((item) => item.destination.kind)).sort(),
    ['record_tab', 'recordings_list']
  );
  assert.ok(vetLocal.every((item) => item.ctaLabel));
});

test('an informational row renders without a tap target or chevron', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  assert.match(section, /const isInformational = item\.destination\.kind === 'informational';/);
  assert.match(section, /showChevron=\{!isInformational\}/);
  // `ListItem` renders a plain View when onPress is undefined.
  assert.match(section, /onPress=\{\s*\n\s*isInformational\s*\n\s*\? undefined/);
});

test('groupAttentionItems splits by actionability without dropping practice-wide rows', () => {
  const mine = rec({ id: ID_A, userId: VET.id, status: 'failed' });
  const theirs = rec({
    id: ID_B,
    userId: OTHER_USER,
    aiExtractedMetadata: { review: 'unconfirmed', appliedFields: ['patientName'] },
    patientName: 'Bella',
  });
  const { items } = derive([mine, theirs], VET);
  const groups = FEED.groupAttentionItems(items);
  assert.equal(groups.needsYou.length, 1);
  assert.equal(groups.acrossPractice.length, 1);
  assert.equal(groups.needsYou[0].recordingId, ID_A);
  assert.equal(groups.acrossPractice[0].recordingId, ID_B);
});

test('topReasonCode reports the closed vocabulary, or none', () => {
  assert.equal(FEED.topReasonCode([]), 'none');
  const { items } = derive(rec({ status: 'failed' }), OWNER);
  assert.equal(FEED.topReasonCode(items), 'recording_failed');
});

// ─── Projection / validation ───────────────────────────────────────────────

test('projectAttentionRecording keeps ONLY the narrow list fields', () => {
  const projected = FEED.projectAttentionRecording({
    ...rec({ status: 'failed' }),
    errorMessage: 'boom',
    errorCode: 'BOOM',
    audioFileUrl: 'https://example.invalid/a.m4a',
    processingStartedAt: '2026-07-29T00:00:00.000Z',
    transcriptText: 'clinical text',
    needsMetadataReview: true,
  });
  assert.deepEqual(plain(Object.keys(projected).sort()), [
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
});

test('projection rejects structurally unusable rows', () => {
  assert.equal(FEED.projectAttentionRecording(null), null);
  assert.equal(FEED.projectAttentionRecording([]), null);
  assert.equal(FEED.projectAttentionRecording({ ...rec(), status: 'weird' }), null);
  assert.equal(FEED.projectAttentionRecording({ ...rec(), patientName: 42 }), null);
  assert.equal(FEED.projectAttentionRecording({ ...rec(), qualityWarnings: [1] }), null);
  assert.equal(FEED.projectAttentionRecording({ ...rec(), aiExtractedMetadata: [] }), null);
  assert.equal(FEED.projectAttentionRecording({ ...rec(), updatedAt: '' }), null);
});

test('list-row validation additionally enforces UUID ids and server length bounds', () => {
  assert.ok(FEED.validateAttentionListRow(rec()));
  assert.equal(FEED.validateAttentionListRow({ ...rec(), id: '../../evil' }), null);
  assert.equal(FEED.validateAttentionListRow({ ...rec(), userId: 'not-a-uuid' }), null);
  assert.equal(FEED.validateAttentionListRow({ ...rec(), species: 'x'.repeat(51) }), null);
  assert.ok(FEED.validateAttentionListRow({ ...rec(), species: 'x'.repeat(50) }));
  assert.equal(FEED.validateAttentionListRow({ ...rec(), patientName: 'x'.repeat(101) }), null);
});

test('focus route values are allowlisted', () => {
  assert.equal(FEED.parseAttentionFocus('metadata'), 'metadata');
  assert.equal(FEED.parseAttentionFocus('processing'), 'processing');
  assert.equal(FEED.parseAttentionFocus('quality'), 'quality');
  assert.equal(FEED.parseAttentionFocus('delete'), null);
  assert.equal(FEED.parseAttentionFocus(undefined), null);
});

// ─── Timer/poll gating helpers ─────────────────────────────────────────────

test('poll + tick gating uses only pollable statuses and unexpired quality windows', () => {
  const processing = rec({ status: 'transcribing' });
  const clean = rec({ patientName: 'Bella', aiExtractedMetadata: { review: 'confirmed' } });
  const freshWarning = rec({
    patientName: 'Bella',
    qualityWarnings: ['Noisy.'],
    submittedAt: new Date(NOW - DAY).toISOString(),
    aiExtractedMetadata: { review: 'confirmed' },
  });
  const oldWarning = rec({
    patientName: 'Bella',
    qualityWarnings: ['Noisy.'],
    submittedAt: new Date(NOW - 30 * DAY).toISOString(),
    aiExtractedMetadata: { review: 'confirmed' },
  });
  const futureWarning = rec({
    patientName: 'Bella',
    qualityWarnings: ['Noisy.'],
    submittedAt: new Date(NOW + DAY).toISOString(),
    aiExtractedMetadata: { review: 'confirmed' },
  });

  assert.equal(FEED.hasPollableAttentionRow([processing]), true);
  assert.equal(FEED.hasPollableAttentionRow([clean, freshWarning]), false);
  assert.equal(FEED.hasPollableAttentionRow([rec({ status: 'pending_metadata' })]), false);

  assert.equal(FEED.hasPendingTimingBoundary([processing], NOW), true);
  assert.equal(FEED.hasPendingTimingBoundary([freshWarning], NOW), true);
  assert.equal(FEED.hasPendingTimingBoundary([futureWarning], NOW), true, 'clock skew can make it current');
  assert.equal(FEED.hasPendingTimingBoundary([oldWarning], NOW), false);
  assert.equal(FEED.hasPendingTimingBoundary([clean], NOW), false);
});

// ─── Source fences ─────────────────────────────────────────────────────────

test('the pure module has no React / fetch / timer / ambient-clock dependency', async () => {
  const raw = await read('src/lib/attentionFeed.ts');
  // Strip comments so a doc comment naming a banned API is not a false positive.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!src.includes("from 'react"), 'no react import');
  assert.ok(!src.includes("from 'react-native'"), 'no react-native import');
  assert.ok(!/\bfetch\(/.test(src), 'no fetch');
  assert.ok(!/setTimeout|setInterval/.test(src), 'no timers');
  assert.ok(!/Date\.now\(\)/.test(src), 'nowMs is always injected');
  // The list select omits these; the narrow row must not name them as inputs.
  for (const omitted of ['audioFileUrl', 'processingStartedAt', 'errorMessage', 'errorCode']) {
    assert.ok(
      !new RegExp(`(?:row|recording)\\.${omitted}\\b`).test(src),
      `${omitted} must not be read from a list row`
    );
  }
});

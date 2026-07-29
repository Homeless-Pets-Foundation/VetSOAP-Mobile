import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadTsModule(path) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireForVm,
  });
  return module.exports;
}

const OBS = await loadTsModule('src/lib/recordFirstObservability.ts');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Minimal Recording factory. The observability helpers only read status,
 * aiExtractedMetadata, needsMetadataReview, and the five metadata field values.
 */
function makeRecording(overrides = {}) {
  return {
    id: 'rec-1',
    status: 'completed',
    patientName: '',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    needsMetadataReview: false,
    aiExtractedMetadata: null,
    ...overrides,
  };
}

// ─── A1: ai_metadata_extraction_observed payload ────────────────────────────

test('A1: null-extraction record-first recording → had_metadata=false', () => {
  const rec = makeRecording({ aiExtractedMetadata: null });
  assert.equal(OBS.shouldEmitExtractionObserved(rec, true), true);
  const props = OBS.buildExtractionObservedProps(rec);
  assert.equal(props.had_metadata, false);
  assert.equal(props.applied_field_count, 0);
  assert.equal(props.suggested_field_count, 0);
  assert.equal(props.extracted_field_count, 0);
  assert.equal(props.multiple_patients_detected, false);
  assert.equal(props.needs_metadata_review, false);
  // All five fields blank at submit (none applied, all still blank).
  assert.equal(props.blank_field_count_at_submit, 5);
  assert.equal('drop_reasons_count' in props, false);
});

test('A1: suggestions-only → applied=0, suggested>0', () => {
  const rec = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {
        species: { value: 'Canine', confidence: 0.6 },
        breed: { value: 'Labrador', confidence: 0.5 },
      },
    },
  });
  const props = OBS.buildExtractionObservedProps(rec);
  assert.equal(props.had_metadata, true);
  assert.equal(props.applied_field_count, 0);
  assert.equal(props.suggested_field_count, 2);
  assert.equal(props.extracted_field_count, 2);
});

test('A1: happy path → applied counted, blank-at-submit only counts AI-filled+blank', () => {
  const rec = makeRecording({
    patientName: 'Buddy',
    species: 'Canine',
    // clientName entered manually at submit (filled, not applied) → not blank-at-submit
    clientName: 'Henderson',
    aiExtractedMetadata: {
      appliedFields: ['patientName', 'species'],
      fields: {
        patientName: { value: 'Buddy', confidence: 0.9 },
        species: { value: 'Canine', confidence: 0.9 },
      },
      multiplePatientsDetected: false,
    },
  });
  const props = OBS.buildExtractionObservedProps(rec);
  assert.equal(props.applied_field_count, 2);
  assert.equal(props.suggested_field_count, 0);
  // patientName+species applied (blank at submit) + breed+appointmentType still blank = 4.
  // clientName filled manually → NOT blank at submit.
  assert.equal(props.blank_field_count_at_submit, 4);
});

test('A1: multiple_patients_detected + needs_metadata_review pass through', () => {
  const rec = makeRecording({
    needsMetadataReview: true,
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { patientName: { value: 'Max' } },
      multiplePatientsDetected: true,
    },
  });
  const props = OBS.buildExtractionObservedProps(rec);
  assert.equal(props.multiple_patients_detected, true);
  assert.equal(props.needs_metadata_review, true);
});

test('A1: drop_reasons_count surfaced when server attaches C7 dropReasons', () => {
  const rec = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {},
      dropReasons: [
        { field: 'patientName', reason: 'low_confidence' },
        { field: 'species', reason: 'not_verbatim' },
      ],
    },
  });
  const props = OBS.buildExtractionObservedProps(rec);
  assert.equal(props.drop_reasons_count, 2);
});

test('A1: multi-patient safety block stays represented in product analytics', () => {
  const rec = makeRecording({
    patientName: '',
    needsMetadataReview: true,
    aiExtractedMetadata: {
      appliedFields: [],
      multiplePatientsDetected: true,
      fields: {
        patientName: { value: 'Patient A' },
        species: { value: 'Canine' },
      },
    },
  });

  const observed = OBS.buildExtractionObservedProps(rec);
  assert.equal(observed.multiple_patients_detected, true);
  assert.equal(observed.applied_field_count, 0);
  assert.equal(observed.extracted_field_count, 2);
});

// ─── Gating cases (A1 discriminator) ───────────────────────────────────────

test('GATE: non-record-first org → no observed event', () => {
  const rec = makeRecording({ patientName: '', aiExtractedMetadata: null });
  assert.equal(OBS.shouldEmitExtractionObserved(rec, false), false);
});

test('GATE: non-completed recording → no observed event', () => {
  const rec = makeRecording({ status: 'transcribing' });
  assert.equal(OBS.shouldEmitExtractionObserved(rec, true), false);
});

test('GATE: manually-filled record with null metadata still emits the observed product event', () => {
  const rec = makeRecording({ patientName: 'Rex', aiExtractedMetadata: null });
  assert.equal(OBS.shouldEmitExtractionObserved(rec, true), true);
});

test('GATE: null-extraction record-first emits even when review is not needed', () => {
  const rec = makeRecording({
    patientName: '',
    needsMetadataReview: false,
    aiExtractedMetadata: null,
  });
  assert.equal(OBS.shouldEmitExtractionObserved(rec, true), true);
  assert.equal(OBS.buildExtractionObservedProps(rec).had_metadata, false);
});

// ─── B5/B6: MetadataReviewCard helpers ──────────────────────────────────────

test('B6: suggestions = extracted − applied, blank-only, with non-empty value', () => {
  const rec = makeRecording({
    species: 'Feline', // already filled → not suggested even if extracted
    aiExtractedMetadata: {
      appliedFields: ['patientName'],
      fields: {
        patientName: { value: 'Buddy' }, // applied → excluded
        species: { value: 'Canine' }, // field already filled → excluded
        breed: { value: 'Labrador' }, // blank + extracted → suggested
        appointmentType: { value: '' }, // empty value → excluded
      },
    },
  });
  const suggestions = OBS.computeSuggestionFields(rec);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].field, 'breed');
  assert.equal(suggestions[0].value, 'Labrador');
});

test('B6: conflict suggestions can surface a filled field without auto-overwriting it', () => {
  const rec = makeRecording({
    species: 'Canine',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {
        species: { value: 'Feline' },
      },
      dropReasons: [
        { field: 'species', reason: 'conflicts_with_existing' },
      ],
    },
  });
  const suggestions = OBS.computeSuggestionFields(rec);
  assert.deepEqual(plain(suggestions), [
    { field: 'species', value: 'Feline', conflict: true, currentValue: 'Canine' },
  ]);
});

test('B6: filled fields still do not suggest without an explicit conflict reason', () => {
  const rec = makeRecording({
    species: 'Canine',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {
        species: { value: 'Feline' },
      },
      dropReasons: [
        { field: 'species', reason: 'already_filled' },
      ],
    },
  });
  assert.deepEqual(plain(OBS.computeSuggestionFields(rec)), []);
});

test('B6: a PHI-bearing value on a legacy DROP reason is discarded, not shown', () => {
  // The server drop-reason payload is `.strict()` — `{ field, reason, score? }`
  // only. A historical blob that smuggled a value key must NOT become a
  // suggestion: only `fields` (or the forward-compatible `conflicts[]` payload)
  // may supply an on-device value (attention-feed plan, pass 1).
  const rec = makeRecording({
    species: 'Canine',
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: {
        species: {
          field: 'species',
          reason: 'conflicts_with_existing',
          suggestedValue: 'Feline',
        },
      },
    },
  });
  assert.deepEqual(plain(OBS.computeSuggestionFields(rec)), []);
  // ...but the reason itself still normalizes, so the generic conflict signal survives.
  assert.deepEqual(plain(OBS.parseMetadataDropReasons(rec)), [
    { field: 'species', reason: 'conflicts_with_existing' },
  ]);
  assert.deepEqual(plain(OBS.computeMetadataAttentionSignals(rec).conflictFields), ['species']);
});

test('B6: the forward-compatible conflicts[] payload may still supply a value', () => {
  const rec = makeRecording({
    species: 'Canine',
    aiExtractedMetadata: {
      appliedFields: [],
      conflicts: [{ field: 'species', reason: 'conflicts_with_existing', suggestedValue: 'Feline' }],
    },
  });
  assert.deepEqual(plain(OBS.computeSuggestionFields(rec)), [
    { field: 'species', value: 'Feline', conflict: true, currentValue: 'Canine' },
  ]);
});

test('B6: array and legacy record drop-reason shapes normalize identically', () => {
  const arrayShape = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: [
        { field: 'breed', reason: 'low_confidence', score: 0.4 },
        { field: 'breed', reason: 'low_confidence', score: 0.4 },
        { field: 'patientName', reason: 'not_verbatim' },
        { field: 'nope', reason: 'low_confidence' },
        { field: 'species', reason: 'invented_reason' },
      ],
    },
  });
  const recordShape = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      dropReasons: {
        breed: { reason: 'low_confidence', score: 0.4 },
        patientName: 'not_verbatim',
        nope: 'low_confidence',
        species: 'invented_reason',
      },
    },
  });
  const expected = [
    { field: 'patientName', reason: 'not_verbatim' },
    { field: 'breed', reason: 'low_confidence', score: 0.4 },
  ];
  assert.deepEqual(plain(OBS.parseMetadataDropReasons(arrayShape)), expected);
  assert.deepEqual(plain(OBS.parseMetadataDropReasons(recordShape)), expected);
});

test('B6: a corrupt oversized drop payload stays bounded and deterministic', () => {
  const dropReasons = [];
  for (let i = 0; i < 5000; i++) {
    dropReasons.push({ field: 'breed', reason: 'low_confidence' });
  }
  const rec = makeRecording({ aiExtractedMetadata: { appliedFields: [], dropReasons } });
  const parsed = OBS.parseMetadataDropReasons(rec);
  assert.equal(parsed.length, 1);
  assert.ok(OBS.DROP_REASON_SCAN_LIMIT <= 60);
});

test('B6: tapping a suggestion applies its value (helper exposes value)', () => {
  const rec = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      fields: { clientName: { value: 'Henderson' } },
    },
  });
  const [s] = OBS.computeSuggestionFields(rec);
  assert.equal(s.field, 'clientName');
  assert.equal(s.value, 'Henderson');
});

test('B5: empty state shows for null extraction with blank patient name', () => {
  const rec = makeRecording({ patientName: '', aiExtractedMetadata: null });
  assert.equal(OBS.shouldShowNoExtractionEmptyState(rec), true);
});

test('B5: empty state hidden when suggestions exist', () => {
  const rec = makeRecording({
    patientName: '',
    aiExtractedMetadata: { appliedFields: [], fields: { species: { value: 'Canine' } } },
  });
  assert.equal(OBS.shouldShowNoExtractionEmptyState(rec), false);
});

test('B5: empty state hidden when something was applied', () => {
  const rec = makeRecording({
    patientName: '',
    // The applied field must actually be non-blank on the ROW — a server that
    // named an applied field it never populated must not suppress the
    // "couldn't read the details" state (attention-feed hardening).
    species: 'Canine',
    aiExtractedMetadata: { appliedFields: ['species'], fields: { species: { value: 'Canine' } } },
  });
  assert.equal(OBS.shouldShowNoExtractionEmptyState(rec), false);
});

test('B5: an applied field that left the row blank does NOT suppress the empty state', () => {
  const rec = makeRecording({
    patientName: '',
    species: null,
    aiExtractedMetadata: { appliedFields: ['species'], fields: {} },
  });
  assert.equal(OBS.shouldShowNoExtractionEmptyState(rec), true);
  assert.deepEqual(plain(OBS.validAppliedFields(rec)), []);
});

test('B5: empty state hidden when patient name already populated', () => {
  const rec = makeRecording({ patientName: 'Rex', aiExtractedMetadata: null });
  assert.equal(OBS.shouldShowNoExtractionEmptyState(rec), false);
});

// ─── Wiring assertions (component uses the pure helpers) ─────────────────────

test('WIRING: [id].tsx retains the observed product event without ai_extract telemetry', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /shouldEmitExtractionObserved/);
  assert.match(detail, /buildExtractionObservedProps/);
  assert.match(detail, /name: 'ai_metadata_extraction_observed'/);
  assert.doesNotMatch(detail, /phase: 'ai_extract'/);
  assert.doesNotMatch(detail, /shouldReportZeroFill|zeroFillErrorCode/);
  assert.match(detail, /extractionObservedIdsRef/);
});

test('WIRING: MetadataReviewCard uses suggestion + empty-state helpers', async () => {
  const card = await read('src/components/MetadataReviewCard.tsx');
  assert.match(card, /computeSuggestionFields/);
  assert.match(card, /shouldShowNoExtractionEmptyState/);
  assert.match(card, /applySuggestion/);
  assert.match(card, /conflictCurrent/);
  assert.match(card, /conflictSuggested/);
  assert.match(card, /addBodyNoExtraction/);
});

test('WIRING: analytics catalog + ErrorPhase include the new entries', async () => {
  const analytics = await read('src/lib/analytics.ts');
  assert.match(analytics, /ai_metadata_extraction_observed/);
  assert.match(analytics, /blank_field_count_at_submit: number/);
  assert.match(analytics, /\|\s*'ai_extract'/);
});

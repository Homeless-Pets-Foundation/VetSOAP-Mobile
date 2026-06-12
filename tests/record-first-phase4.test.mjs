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

test('record-first validation accepts blank metadata but still trims and bounds fields', async () => {
  const { createRecordingSchema } = await loadTsModule('src/lib/validation.ts');
  const parsed = createRecordingSchema.parse({
    patientName: '   ',
    clientName: '   ',
    species: '',
    breed: '',
    appointmentType: '',
  });

  assert.equal(parsed.patientName, '');
  assert.equal(parsed.clientName, undefined);
  assert.equal(parsed.species, undefined);
  assert.equal(parsed.breed, undefined);
  assert.equal(parsed.appointmentType, undefined);

  assert.throws(() => createRecordingSchema.parse({
    patientName: 'x'.repeat(101),
    clientName: '',
    species: '',
    appointmentType: '',
  }));
  assert.throws(() => createRecordingSchema.parse({
    patientName: '',
    appointmentType: 'House Call',
  }));
});

test('recording API normalizes create and draft metadata payloads before POST/PATCH', async () => {
  const source = await read('src/api/recordings.ts');
  assert.match(source, /export function normalizeCreateRecordingPayload/);
  assert.match(source, /export function normalizeDraftMetadataPayload/);
  assert.match(source, /payload\.patientName = typeof data\.patientName === 'string' \? data\.patientName : ''/);
  assert.match(source, /nullClearedOptional:\s*true/);
  assert.match(source, /payload\[key\] = null/);
  assert.match(source, /const payload = normalizeCreateRecordingPayload\(data\)/);
  assert.match(source, /updateDraftMetadata[\s\S]*normalizeDraftMetadataPayload\(data\)/);
});

test('record-first UI is fail-closed behind auth capability and removes both required gates', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(record, /user\?\.capabilities\?\.includes\('record_first'\)/);
  assert.match(record, /recording_started_blank_fields/);

  const slotCard = await read('src/components/PatientSlotCard.tsx');
  assert.match(slotCard, /recordFirstEnabled\?: boolean/);
  assert.match(slotCard, /slot\.formData\.species\?\.trim\(\)\.length/);
  assert.match(slotCard, /const canStartRecording = \(recordFirstEnabled \|\| hasRequiredFields\)/);
  assert.match(slotCard, /const showSubmitCard = \(recordFirstEnabled \|\| hasRequiredFields\)/);
  assert.match(slotCard, /Optional — AI will fill blanks from audio\./);

  const form = await read('src/components/PatientForm.tsx');
  assert.match(form, /required=\{!recordFirstEnabled\}/);
  assert.match(form, /allowDeselect=\{recordFirstEnabled\}/);
});

test('blank patient names render through display helper instead of stored placeholder text', async () => {
  const helper = await read('src/lib/recordingDisplay.ts');
  assert.match(helper, /UNTITLED_VISIT_LABEL/);
  assert.doesNotMatch(helper, /patientName:\s*['"]Untitled visit/);

  const card = await read('src/components/RecordingCard.tsx');
  assert.match(card, /displayPatientName\(recording\)/);
  assert.match(card, /isUntitledVisit\(recording\)/);

  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /displayPatientName\(recording\)/);
  assert.match(detail, /isUntitledVisit\(recording\)/);
});

test('metadata review flow is capability-gated and PHI-free in analytics', async () => {
  const types = await read('src/types/index.ts');
  assert.match(types, /capabilities\?: string\[\]/);
  assert.match(types, /aiExtractedMetadata\?: AiExtractedMetadata \| null/);

  const analytics = await read('src/lib/analytics.ts');
  assert.match(analytics, /ai_metadata_review_shown/);
  assert.match(analytics, /applied_field_count: number/);
  assert.match(analytics, /corrected_field_count: number/);
  assert.doesNotMatch(analytics, /patientName.*ai_metadata_review/);

  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /recordFirstEnabled[\s\S]*showMetadataReview/);
  assert.match(detail, /recordingsApi\.updateMetadata/);
  assert.match(detail, /<MetadataReviewCard/);
  assert.match(detail, /showHeaderPatientMetadataGlyph[\s\S]*appliedMetadataFields\.has\('patientName'\)/);
  assert.match(detail, /showHeaderPatientMetadataGlyph \? \([\s\S]*<Sparkles/);

  const reviewCard = await read('src/components/MetadataReviewCard.tsx');
  assert.match(reviewCard, /review: 'confirmed'/);
  assert.match(reviewCard, /correctedFieldCount/);
  assert.match(reviewCard, /SegmentedControl/);
});

test('record-first details disclosure ignores default template alone', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  const hasAnyPatientDetails = card.match(/const hasAnyPatientDetails =([\s\S]*?);/);

  assert.ok(hasAnyPatientDetails, 'hasAnyPatientDetails should exist');
  assert.doesNotMatch(hasAnyPatientDetails[1], /templateId/);
});

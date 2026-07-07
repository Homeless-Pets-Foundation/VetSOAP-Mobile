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
  assert.match(source, /function coerceNullClearsForDraftValidation\(data: Partial<CreateRecording>\): Partial<CreateRecording>/);
  assert.match(source, /source\[key\] === null/);
  assert.match(source, /createRecordingPartialSchema\.parse\(coerceNullClearsForDraftValidation\(data\)\)/);
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

test('record-first multi-patient flow warns once and prioritizes details without requiring them', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /MULTI_PATIENT_RECORD_FIRST_COPY/);
  assert.match(strings, /Add patient details first/);
  assert.match(strings, /Continue Recording First/);

  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(record, /multiPatientRecordFirstWarningShownRef/);
  assert.match(record, /recordFirstEnabled &&\s*sessionRef\.current\.slots\.length === 1/);
  assert.match(record, /Alert\.alert\(\s*MULTI_PATIENT_RECORD_FIRST_COPY\.title/);
  assert.match(record, /isCleanSinglePatientSession/);

  const slotCard = await read('src/components/PatientSlotCard.tsx');
  assert.match(slotCard, /const preferPatientDetailsFirst = recordFirstEnabled && totalSlots > 1/);
  assert.match(slotCard, /setDetailsExpanded\(true\)/);
  assert.match(slotCard, /recordFirstMultiPatient=\{preferPatientDetailsFirst\}/);
  assert.match(slotCard, /\(!recordFirstEnabled \|\| preferPatientDetailsFirst\) && formCard/);
  assert.match(slotCard, /recordFirstEnabled && !preferPatientDetailsFirst && formCard/);
  assert.match(slotCard, /const canStartRecording = \(recordFirstEnabled \|\| hasRequiredFields\)/);

  const form = await read('src/components/PatientForm.tsx');
  assert.match(form, /recordFirstMultiPatient\?: boolean/);
  assert.match(
    form,
    /recordFirstMultiPatient\s*\?\s*MULTI_PATIENT_RECORD_FIRST_COPY\.formHint\s*:\s*RECORD_FIRST_FORM_HINT/
  );
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
  assert.match(reviewCard, /mode: 'review' \| 'add' \| 'edit'/);
});

test('completed recordings keep an Edit Details affordance after metadata review', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /const showEditMetadata =/);
  assert.match(detail, /!showMetadataReview[\s\S]*!showAddMetadata[\s\S]*recording\.patientName/);
  assert.match(detail, /showEditMetadata && \([\s\S]*<MetadataReviewCard[\s\S]*mode="edit"/);

  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /editTitle: 'Patient details'/);
  assert.match(strings, /editBody: 'Edit patient details or add a PIMS Patient ID\.'/);
});

test('PIMS Patient ID linking invalidates patient query families', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const metadataMutation = detail.match(/const metadataMutation = useMutation\(\{[\s\S]*?\n  \}\);/);
  assert.ok(metadataMutation, 'metadata mutation should exist');
  assert.match(metadataMutation[0], /hasOwnProperty\.call\(\s*\n\s*vars\.payload\.fields \?\? \{\},\s*\n\s*'pimsPatientId'/);
  assert.match(metadataMutation[0], /updatedRecording\?\.patientId !== recording\?\.patientId/);
  assert.match(metadataMutation[0], /queryKey: \['patients'\]/);
  assert.match(metadataMutation[0], /queryKey: \['patient'\]/);
});

test('MetadataReviewCard surfaces PIMS Patient ID without polluting AI correctedCount', async () => {
  const reviewCard = await read('src/components/MetadataReviewCard.tsx');

  // Reuses the exact PatientForm label + placeholder.
  assert.match(reviewCard, /label="Patient ID \(optional\)"/);
  assert.match(reviewCard, /e\.g\., P-10042/);

  // Seeds from the flattened recording field and re-seeds after the save round-trip.
  assert.match(reviewCard, /recording\.pimsPatientId \?\? ''/);
  assert.match(reviewCard, /setPimsPatientId\(pimsSeed\)/);

  // pimsPatientId rides inside the payload fields map...
  const buildPayload = reviewCard.match(/function buildPayload\([\s\S]*?\n\}/);
  assert.ok(buildPayload, 'buildPayload should exist');
  assert.match(buildPayload[0], /pimsPatientId: trimOrNull\(pimsPatientId\)/);

  // ...but is excluded from the AI-only correctedCount.
  const correctedCount = reviewCard.match(/function correctedCount\([\s\S]*?\n\}/);
  assert.ok(correctedCount, 'correctedCount should exist');
  assert.doesNotMatch(correctedCount[0], /pimsPatientId/);

  // The payload type is widened to carry pimsPatientId outside the AI field union.
  const types = await read('src/types/index.ts');
  assert.match(
    types,
    /fields\?: Partial<Record<RecordingMetadataField, string \| null>> & \{ pimsPatientId\?: string \| null \}/
  );
});

test('record-first details disclosure ignores default template alone', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  const hasAnyPatientDetails = card.match(/const hasAnyPatientDetails =([\s\S]*?);/);

  assert.ok(hasAnyPatientDetails, 'hasAnyPatientDetails should exist');
  assert.doesNotMatch(hasAnyPatientDetails[1], /templateId/);
});

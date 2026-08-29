import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const {
  compareRecordingMetadata,
  hasIdentityDivergence,
  divergenceTier,
  isAdoptMetadataOrigin,
  METADATA_FIELD_TIERS,
  RecordingMetadataConflictError,
} = await loadTsModule('src/api/metadataIdentity.ts');

/** Cross-realm-safe view of a comparison result. */
const flat = (c) => ({
  identity: Array.from(c.identityFields).sort().join(','),
  processing: Array.from(c.processingFields).sort().join(','),
  descriptive: Array.from(c.descriptiveFields).sort().join(','),
  unknown: Array.from(c.unknownFields).sort().join(','),
});

const ENRICH = { allowServerEnrichedBlankFields: true };

test('an agreeing pair diverges in no tier', () => {
  const c = compareRecordingMetadata(
    { patientName: 'Bella', species: 'Canine', templateId: 't-1', foreignLanguage: false },
    { patientName: 'Bella', species: 'Canine', templateId: 't-1', foreignLanguage: false },
    ENRICH
  );
  assert.equal(divergenceTier(c), null);
  assert.equal(hasIdentityDivergence(c), false);
});

test("'' and null and undefined and whitespace all collapse to the same blank", () => {
  // A row written by an older client or the web app stores ''; the mobile
  // payload sends null. The server treats those as equal; the client used raw
  // !== and threw. This is a pure false-failure class.
  for (const [returned, submitted] of [
    ['', null],
    [null, ''],
    ['   ', null],
    [null, '   '],
    [undefined, null],
  ]) {
    const c = compareRecordingMetadata({ clientName: returned }, { clientName: submitted }, ENRICH);
    assert.equal(divergenceTier(c), null, `${JSON.stringify(returned)} vs ${JSON.stringify(submitted)}`);
  }
});

test('identity text compares case-insensitively, matching the server lookup', () => {
  // Connect resolves patients with mode: 'insensitive'. Being stricter than the
  // server here produces false failures, not safety.
  const c = compareRecordingMetadata(
    { patientName: 'bella', clientName: 'SMITH' },
    { patientName: 'Bella', clientName: 'Smith' },
    ENRICH
  );
  assert.equal(divergenceTier(c), null);
});

test('a genuinely different patient or client name is identity tier', () => {
  assert.equal(
    flat(compareRecordingMetadata({ patientName: 'Max' }, { patientName: 'Bella' }, ENRICH)).identity,
    'patientName'
  );
  assert.equal(
    flat(compareRecordingMetadata({ clientName: 'Jones' }, { clientName: 'Smith' }, ENRICH)).identity,
    'clientName'
  );
});

test('a blank we submitted that the server filled in is enrichment, not divergence', () => {
  const c = compareRecordingMetadata(
    { clientName: 'Smith', species: 'Canine' },
    { clientName: null, species: null },
    ENRICH
  );
  assert.equal(divergenceTier(c), null);
});

test('pimsPatientId is identity only when non-blank and different, or explicitly cleared', () => {
  // Non-blank vs a DIFFERENT non-blank: the genuine wrong-chart risk.
  assert.equal(
    flat(compareRecordingMetadata({ pimsPatientId: 'chart-B' }, { pimsPatientId: 'chart-A' }, ENRICH))
      .identity,
    'pimsPatientId'
  );
  // Blank and untouched, server enriched: ordinary enrichment.
  assert.equal(
    divergenceTier(compareRecordingMetadata({ pimsPatientId: 'chart-B' }, { pimsPatientId: null }, ENRICH)),
    null
  );
  // Explicitly cleared and the server kept a value: the client cannot tell
  // "the server declined the clear" from "different visit" without a human.
  assert.equal(
    flat(
      compareRecordingMetadata(
        { pimsPatientId: 'chart-B' },
        { pimsPatientId: null },
        { ...ENRICH, pimsPatientIdExplicitlyCleared: true }
      )
    ).identity,
    'pimsPatientId'
  );
});

test('templateId and foreignLanguage are processing tier and never identity', () => {
  const c = compareRecordingMetadata(
    { templateId: 't-server', foreignLanguage: true },
    { templateId: 't-local', foreignLanguage: false },
    ENRICH
  );
  assert.equal(flat(c).processing, 'foreignLanguage,templateId');
  assert.equal(hasIdentityDivergence(c), false);
  assert.equal(divergenceTier(c), 'processing');
});

test('a processing field is not silently swallowed by the enrichment hatch', () => {
  // templateId null -> server value is a real change to how the note is built,
  // unlike a descriptive blank the server filled in.
  const c = compareRecordingMetadata({ templateId: 't-server' }, { templateId: null }, ENRICH);
  assert.equal(flat(c).processing, 'templateId');
});

test('species, breed and appointmentType are descriptive and cannot mis-link a patient', () => {
  const c = compareRecordingMetadata(
    { species: 'Feline', breed: 'Siamese', appointmentType: 'Sick Visit' },
    { species: 'Canine', breed: 'Beagle', appointmentType: 'Wellness Exam' },
    ENRICH
  );
  assert.equal(flat(c).descriptive, 'appointmentType,breed,species');
  assert.equal(hasIdentityDivergence(c), false);
});

test('an absent pimsPatientId or non-identity key is unknown and never blocks', () => {
  // The flat pimsPatientId alias is emitted only when the Prisma patient
  // relation was loaded. Treating that absence as a mismatch let one serializer
  // regression brick every adopt.
  const c = compareRecordingMetadata(
    { patientName: 'Bella', clientName: 'Smith' },
    { patientName: 'Bella', clientName: 'Smith', pimsPatientId: null, templateId: null },
    ENRICH
  );
  assert.equal(flat(c).unknown, 'pimsPatientId,templateId');
  assert.equal(divergenceTier(c), null);
  assert.equal(hasIdentityDivergence(c), false);
});

test('an absent identity ANCHOR blocks instead of reading as benign', () => {
  // The tolerance above must not generalize. If an adopt response omits
  // patientName or clientName we cannot verify which patient the row belongs
  // to — and the adopt path is about to delete the only local copy.
  for (const missing of ['patientName', 'clientName']) {
    const recording = { patientName: 'Bella', clientName: 'Smith' };
    delete recording[missing];
    const c = compareRecordingMetadata(
      recording,
      { patientName: 'Bella', clientName: 'Smith' },
      ENRICH
    );
    assert.equal(flat(c).identity, missing, `${missing} absence must block`);
    assert.equal(hasIdentityDivergence(c), true);
    // Still reported as unknown too, so telemetry can tell absence from a
    // genuine value disagreement.
    assert.equal(flat(c).unknown, missing);
  }
});

test('identity wins the blocking decision when tiers are mixed, but all are reported', () => {
  const c = compareRecordingMetadata(
    { patientName: 'Max', templateId: 't-server', species: 'Feline' },
    { patientName: 'Bella', templateId: 't-local', species: 'Canine' },
    ENRICH
  );
  assert.equal(divergenceTier(c), 'identity');
  const f = flat(c);
  assert.equal(f.identity, 'patientName');
  assert.equal(f.processing, 'templateId');
  assert.equal(f.descriptive, 'species');
});

test('patientId is never compared', () => {
  // A server-derived surrogate the client has no authority over. Comparing it
  // would recreate the false-failure class this tiering removes.
  assert.equal(METADATA_FIELD_TIERS.patientId, undefined);
  const c = compareRecordingMetadata(
    { patientId: 'server-uuid', patientName: 'Bella' },
    { patientName: 'Bella' },
    ENRICH
  );
  assert.equal(divergenceTier(c), null);
});

test('every tiered field has a tier and no field is accidentally identity', () => {
  assert.equal(METADATA_FIELD_TIERS.patientName, 'identity');
  assert.equal(METADATA_FIELD_TIERS.clientName, 'identity');
  assert.equal(METADATA_FIELD_TIERS.pimsPatientId, 'identity');
  assert.equal(METADATA_FIELD_TIERS.templateId, 'processing');
  assert.equal(METADATA_FIELD_TIERS.foreignLanguage, 'processing');
  for (const key of ['species', 'breed', 'appointmentType']) {
    assert.equal(METADATA_FIELD_TIERS[key], 'descriptive');
  }
});

test('adopt origins are exactly the local-deletion gates', () => {
  // Distinct from the replay/severity axis: a 409 confirm probe is a replay for
  // severity purposes but a COMMIT site, because it GETs the row named in the
  // confirm URL.
  const adopt = [
    'prepare_already_uploaded',
    'confirm',
    'confirm_409_probe',
    'recovery_restart',
    'recovery_inspect',
    'confirm_api',
    'confirm_api_409_probe',
  ].filter(isAdoptMetadataOrigin);
  assert.equal(
    adopt.sort().join(','),
    'prepare_already_uploaded,recovery_inspect,recovery_restart'
  );
});

test('RecordingMetadataConflictError keeps the patch_draft phase for existing routing', () => {
  const error = new RecordingMetadataConflictError('rec-1', ['pimsPatientId'], 'server_conflict', 'copy');
  assert.equal(error.uploadPhase, 'patch_draft');
  assert.equal(error.code, 'RECORDING_METADATA_CONFLICT');
  assert.equal(error.source, 'server_conflict');
  assert.ok(error instanceof Error);
});

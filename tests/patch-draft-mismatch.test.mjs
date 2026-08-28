import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const {
  findMetadataMismatches,
  recordingMatchesMetadataPayload,
  formatMetadataMismatchDiagnostic,
  METADATA_MISMATCH_ERROR_CODE,
  MAX_DIAGNOSTIC_LENGTH,
} = await loadTsModule('src/api/metadataMismatch.ts');

/**
 * The module runs in the vm loader's realm, so its arrays are not
 * reference-equal to host arrays and deepStrictEqual fails on the prototype.
 * Compare a flat, serialized shape instead.
 */
const shape = (mismatches) =>
  Array.from(mismatches, (m) => `${m.key}:${m.kind}`).sort().join(',');

/** A server row and the payload the client submitted, agreeing on everything. */
const agreeingPair = () => ({
  recording: {
    patientName: 'Bella',
    clientName: 'Smith',
    species: 'Canine',
    breed: 'Beagle',
    appointmentType: 'Wellness Exam',
    templateId: 'tmpl-9f3a',
    foreignLanguage: false,
    pimsPatientId: 'CHART-1',
  },
  payload: {
    patientName: 'Bella',
    clientName: 'Smith',
    species: 'Canine',
    breed: 'Beagle',
    appointmentType: 'Wellness Exam',
    templateId: 'tmpl-9f3a',
    foreignLanguage: false,
    pimsPatientId: 'CHART-1',
  },
});

test('an agreeing pair produces no mismatches', () => {
  const { recording, payload } = agreeingPair();
  assert.equal(shape(findMetadataMismatches(recording, payload)), '');
});

test('findMetadataMismatches names every differing key instead of returning a bare boolean', () => {
  const { recording, payload } = agreeingPair();
  recording.templateId = 'tmpl-other';
  recording.species = 'Feline';

  assert.equal(
    shape(findMetadataMismatches(recording, payload)),
    'species:differs,templateId:differs'
  );
});

test('an absent server key is reported as absent, not as a differing value', () => {
  const { recording, payload } = agreeingPair();
  // The server emits the flat pimsPatientId alias ONLY when the Prisma
  // `patient` relation was loaded, so a route that omits the relation returns
  // no key at all. That is a different diagnosis from a disagreeing value.
  delete recording.pimsPatientId;

  assert.equal(shape(findMetadataMismatches(recording, payload)), 'pimsPatientId:absent');
});

test('an absent key is not rescued by the server-enrichment escape hatch', () => {
  // The hasOwnProperty gate runs BEFORE the enrichment check, so a blank
  // submitted value cannot save an absent key. This is the behavior that makes
  // a serializer regression fail 100% of submits through that route.
  const recording = { patientName: 'Bella' };
  const payload = { patientName: 'Bella', pimsPatientId: null };

  assert.equal(
    shape(findMetadataMismatches(recording, payload, { allowServerEnrichedBlankFields: true })),
    'pimsPatientId:absent'
  );
});

test('allowServerEnrichedBlankFields tolerates the server filling a blank the client left empty', () => {
  const recording = { species: 'Canine', templateId: null };
  const payload = { species: null, templateId: null };

  assert.equal(
    shape(findMetadataMismatches(recording, payload, { allowServerEnrichedBlankFields: true })),
    ''
  );
  // Without the option the same pair is a mismatch.
  assert.equal(shape(findMetadataMismatches(recording, payload)), 'species:differs');
});

test('templateId and foreignLanguage have no server-enrichment escape hatch', () => {
  const recording = { templateId: 'tmpl-server', foreignLanguage: true };
  const payload = { templateId: null, foreignLanguage: false };

  assert.equal(
    shape(findMetadataMismatches(recording, payload, { allowServerEnrichedBlankFields: true })),
    'foreignLanguage:differs,templateId:differs'
  );
});

test('pimsPatientIdExplicitlyCleared re-arms the pimsPatientId mismatch', () => {
  const recording = { pimsPatientId: 'server-chart-id' };
  const payload = { pimsPatientId: null };

  assert.equal(
    shape(findMetadataMismatches(recording, payload, { allowServerEnrichedBlankFields: true })),
    ''
  );
  assert.equal(
    shape(
      findMetadataMismatches(recording, payload, {
        allowServerEnrichedBlankFields: true,
        pimsPatientIdExplicitlyCleared: true,
      })
    ),
    'pimsPatientId:differs'
  );
});

test('recordingMatchesMetadataPayload stays exactly the negation of findMetadataMismatches', () => {
  const cases = [
    [{ a: 1 }, {}, {}],
    [{ patientName: 'Bella' }, { patientName: 'Bella' }, {}],
    [{ patientName: 'Bella' }, { patientName: 'Max' }, {}],
    [{}, { pimsPatientId: null }, { allowServerEnrichedBlankFields: true }],
    [
      { pimsPatientId: 'CHART-1' },
      { pimsPatientId: null },
      { allowServerEnrichedBlankFields: true },
    ],
    [
      { pimsPatientId: 'CHART-1' },
      { pimsPatientId: null },
      { allowServerEnrichedBlankFields: true, pimsPatientIdExplicitlyCleared: true },
    ],
    [{ species: null }, { species: '' }, {}],
  ];

  for (const [recording, payload, opts] of cases) {
    assert.equal(
      recordingMatchesMetadataPayload(recording, payload, opts),
      findMetadataMismatches(recording, payload, opts).length === 0,
      `divergent verdict for ${JSON.stringify({ recording, payload, opts })}`
    );
  }
});

test('the diagnostic emits key names only and never echoes a metadata value', () => {
  const recording = {
    patientName: 'Bella',
    clientName: 'Smith',
    templateId: 'tmpl-9f3a',
  };
  const payload = {
    patientName: 'Rufus',
    clientName: 'Nakamura',
    templateId: 'tmpl-deadbeef',
  };

  const out = formatMetadataMismatchDiagnostic(
    'confirm',
    findMetadataMismatches(recording, payload)
  );

  assert.match(out, /origin=confirm/);
  assert.match(out, /patientName:differs/);
  // The whole point: no patient or client name, and no template id, may appear.
  for (const secret of ['Bella', 'Smith', 'tmpl-9f3a', 'Rufus', 'Nakamura', 'deadbeef']) {
    assert.ok(!out.includes(secret), `diagnostic leaked ${secret}: ${out}`);
  }
});

test('an unrecognized payload key is reported as "other", never echoed', () => {
  const out = formatMetadataMismatchDiagnostic('confirm', [
    { key: 'surpriseFieldHoldingPhi', kind: 'differs' },
  ]);

  assert.match(out, /other:differs/);
  assert.ok(!out.includes('surpriseFieldHoldingPhi'), out);
});

test('the diagnostic survives the client and server message scrubbers', () => {
  const out = formatMetadataMismatchDiagnostic('confirm', [
    { key: 'patientName', kind: 'differs' },
    { key: 'pimsPatientId', kind: 'absent' },
  ]);

  // The server's looksLikePHI check is all-or-nothing: one path-like substring
  // replaces the ENTIRE message, destroying the diagnosis with it.
  assert.ok(!out.includes('/'), `diagnostic must contain no '/': ${out}`);
  assert.ok(out.length <= MAX_DIAGNOSTIC_LENGTH);
  // Full wire message stays inside the server's 512-char column.
  assert.ok(`Recording submission failed during patch_draft. ${out}`.length <= 512);
});

test('the diagnostic is stable: duplicate tokens collapse and order is deterministic', () => {
  const a = formatMetadataMismatchDiagnostic('confirm', [
    { key: 'species', kind: 'differs' },
    { key: 'patientName', kind: 'differs' },
    { key: 'species', kind: 'differs' },
  ]);
  const b = formatMetadataMismatchDiagnostic('confirm', [
    { key: 'patientName', kind: 'differs' },
    { key: 'species', kind: 'differs' },
  ]);

  assert.equal(a, b);
  assert.equal(a, 'metadata_mismatch origin=confirm fields=patientName:differs,species:differs');
});

test('METADATA_MISMATCH_ERROR_CODE fits the 64-char column and record.tsx UPPER_SNAKE gate', () => {
  assert.ok(METADATA_MISMATCH_ERROR_CODE.length <= 64);
  // record.tsx only trusts a `.code` matching this shape; anything else falls
  // back to the phase name, which is the collapse this code exists to end.
  assert.match(METADATA_MISMATCH_ERROR_CODE, /^[A-Z][A-Z0-9_]{2,}$/);
});

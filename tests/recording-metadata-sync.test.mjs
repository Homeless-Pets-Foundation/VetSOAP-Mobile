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

const SYNC = await loadTsModule('src/lib/recordingMetadataSync.ts');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRecording(overrides = {}) {
  return {
    id: 'rec-1',
    patientName: '',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    aiExtractedMetadata: null,
    ...overrides,
  };
}

test('add-mode metadata form seed pre-fills blank fields from AI suggestions', () => {
  const recording = makeRecording({
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {
        patientName: { value: ' Vixy ' },
        clientName: { value: 'Williams' },
        species: { value: 'Canine' },
        breed: { value: 'German Shepherd' },
      },
    },
  });

  assert.deepEqual(plain(SYNC.buildMetadataFormSeed(recording, 'add')), {
    patientName: 'Vixy',
    clientName: 'Williams',
    species: 'Canine',
    breed: 'German Shepherd',
    appointmentType: '',
  });
});

test('edit-mode metadata form seed does not overwrite current fields with suggestions', () => {
  const recording = makeRecording({
    patientName: 'Existing',
    aiExtractedMetadata: {
      appliedFields: [],
      fields: {
        patientName: { value: 'Vixy' },
        species: { value: 'Canine' },
      },
    },
  });

  assert.deepEqual(plain(SYNC.buildMetadataFormSeed(recording, 'edit')), {
    patientName: 'Existing',
    clientName: '',
    species: '',
    breed: '',
    appointmentType: '',
  });
});

test('suggestion-only review mode pre-fills blank fields from AI suggestions', () => {
  const recording = makeRecording({
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: [],
      fields: {
        patientName: { value: 'Vixy' },
        clientName: { value: 'Williams' },
        species: { value: 'Canine' },
      },
    },
  });

  assert.deepEqual(plain(SYNC.buildMetadataFormSeed(recording, 'review')), {
    patientName: 'Vixy',
    clientName: 'Williams',
    species: 'Canine',
    breed: '',
    appointmentType: '',
  });
});

test('review mode with applied fields does not pre-fill unapplied suggestions', () => {
  const recording = makeRecording({
    patientName: 'Vixy',
    aiExtractedMetadata: {
      review: 'unconfirmed',
      appliedFields: ['patientName'],
      fields: {
        patientName: { value: 'Vixy' },
        clientName: { value: 'Williams' },
      },
    },
  });

  assert.deepEqual(plain(SYNC.buildMetadataFormSeed(recording, 'review')), {
    patientName: 'Vixy',
    clientName: '',
    species: '',
    breed: '',
    appointmentType: '',
  });
});

test('recordings list cache merge patches matching pages without dropping pagination', () => {
  const oldCache = {
    pageParams: [1, 2],
    pages: [
      {
        data: [makeRecording({ id: 'rec-old', patientName: 'Toby' })],
        pagination: { page: 1, totalPages: 2 },
      },
      {
        data: [makeRecording({ id: 'rec-1', patientName: '' })],
        pagination: { page: 2, totalPages: 2 },
      },
    ],
  };
  const updated = makeRecording({
    id: 'rec-1',
    patientName: 'Vixy',
    clientName: 'Williams',
    species: 'Canine',
    breed: 'German Shepherd',
    needsMetadataReview: false,
  });

  const merged = SYNC.mergeUpdatedRecordingIntoRecordingsCache(oldCache, updated);

  assert.notEqual(merged, oldCache);
  assert.deepEqual(merged.pageParams, [1, 2]);
  assert.deepEqual(merged.pages[0], oldCache.pages[0]);
  assert.equal(merged.pages[1].data[0].patientName, 'Vixy');
  assert.equal(merged.pages[1].data[0].clientName, 'Williams');
  assert.equal(merged.pages[1].data[0].breed, 'German Shepherd');
});

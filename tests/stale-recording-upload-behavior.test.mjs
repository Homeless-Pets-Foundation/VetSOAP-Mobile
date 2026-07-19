import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

async function loadPure(path) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require: () => ({}), Error, Date, Set, JSON, Math,
  });
  return module.exports;
}

class ApiError extends Error {
  constructor(message, status, isRetryable = false, details, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isRetryable = isRetryable;
    this.details = details;
    this.code = code;
    this.data = data;
  }
}

async function loadHarness({
  getInfoAsync,
  post,
  get = async () => { throw new Error('unexpected GET'); },
  del = async () => {},
  upload = async () => ({ status: 200 }),
  setTimeoutImpl = setTimeout,
}) {
  const events = [];
  const preparation = await loadPure('src/api/uploadPreparation.ts');
  const pending = await loadPure('src/lib/pendingConfirm.ts');
  const retry = await loadPure('src/api/uploadRetry.ts');
  const pimsPatientIdIntent = await loadPure('src/lib/pimsPatientIdIntent.ts');
  const apiClient = {
    post: async (...args) => {
      events.push(['post', args[0], args[1], args[2]]);
      return post(...args);
    },
    get: async (...args) => {
      events.push(['get', args[0]]);
      return get(...args);
    },
    patch: async () => { throw new Error('unexpected PATCH'); },
    delete: async (...args) => {
      events.push(['delete', args[0], args[1]]);
      return del(...args);
    },
  };
  const source = await read('src/api/recordings.ts');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const identitySchema = {
    parse: (value) => value,
    partial() { return this; },
  };
  const require = (specifier) => {
    const modules = {
      'expo-file-system/legacy': {
        getInfoAsync,
        FileSystemUploadType: { BINARY_CONTENT: 0 },
        createUploadTask: (url) => {
          events.push(['put', url]);
          return {
            uploadAsync: async () => upload(url),
            cancelAsync: async () => {},
          };
        },
      },
      './client': { apiClient, ApiError },
      '../lib/validation': {
        recordingIdSchema: identitySchema,
        recordingTaskIdSchema: identitySchema,
        createRecordingSchema: identitySchema,
        createRecordingPartialSchema: identitySchema,
        searchQuerySchema: identitySchema,
      },
      '../lib/aiModels': { normalizeOrgAiModels: (value) => value },
      '../lib/sslPinning': { validateUploadUrl: () => {} },
      '../lib/recordingTasks': { unwrapTaskList: (value) => value },
      '../lib/random': { getIdempotencyUuid: () => 'generated-key' },
      '../lib/pendingConfirm': pending,
      '../lib/analytics': { trackEvent: () => {} },
      '../lib/monitoring': { breadcrumb: () => {} },
      '../lib/networkWait': { waitForNetworkOnline: async () => {} },
      '../constants/strings': { STALE_RECORDING_UPLOAD_COPY: 'saved locally' },
      './uploadPreparation': preparation,
      './uploadRetry': retry,
      '../lib/pimsPatientIdIntent': pimsPatientIdIntent,
      './draftPresenceContract': {
        draftPresenceRequestSchema: { parse: (value) => value },
        parseDraftPresenceResponse: (_requestedIds, value) => value,
      },
    };
    if (!(specifier in modules)) throw new Error(`unexpected module ${specifier}`);
    return modules[specifier];
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require,
    Error,
    Date,
    Set,
    JSON,
    Math,
    Promise,
    setTimeout: setTimeoutImpl,
    clearTimeout,
    AbortController,
  });
  return { recordingsApi: module.exports.recordingsApi, events };
}

const recordingId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const metadata = {
  patientName: 'Patient', clientName: null, species: null, breed: null,
  appointmentType: null, templateId: null, foreignLanguage: false, pimsPatientId: null,
};
const recording = { id: recordingId, organizationId: orgId, status: 'uploaded', ...metadata };
const prepared = (count) => ({
  outcome: 'prepared',
  recording: { ...recording, status: 'uploading' },
  replacedMissingRecordingId: false,
  warnings: [],
  uploads: Array.from({ length: count }, (_, index) => ({
    index,
    uploadUrl: `https://upload.example.test/${index}`,
    fileKey: count === 1
      ? `recordings/${orgId}/${recordingId}.m4a`
      : `recordings/${orgId}/${recordingId}_segment_${index}.m4a`,
    expiresAt: '2035-01-01T00:00:00.000Z',
  })),
});

test('missing local audio fails preflight before preparation, create, presign, or PUT', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: false }),
    post: async () => { throw new Error('server mutation must not run'); },
  });
  await assert.rejects(
    harness.recordingsApi.createWithFile(metadata, 'file:///missing.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
    }),
    /Failed to read audio segment/,
  );
  assert.deepEqual(harness.events, []);
});

test('prepared multi-file upload anchors first, PUTs exact ordered keys, persists hint, then confirms', async () => {
  const callbackEvents = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path, body) => {
      if (path.endsWith('/prepare-upload')) return prepared(2);
      if (path.endsWith('/confirm-upload')) {
        assert.deepEqual(Array.from(body.segmentKeys), prepared(2).uploads.map((entry) => entry.fileKey));
        return recording;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });
  const result = await harness.recordingsApi.createWithSegments(
    metadata,
    [{ uri: 'file:///one.m4a', duration: 1 }, { uri: 'file:///two.m4a', duration: 1 }],
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: async () => callbackEvents.push('anchored'),
      onR2Complete: async (hint) => {
        callbackEvents.push('hint');
        assert.deepEqual(Array.from(hint.segmentKeys), prepared(2).uploads.map((entry) => entry.fileKey));
      },
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(callbackEvents, ['anchored', 'hint']);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'put', 'post']);
});

test('fresh confirmation accepts a server-supplied Patient ID when the submitted ID is blank', async () => {
  const submittedMetadata = { ...metadata, pimsPatientId: '' };
  const enrichedRecording = {
    ...recording,
    patientId: '33333333-3333-4333-8333-333333333333',
    pimsPatientId: 'server-chart-id',
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path, body) => {
      if (path.endsWith('/prepare-upload')) {
        assert.equal(body.metadata.pimsPatientId, null);
        return prepared(1);
      }
      if (path.endsWith('/confirm-upload')) {
        assert.equal(body.metadata.pimsPatientId, null);
        return enrichedRecording;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  const result = await harness.recordingsApi.createWithFile(
    submittedMetadata,
    'file:///one.m4a',
    'audio/x-m4a',
    { idempotencyKey: 'intent-server-patient-id' },
  );

  assert.equal(result.pimsPatientId, 'server-chart-id');
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('fresh confirmation rejects a server Patient ID after the user explicitly cleared it', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) {
        return { ...recording, pimsPatientId: 'server-chart-id' };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      { ...metadata, pimsPatientId: '' },
      'file:///one.m4a',
      'audio/x-m4a',
      {
        idempotencyKey: 'intent-explicit-patient-id-clear',
        pimsPatientIdExplicitlyCleared: true,
      },
    ),
    (error) =>
      error?.uploadPhase === 'patch_draft' &&
      /Could not sync the latest patient details/.test(error.message),
  );
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('a complete confirmation hint resumes without reading a missing local file', async () => {
  let fileReads = 0;
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 128 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
  });
  const result = await harness.recordingsApi.createWithFile(metadata, 'file:///gone.m4a', 'audio/x-m4a', {
    idempotencyKey: 'intent',
    resume: hint,
  });
  assert.equal(result.id, recordingId);
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post']);
});

test('typed confirm conflict inspects and returns an already-committed recording without local audio', async () => {
  let fileReads = 0;
  const completed = { ...recording, status: 'completed' };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 100 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('already committed', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) return { outcome: 'already_processed', recording: completed };
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });
  const result = await harness.recordingsApi.confirmPendingUpload(metadata, hint, {
    idempotencyKey: 'intent',
  });
  assert.equal(result.status, 'completed');
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'post']);
});

test('typed confirm conflict inspects a minimal native proof without local descriptors', async () => {
  let fileReads = 0;
  const completed = { ...recording, status: 'completed' };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path, body, idempotencyKey) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('already committed', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) {
        assert.equal(idempotencyKey, 'intent-minimal-proof');
        assert.equal(body.action, 'inspect');
        assert.equal(body.files.length, 0);
        assert.equal(body.pendingConfirm.recordingId, recordingId);
        assert.equal(body.pendingConfirm.fileKey, hint.fileKey);
        return { outcome: 'already_processed', recording: completed };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  const result = await harness.recordingsApi.confirmPendingUpload(metadata, hint, {
    idempotencyKey: 'intent-minimal-proof',
  });

  assert.equal(result.status, 'completed');
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'post']);
});

test('untyped confirm conflict retains the proven-completed GET fallback', async () => {
  let fileReads = 0;
  const completed = { ...recording, status: 'completed' };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('legacy conflict', 409);
      }
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });

  const result = await harness.recordingsApi.confirmPendingUpload(metadata, hint, {
    idempotencyKey: 'intent-untyped-conflict',
  });

  assert.equal(result.status, 'completed');
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get']);
});

test('unresolved inspection remains non-restartable in the typed error', async () => {
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: false }),
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('conflict', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) {
        return {
          outcome: 'unresolved',
          conflict: { stage: 'recovery', reason: 'source_ambiguous', recoveryAction: 'inspect' },
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  await assert.rejects(
    harness.recordingsApi.confirmPendingUpload(metadata, hint, {
      idempotencyKey: 'intent-unresolved',
    }),
    (error) =>
      error?.code === 'UPLOAD_INTENT_CONFLICT' &&
      error?.recoveryOutcome === 'unresolved' &&
      error?.conflict?.reason === 'source_ambiguous',
  );
});

test('typed confirm conflict accepts a server-supplied Patient ID when the submitted ID is blank', async () => {
  let fileReads = 0;
  const completed = {
    ...recording,
    status: 'completed',
    patientId: '33333333-3333-4333-8333-333333333333',
    pimsPatientId: 'server-chart-id',
  };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata: { ...metadata, pimsPatientId: null },
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 100 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('already committed', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) return { outcome: 'already_processed', recording: completed };
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });

  const result = await harness.recordingsApi.confirmPendingUpload(
    { ...metadata, pimsPatientId: '' },
    hint,
    { idempotencyKey: 'intent-confirm-retry' },
  );

  assert.equal(result.pimsPatientId, 'server-chart-id');
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'post']);
});

test('typed confirm conflict rejects a server Patient ID after the user explicitly cleared it', async () => {
  const completed = {
    ...recording,
    status: 'completed',
    pimsPatientId: 'server-chart-id',
  };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata: { ...metadata, pimsPatientId: null },
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 100 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: false }),
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('already committed', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) return { outcome: 'already_processed', recording: completed };
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });

  await assert.rejects(
    harness.recordingsApi.confirmPendingUpload(
      { ...metadata, pimsPatientId: '' },
      hint,
      {
        idempotencyKey: 'intent-explicit-clear-confirm-retry',
        pimsPatientIdExplicitlyCleared: true,
      },
    ),
    (error) =>
      error?.uploadPhase === 'patch_draft' &&
      /Could not sync the latest patient details/.test(error.message),
  );
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'post']);
});

test('untyped confirm 409 accepts a server-supplied Patient ID when submitted blank', async () => {
  let fileReads = 0;
  const completed = {
    ...recording,
    status: 'completed',
    patientId: '33333333-3333-4333-8333-333333333333',
    pimsPatientId: 'server-chart-id',
  };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) throw new ApiError('already committed', 409);
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });

  const result = await harness.recordingsApi.confirmPendingUpload(
    { ...metadata, pimsPatientId: '' },
    hint,
    { idempotencyKey: 'intent-untyped-patient-id' },
  );

  assert.equal(result.pimsPatientId, 'server-chart-id');
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get']);
});

test('untyped confirm 409 rejects a server Patient ID after an explicit clear', async () => {
  const completed = {
    ...recording,
    status: 'completed',
    pimsPatientId: 'server-chart-id',
  };
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: false }),
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) throw new ApiError('already committed', 409);
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => completed,
  });

  await assert.rejects(
    harness.recordingsApi.confirmPendingUpload(
      { ...metadata, pimsPatientId: '' },
      hint,
      {
        idempotencyKey: 'intent-untyped-explicit-clear',
        pimsPatientIdExplicitlyCleared: true,
      },
    ),
    (error) =>
      error?.uploadPhase === 'patch_draft' &&
      /Could not sync the latest patient details/.test(error.message),
  );
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get']);
});

test('controlled restart uses the recovery endpoint and a replacement identity before PUT', async () => {
  const oldKey = 'recording-upload-v1:slot:old-intent';
  const replacementKey = 'recording-upload-v2:restart:new-intent';
  const fileKey = `recordings/${orgId}/${recordingId}.m4a`;
  const prepared = {
    outcome: 'prepared',
    recording: { ...recording, status: 'uploading' },
    replacedRecordingId: recordingId,
    uploads: [{
      index: 0,
      uploadUrl: 'https://storage.example/upload',
      fileKey,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }],
    warnings: [],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 100 }),
    post: async (path, body, idempotencyKey) => {
      if (path.endsWith('/upload-intent-recovery')) {
        assert.equal(idempotencyKey, oldKey);
        assert.equal(body.action, 'restart');
        assert.equal(body.replacementIdempotencyKey, replacementKey);
        return prepared;
      }
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
  });

  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///recording.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: replacementKey,
      supersededIdempotencyKey: oldKey,
      existingRecordingId: recordingId,
    },
  );

  assert.equal(result.id, recordingId);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('partial restart identities fail before local-file or network work', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => {
      throw new Error('preflight must not run');
    },
    post: async (path) => {
      throw new Error(`network must not run: ${path}`);
    },
  });

  for (const options of [
    { idempotencyKey: 'recording-upload-v2:restart:missing-old' },
    {
      idempotencyKey: 'recording-upload-v1:slot:ordinary',
      supersededIdempotencyKey: 'recording-upload-v1:slot:unexpected-old',
    },
  ]) {
    await assert.rejects(
      harness.recordingsApi.createWithFile(
        metadata,
        'file:///recording.m4a',
        'audio/x-m4a',
        options,
      ),
      /saved upload restart is incomplete/,
    );
  }
  assert.deepEqual(harness.events, []);
});

test('controlled restart fails closed when the recovery route is unavailable', async () => {
  const oldKey = 'recording-upload-v1:slot:old-intent';
  const replacementKey = 'recording-upload-v2:restart:new-intent';
  let legacyMutations = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 100 }),
    post: async (path) => {
      if (path.endsWith('/upload-intent-recovery')) {
        throw new ApiError('route unavailable', 404);
      }
      if (path === '/api/recordings' || path.endsWith('/upload-url')) {
        legacyMutations++;
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      metadata,
      'file:///recording.m4a',
      'audio/x-m4a',
      {
        idempotencyKey: replacementKey,
        supersededIdempotencyKey: oldKey,
        existingRecordingId: recordingId,
      },
    ),
    (error) => error instanceof ApiError && error.status === 404,
  );

  assert.equal(legacyMutations, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post']);
});

test('controlled restart inspects the replacement identity after a typed confirm conflict', async () => {
  const oldKey = 'recording-upload-v1:slot:old-intent';
  const replacementKey = 'recording-upload-v2:restart:new-intent';
  const fileKey = `recordings/${orgId}/${recordingId}.m4a`;
  const replacementPrepared = {
    outcome: 'prepared',
    recording: { ...recording, status: 'uploading' },
    replacedRecordingId: recordingId,
    uploads: [{
      index: 0,
      uploadUrl: 'https://storage.example/upload',
      fileKey,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }],
    warnings: [],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 100 }),
    post: async (path, body, idempotencyKey) => {
      if (path.endsWith('/upload-intent-recovery') && body.action === 'restart') {
        assert.equal(idempotencyKey, oldKey);
        return replacementPrepared;
      }
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('commit raced', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: { stage: 'confirm', reason: 'commit_state_changed', recoveryAction: 'inspect' },
        });
      }
      if (path.endsWith('/upload-intent-recovery') && body.action === 'inspect') {
        assert.equal(idempotencyKey, replacementKey);
        assert.equal(body.pendingConfirm.recordingId, recordingId);
        assert.equal(body.pendingConfirm.fileKey, fileKey);
        return { outcome: 'already_uploaded', recording };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///recording.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: replacementKey,
      supersededIdempotencyKey: oldKey,
      existingRecordingId: recordingId,
    },
  );

  assert.equal(result.id, recordingId);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post', 'post']);
});

test('confirmation rejects a different server Patient ID when the submitted ID is nonblank', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) {
        return { ...recording, pimsPatientId: 'chart-B' };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      { ...metadata, pimsPatientId: 'chart-A' },
      'file:///one.m4a',
      'audio/x-m4a',
      { idempotencyKey: 'intent-patient-id-mismatch' },
    ),
    (error) =>
      error?.uploadPhase === 'patch_draft' &&
      /Could not sync the latest patient details/.test(error.message),
  );
});

test('only an untyped route-level prepare 404 enters the legacy compatibility flow', async () => {
  let prepareCalls = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        prepareCalls++;
        throw new ApiError('not found', 404);
      }
      if (path === '/api/recordings') return { ...recording, status: 'uploading' };
      if (path.endsWith('/upload-url')) return {
        uploadUrl: 'https://upload.example.test/legacy',
        fileKey: `recordings/${orgId}/${recordingId}.m4a`,
        warnings: [],
      };
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
  });
  await harness.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
    idempotencyKey: 'intent',
  });
  assert.equal(prepareCalls, 1);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'post', 'post', 'put', 'post']);

  const typed = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async () => { throw new ApiError('typed', 404, false, undefined, 'INVALID_UPLOAD_PREPARATION'); },
  });
  await assert.rejects(
    typed.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
    }),
    (error) => error instanceof ApiError && error.code === 'INVALID_UPLOAD_PREPARATION',
  );
  assert.equal(typed.events.length, 1);
});

test('confirm 404 plus a missing row refuses re-upload when local audio is gone', async () => {
  let fileReads = 0;
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 128 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) throw new ApiError('missing', 404);
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => { throw new ApiError('missing', 404); },
  });
  await assert.rejects(
    harness.recordingsApi.createWithFile(metadata, 'file:///gone.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
      resume: hint,
    }),
    /saved locally/,
  );
  assert.equal(fileReads, 1);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get']);
});

test('a stale manifested URL refreshes through preparation and preserves the exact key', async () => {
  let preparationCalls = 0;
  let uploadCalls = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        preparationCalls++;
        return prepared(1);
      }
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    upload: async () => (++uploadCalls === 1 ? { status: 403 } : { status: 200 }),
  });

  await harness.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
    idempotencyKey: 'intent',
  });
  assert.equal(preparationCalls, 2);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post', 'put', 'post']);
  assert.equal(harness.events[1][1], harness.events[3][1]);
});

test('confirm recovery retries only confirmation for draft/uploading probes', async () => {
  let confirmCalls = 0;
  let fileReads = 0;
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 128 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        confirmCalls++;
        if (confirmCalls === 1) throw new ApiError('missing', 404);
        return recording;
      }
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => ({ ...recording, status: 'uploading' }),
  });

  await harness.recordingsApi.createWithFile(metadata, 'file:///gone.m4a', 'audio/x-m4a', {
    idempotencyKey: 'intent',
    resume: hint,
  });
  assert.equal(confirmCalls, 2);
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get', 'post']);
});

test('a later-state probe requires preparation proof and never trusts GET alone', async () => {
  let fileReads = 0;
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 128 }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => { fileReads++; return { exists: false }; },
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) throw new ApiError('missing', 404);
      if (path.endsWith('/prepare-upload')) {
        return {
          outcome: 'already_uploaded',
          recording,
          replacedMissingRecordingId: false,
          warnings: [],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => ({ ...recording, status: 'uploaded' }),
  });

  const result = await harness.recordingsApi.createWithFile(metadata, 'file:///gone.m4a', 'audio/x-m4a', {
    idempotencyKey: 'intent',
    resume: hint,
  });
  assert.equal(result.id, recordingId);
  assert.equal(fileReads, 0);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'get', 'post']);
});

test('already-uploaded preparation anchors the canonical row without PUT or confirm', async () => {
  const callbacks = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        return {
          outcome: 'already_uploaded',
          recording,
          replacedMissingRecordingId: false,
          warnings: [],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: async (id) => callbacks.push(['anchor', id]),
      onR2Complete: async () => callbacks.push(['hint']),
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(callbacks, [['anchor', recordingId]]);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post']);
});

test('already-processed preparation anchors the canonical row without PUT or confirm', async () => {
  const completed = {
    ...recording,
    status: 'completed',
    soapNoteId: 'soap-1',
    patientId: '33333333-3333-4333-8333-333333333333',
    pimsPatientId: 'server-chart-id',
  };
  const callbacks = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        return {
          outcome: 'already_processed',
          recording: completed,
          replacedMissingRecordingId: false,
          warnings: [],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });
  const result = await harness.recordingsApi.createWithFile(
    { ...metadata, pimsPatientId: '' },
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: async (id) => callbacks.push(['anchor', id]),
      onR2Complete: async () => callbacks.push(['hint']),
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.pimsPatientId, 'server-chart-id');
  assert.deepEqual(callbacks, [['anchor', recordingId]]);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post']);
});

test('already-processed preparation rejects enrichment for a legacy null Patient ID clear', async () => {
  const completed = {
    ...recording,
    status: 'completed',
    soapNoteId: 'soap-1',
    pimsPatientId: 'server-chart-id',
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        return {
          outcome: 'already_processed',
          recording: completed,
          replacedMissingRecordingId: false,
          warnings: [],
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      { ...metadata, pimsPatientId: null },
      'file:///one.m4a',
      'audio/x-m4a',
      { idempotencyKey: 'intent-legacy-null-patient-id-clear' },
    ),
    (error) =>
      error?.uploadPhase === 'patch_draft' &&
      /Could not sync the latest patient details/.test(error.message),
  );
  assert.deepEqual(harness.events.map((event) => event[0]), ['post']);
});

test('anchor and pending-hint persistence failures do not block canonical upload confirmation', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: async () => { throw new Error('local anchor unavailable'); },
      onR2Complete: async () => { throw new Error('local hint unavailable'); },
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('hung prepared-anchor persistence is bounded before storage upload', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: () => new Promise(() => {}),
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('a late prepared-anchor write is cleaned after canonical confirmation', async () => {
  let releaseAnchor;
  const clearReasons = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onRecordingPrepared: () => new Promise((resolve) => { releaseAnchor = resolve; }),
      onClearPendingConfirm: async (reason) => { clearReasons.push(reason); },
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(clearReasons, []);
  releaseAnchor();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clearReasons, ['committed_late_anchor']);
});

test('hung stale-proof clearing is bounded before retry preparation', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      resume: { recordingId, fileKey: 'https://invalid.example.test/audio.m4a' },
      onClearPendingConfirm: () => new Promise(() => {}),
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('hung pending-hint persistence is bounded and a late write is cleared after confirmation', async () => {
  let releaseHint;
  const clearReasons = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });
  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent',
      onR2Complete: () => new Promise((resolve) => { releaseHint = resolve; }),
      onClearPendingConfirm: async (reason) => { clearReasons.push(reason); },
    },
  );
  assert.equal(result.id, recordingId);
  assert.deepEqual(clearReasons, []);
  releaseHint();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clearReasons, ['committed_late_hint']);
  assert.deepEqual(harness.events.map((event) => event[0]), ['post', 'put', 'post']);
});

test('a timed-out hint that settles before confirmation still gets cleared after commit', async () => {
  let releaseHint;
  let releaseConfirm;
  const clearReasons = [];
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) {
        return new Promise((resolve) => {
          releaseConfirm = () => resolve(recording);
        });
      }
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });

  const upload = harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    {
      idempotencyKey: 'intent-settled-before-confirm',
      onR2Complete: () => new Promise((resolve) => { releaseHint = resolve; }),
      onClearPendingConfirm: async (reason) => { clearReasons.push(reason); },
    },
  );
  while (!releaseHint || !releaseConfirm) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  releaseHint();
  await new Promise((resolve) => setImmediate(resolve));
  releaseConfirm();
  assert.equal((await upload).id, recordingId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clearReasons, ['committed_late_hint']);
});

test('a timed-out pending-hint write blocks conflict restart until it settles', async () => {
  let releaseHint;
  let recoveryCalls = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(1);
      if (path.endsWith('/confirm-upload')) {
        throw new ApiError('conflict', 409, false, undefined, 'UPLOAD_INTENT_CONFLICT', {
          uploadConflict: {
            stage: 'confirm',
            reason: 'commit_state_changed',
            recoveryAction: 'inspect',
          },
        });
      }
      if (path.endsWith('/upload-intent-recovery')) {
        recoveryCalls++;
        return {
          outcome: 'restart_available',
          conflict: {
            stage: 'recovery',
            reason: 'source_changed',
            recoveryAction: 'inspect',
          },
        };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      metadata,
      'file:///one.m4a',
      'audio/x-m4a',
      {
        idempotencyKey: 'intent-late-hint-conflict',
        onR2Complete: () => new Promise((resolve) => { releaseHint = resolve; }),
      },
    ),
    (error) =>
      error?.code === 'UPLOAD_INTENT_CONFLICT' &&
      error?.recoveryOutcome === 'unresolved',
  );
  assert.equal(recoveryCalls, 0);

  const eventCountBeforeBlockedRetry = harness.events.length;
  await assert.rejects(
    harness.recordingsApi.createWithFile(
      metadata,
      'file:///one.m4a',
      'audio/x-m4a',
      { idempotencyKey: 'intent-late-hint-conflict' },
    ),
    /still securing the saved upload state/,
  );
  assert.equal(harness.events.length, eventCountBeforeBlockedRetry);

  releaseHint();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      metadata,
      'file:///one.m4a',
      'audio/x-m4a',
      { idempotencyKey: 'intent-late-hint-conflict' },
    ),
    (error) =>
      error?.code === 'UPLOAD_INTENT_CONFLICT' &&
      error?.recoveryOutcome === 'restart_available',
  );
  assert.equal(recoveryCalls, 1);
});

test('a stale signature on the final normal attempt still PUTs once to the refreshed URL', async () => {
  let uploadCalls = 0;
  let prepareCalls = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        prepareCalls++;
        return prepared(1);
      }
      if (path.endsWith('/confirm-upload')) return recording;
      throw new Error(`unexpected POST ${path}`);
    },
    upload: async () => {
      uploadCalls++;
      if (uploadCalls <= 2) throw new Error('Network request failed');
      if (uploadCalls === 3) return { status: 403 };
      return { status: 200 };
    },
    setTimeoutImpl: (callback, ms, ...args) => setTimeout(callback, Math.min(ms, 5), ...args),
  });

  const result = await harness.recordingsApi.createWithFile(
    metadata,
    'file:///one.m4a',
    'audio/x-m4a',
    { idempotencyKey: 'intent' },
  );
  assert.equal(result.id, recordingId);
  assert.equal(prepareCalls, 2);
  assert.equal(uploadCalls, 4);
  assert.deepEqual(
    harness.events.map((event) => event[0]),
    ['post', 'put', 'put', 'put', 'post', 'put', 'post'],
  );
});

test('a refreshed URL rejected with 403 fails after one refresh instead of looping', async () => {
  let uploadCalls = 0;
  let prepareCalls = 0;
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        prepareCalls++;
        return prepared(1);
      }
      throw new Error(`unexpected POST ${path}`);
    },
    upload: async () => {
      uploadCalls++;
      return { status: 403 };
    },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(
      metadata,
      'file:///one.m4a',
      'audio/x-m4a',
      { idempotencyKey: 'intent' },
    ),
    /refreshed upload URL was rejected/i,
  );
  assert.equal(prepareCalls, 2);
  assert.equal(uploadCalls, 2);
});

test('legacy fallback deletes a row it created when upload fails before confirmation proof', async () => {
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) throw new ApiError('route absent', 404);
      if (path === '/api/recordings') return { ...recording, status: 'uploading' };
      if (path.endsWith('/upload-url')) return {
        uploadUrl: 'https://upload.example.test/legacy',
        fileKey: `recordings/${orgId}/${recordingId}.m4a`,
      };
      throw new Error(`unexpected POST ${path}`);
    },
    upload: async () => { throw new Error('permanent storage failure'); },
  });
  await assert.rejects(
    harness.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
    }),
    /permanent storage failure/,
  );
  const deletion = harness.events.find((event) => event[0] === 'delete');
  assert.equal(deletion?.[1], `/api/recordings/${recordingId}`);
  assert.equal(deletion?.[2]?.reason, 'orphan_pending_confirm');
  assert.equal(harness.events.some((event) => event[1]?.endsWith?.('/confirm-upload')), false);
});

test('typed preparation failures and partial PUT failure stop without fallback, hint, or confirm', async () => {
  for (const status of [400, 409, 503]) {
    const typed = await loadHarness({
      getInfoAsync: async () => ({ exists: true, size: 128 }),
      post: async () => { throw new ApiError('typed preparation failure', status, false, undefined, 'UPLOAD_INTENT_CONFLICT'); },
    });
    await assert.rejects(
      typed.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
        idempotencyKey: 'intent',
      }),
      (error) => error instanceof ApiError && error.status === status,
    );
    assert.deepEqual(typed.events.map((event) => event[0]), ['post']);
  }

  let hints = 0;
  const partial = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) return prepared(2);
      throw new Error(`confirm must not run after partial upload: ${path}`);
    },
    upload: async (url) => {
      if (url.endsWith('/1')) throw new Error('permanent storage failure');
      return { status: 200 };
    },
  });
  await assert.rejects(
    partial.recordingsApi.createWithSegments(
      metadata,
      [{ uri: 'file:///one.m4a', duration: 1 }, { uri: 'file:///two.m4a', duration: 1 }],
      'audio/x-m4a',
      { idempotencyKey: 'intent', onR2Complete: async () => { hints++; } },
    ),
    /permanent storage failure/,
  );
  assert.equal(hints, 0);
  assert.equal(partial.events.filter((event) => event[0] === 'post').length, 1);
});

test('a second missing-row confirmation stops at the one-replacement cap', async () => {
  const replacementId = '33333333-3333-4333-8333-333333333333';
  let confirmCalls = 0;
  const hint = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata,
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 128 }],
  };
  const replacement = {
    ...prepared(1),
    recording: { ...recording, id: replacementId, status: 'uploading' },
    replacedMissingRecordingId: true,
    uploads: [{
      ...prepared(1).uploads[0],
      fileKey: `recordings/${orgId}/${replacementId}.m4a`,
    }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/confirm-upload')) {
        confirmCalls++;
        throw new ApiError('missing', 404);
      }
      if (path.endsWith('/prepare-upload')) return replacement;
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => { throw new ApiError('missing', 404); },
  });
  await assert.rejects(
    harness.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
      resume: hint,
    }),
    /saved locally/,
  );
  assert.equal(confirmCalls, 2);
  assert.equal(harness.events.filter((event) => event[0] === 'put').length, 1);
});

test('an initial stale-ID preparation replacement consumes the one-replacement cap', async () => {
  const replacementId = '33333333-3333-4333-8333-333333333333';
  let preparationCalls = 0;
  const replacement = {
    ...prepared(1),
    recording: { ...recording, id: replacementId, status: 'uploading' },
    replacedMissingRecordingId: true,
    uploads: [{
      ...prepared(1).uploads[0],
      fileKey: `recordings/${orgId}/${replacementId}.m4a`,
    }],
  };
  const harness = await loadHarness({
    getInfoAsync: async () => ({ exists: true, size: 128 }),
    post: async (path) => {
      if (path.endsWith('/prepare-upload')) {
        preparationCalls++;
        return replacement;
      }
      if (path.endsWith('/confirm-upload')) throw new ApiError('missing', 404);
      throw new Error(`unexpected POST ${path}`);
    },
    get: async () => { throw new ApiError('missing', 404); },
  });

  await assert.rejects(
    harness.recordingsApi.createWithFile(metadata, 'file:///one.m4a', 'audio/x-m4a', {
      idempotencyKey: 'intent',
      existingRecordingId: recordingId,
    }),
    /saved locally/,
  );
  assert.equal(preparationCalls, 1);
  assert.equal(harness.events.filter((event) => event[0] === 'put').length, 1);
});

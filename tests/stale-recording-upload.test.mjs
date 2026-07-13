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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: () => ({}), Error, Date, Set, JSON });
  return module.exports;
}

const recordingId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const future = '2035-01-01T00:00:00.000Z';

function response(overrides = {}) {
  return {
    outcome: 'prepared',
    recording: { id: recordingId, organizationId: orgId, status: 'uploading' },
    replacedMissingRecordingId: false,
    warnings: [],
    uploads: [{
      index: 0,
      uploadUrl: 'https://upload.example.test/signed',
      fileKey: `recordings/${orgId}/${recordingId}.m4a`,
      expiresAt: future,
    }],
    ...overrides,
  };
}

test('preparation envelope accepts exact ordered single and multi manifests', async () => {
  const { validatePreparedUploadEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  assert.equal(validatePreparedUploadEnvelope(response(), 1, 0).recording.id, recordingId);
  const uploads = [0, 1].map((index) => ({
    index,
    uploadUrl: `https://upload.example.test/${index}`,
    fileKey: `recordings/${orgId}/${recordingId}_segment_${index}.m4a`,
    expiresAt: future,
  }));
  assert.equal(validatePreparedUploadEnvelope(response({ uploads }), 2, 0).uploads.length, 2);
});

test('preparation envelope rejects malformed arrays, counts, order, keys, outcomes, and expiry', async () => {
  const { validatePreparedUploadEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  const invalid = [
    response({ uploads: null }),
    response({ uploads: [] }),
    response({ outcome: 'unknown' }),
    response({ uploads: [{ ...response().uploads[0], index: 1 }] }),
    response({ uploads: [{ ...response().uploads[0], fileKey: `recordings/${orgId}/${recordingId}0.m4a` }] }),
    response({ uploads: [{ ...response().uploads[0], fileKey: `recordings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${recordingId}.m4a` }] }),
    response({ uploads: [{ ...response().uploads[0], expiresAt: 'not-a-date' }] }),
    response({ uploads: [{ ...response().uploads[0], expiresAt: '2000-01-01T00:00:00.000Z' }] }),
  ];
  for (const value of invalid) {
    assert.throws(() => validatePreparedUploadEnvelope(value, 1, Date.now()));
  }
});

test('already outcomes reject upload URLs and retain server proof semantics', async () => {
  const { validatePreparedUploadEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  const already = response({ outcome: 'already_uploaded', uploads: undefined });
  assert.equal(validatePreparedUploadEnvelope(already, 1).outcome, 'already_uploaded');
  assert.throws(() => validatePreparedUploadEnvelope(response({ outcome: 'already_processed' }), 1));
});

test('pending-confirm validation requires UUIDs, exact complete keys, metadata, and file descriptors', async () => {
  const { validatePendingConfirm } = await loadPure('src/lib/pendingConfirm.ts');
  const pending = {
    recordingId,
    fileKey: `recordings/${orgId}/${recordingId}.m4a`,
    metadata: {
      patientName: 'Patient', clientName: null, species: null, breed: null,
      appointmentType: null, templateId: null, foreignLanguage: false, pimsPatientId: null,
    },
    files: [{ fileName: 'recording.m4a', contentType: 'audio/x-m4a', fileSizeBytes: 100 }],
  };
  assert.equal(JSON.stringify(validatePendingConfirm(pending)), JSON.stringify(pending));
  assert.equal(validatePendingConfirm({ ...pending, fileKey: `recordings/${orgId}/${recordingId}0.m4a` }), null);
  assert.equal(validatePendingConfirm({ ...pending, files: [{ ...pending.files[0], contentType: 'text/plain' }] }), null);
  assert.equal(validatePendingConfirm({ ...pending, recordingId: 'not-a-uuid' }), null);
});

test('stable upload intent keys survive migration and rotate only on explicit start-over', async () => {
  const { normalizeUploadIntentId, slotUploadIdempotencyKey, durableUploadIdempotencyKey } = await loadPure('src/lib/uploadIntent.ts');
  assert.equal(normalizeUploadIntentId(undefined, 'slot-7'), 'legacy:slot-7');
  assert.equal(normalizeUploadIntentId(undefined, 'slot-7'), 'legacy:slot-7');
  assert.equal(slotUploadIdempotencyKey('legacy:slot-7'), 'recording-upload-v1:slot:legacy:slot-7');
  assert.equal(durableUploadIdempotencyKey('native-9'), 'recording-upload-v1:durable:native-9');
  const reducer = await read('src/hooks/useMultiPatientSession.ts');
  const clear = reducer.slice(reducer.indexOf("case 'CLEAR_AUDIO'"), reducer.indexOf("case 'CONTINUE_RECORDING'"));
  const update = reducer.slice(reducer.indexOf("case 'UPDATE_FORM'"), reducer.indexOf("case 'SET_AUDIO_STATE'"));
  assert.match(clear, /uploadIntentId: createUploadIntentId\(\)/);
  assert.doesNotMatch(update, /createUploadIntentId|pendingConfirm: null/);
});

test('upload orchestration preserves ordering, persistence, fallback, and bounded recovery contracts', async () => {
  const api = await read('src/api/recordings.ts');
  const record = await read('app/(app)/(tabs)/record.tsx');
  const strings = await read('src/constants/strings.ts');

  const execute = api.slice(api.indexOf('async function executeResilientUpload'), api.indexOf('export const recordingsApi'));
  assert.ok(execute.indexOf('preflightLocalFiles') < execute.indexOf('requestPreparation'));
  assert.match(api, /validatePreparedUploadEnvelope\(raw, expectedFileCount\)/);
  assert.match(api, /const keys = uploads\.map\(\(entry\) => entry\.fileKey\)/);
  assert.match(api, /runWithConcurrency\(files\.length, SEGMENT_UPLOAD_CONCURRENCY, uploadOne\)/);
  assert.match(api, /await invokePreparedCallback\(options\.onRecordingPrepared/);
  assert.match(api, /await invokeHintCallback\(options\.onR2Complete, hint\)/);
  assert.match(api, /isRouteLevelPrepare404\(error\)/);
  assert.match(api, /if \(!isRouteLevelPrepare404\(error\)\) throw error/);
  assert.match(api, /current\.status === 'draft' \|\| current\.status === 'uploading'|probedRecording\.status === 'draft'/);
  assert.match(api, /if \(staleRestartUsed\)/);
  assert.match(api, /staleRestartUsed = true/);
  assert.match(api, /isStaleCanonicalPreparationError/);
  assert.match(api, /trackStaleRecovery\('url_refresh', 'canonical_changed'/);
  assert.doesNotMatch(execute, /\.delete\(|safeDelete/);

  assert.match(record, /slotUploadIdempotencyKey\(/);
  assert.match(record, /durableUploadIdempotencyKey\(/);
  assert.match(record, /await draftStorage\.updatePendingConfirm/);
  const continuation = record.slice(
    record.indexOf('const handleContinueRecording = useCallback('),
    record.indexOf('const handleRecordAgain = useCallback('),
  );
  assert.doesNotMatch(continuation, /deleteOrphanServerRecording/);
  const draftSync = record.slice(
    record.indexOf('const syncServerDraft = useCallback('),
    record.indexOf('const scheduleDraftSync = useCallback('),
  );
  assert.doesNotMatch(draftSync, /deleteRecordingWithRetry\(serverId/);
  assert.match(strings, /We couldn't finish the upload\. The recording is still saved on this device/);
});

test('native durable manifests atomically persist a feature-detected pending hint on both platforms', async () => {
  const bridge = await read('modules/captivet-durable-recorder/index.ts');
  const android = await read('modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt');
  const ios = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(bridge, /typeof mod\.setPendingConfirm !== 'function'/);
  assert.match(bridge, /JSON\.stringify\(pending\)/);
  assert.match(android, /mutateManifest\(ctx\.applicationContext, uId, rId\) \{ it\.pendingConfirmJson = pendingJson \}/);
  assert.match(ios, /mutateManifestAtomically\(userId: userId, recordingId: recordingId\)/);
  assert.match(ios, /manifest\.pendingConfirmJson = pendingConfirmJson/);
});

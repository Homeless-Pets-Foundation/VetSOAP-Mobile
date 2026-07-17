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

test('preparation envelope rejects malformed arrays, counts, order, keys, outcomes, and expiry syntax', async () => {
  const { validatePreparedUploadEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  const invalid = [
    response({ uploads: null }),
    response({ uploads: [] }),
    response({ outcome: 'unknown' }),
    response({ uploads: [{ ...response().uploads[0], index: 1 }] }),
    response({ uploads: [{ ...response().uploads[0], fileKey: `recordings/${orgId}/${recordingId}0.m4a` }] }),
    response({ uploads: [{ ...response().uploads[0], fileKey: `recordings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/${recordingId}.m4a` }] }),
    response({ uploads: [{ ...response().uploads[0], expiresAt: 'not-a-date' }] }),
  ];
  for (const value of invalid) {
    assert.throws(() => validatePreparedUploadEnvelope(value, 1));
  }
  // Device clocks are not authoritative for R2 signatures. A clock set ahead
  // must not reject an otherwise valid envelope before the server evaluates it.
  assert.equal(
    validatePreparedUploadEnvelope(
      response({ uploads: [{ ...response().uploads[0], expiresAt: '2000-01-01T00:00:00.000Z' }] }),
      1,
    ).recording.id,
    recordingId,
  );
});

test('already outcomes reject upload URLs and retain server proof semantics', async () => {
  const { validatePreparedUploadEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  const already = response({ outcome: 'already_uploaded', uploads: undefined });
  assert.equal(validatePreparedUploadEnvelope(already, 1).outcome, 'already_uploaded');
  assert.throws(() => validatePreparedUploadEnvelope(response({ outcome: 'already_processed' }), 1));
});

test('upload conflict validation enforces typed stage/reason pairs', async () => {
  const { validateUploadIntentConflictDetails } = await loadPure('src/api/uploadPreparation.ts');
  assert.equal(
    validateUploadIntentConflictDetails({
      stage: 'confirm',
      reason: 'commit_state_changed',
      recoveryAction: 'inspect',
    }).reason,
    'commit_state_changed',
  );
  assert.throws(() =>
    validateUploadIntentConflictDetails({
      stage: 'confirm',
      reason: 'prepared_manifest_mismatch',
      recoveryAction: 'inspect',
    }),
  );
});

test('upload recovery envelope validates restart availability and replacement manifests', async () => {
  const { validateUploadIntentRecoveryEnvelope } = await loadPure('src/api/uploadPreparation.ts');
  const conflict = {
    stage: 'prepare',
    reason: 'prepared_manifest_mismatch',
    recoveryAction: 'inspect',
  };
  assert.equal(
    validateUploadIntentRecoveryEnvelope({ outcome: 'restart_available', conflict }, 1).outcome,
    'restart_available',
  );
  const prepared = {
    outcome: 'prepared',
    recording: response().recording,
    replacedRecordingId: recordingId,
    uploads: response().uploads,
    warnings: [],
  };
  assert.equal(validateUploadIntentRecoveryEnvelope(prepared, 1).outcome, 'prepared');
  assert.throws(() =>
    validateUploadIntentRecoveryEnvelope(
      { ...prepared, uploads: [{ ...prepared.uploads[0], index: 2 }] },
      1,
    ),
  );
});

test('pending-confirm validation accepts minimal native proof and strips PHI fields', async () => {
  const { validatePendingConfirm, toNativePendingConfirmProof } = await loadPure('src/lib/pendingConfirm.ts');
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
  const proof = toNativePendingConfirmProof(pending);
  assert.deepEqual(Object.keys(proof).sort(), ['fileKey', 'recordingId']);
  assert.equal(validatePendingConfirm(proof).recordingId, recordingId);
});

test('pending-confirm-only slots count as recoverable captured audio', async () => {
  const { slotHasRecoverableAudio } = await loadPure('src/types/multiPatient.ts');
  const empty = { segments: [], durable: null, pendingConfirm: null };
  assert.equal(slotHasRecoverableAudio(empty), false);
  assert.equal(
    slotHasRecoverableAudio({
      ...empty,
      pendingConfirm: {
        recordingId,
        fileKey: `recordings/${orgId}/${recordingId}.m4a`,
      },
    }),
    true,
  );
});

test('Patient ID clear intent distinguishes untouched blanks, explicit clears, and re-entry', async () => {
  const {
    nextPimsPatientIdExplicitlyCleared,
    isPimsPatientIdExplicitlyCleared,
  } = await loadPure('src/lib/pimsPatientIdIntent.ts');

  assert.equal(nextPimsPatientIdExplicitlyCleared('', '', false), false);
  assert.equal(nextPimsPatientIdExplicitlyCleared('', 'chart-1', false), false);
  assert.equal(nextPimsPatientIdExplicitlyCleared('chart-1', '', false), true);
  assert.equal(nextPimsPatientIdExplicitlyCleared('', '', true), true);
  assert.equal(nextPimsPatientIdExplicitlyCleared(null, '', false), true);
  assert.equal(nextPimsPatientIdExplicitlyCleared(null, 'chart-2', true), false);
  assert.equal(isPimsPatientIdExplicitlyCleared('', false), false);
  assert.equal(isPimsPatientIdExplicitlyCleared('', true), true);
  assert.equal(isPimsPatientIdExplicitlyCleared(null, false), true);
});

test('stable upload intents rotate when audio changes after R2 completion', async () => {
  const {
    normalizeUploadIntentId,
    normalizeUploadKeyOverride,
    normalizeSupersededUploadKey,
    slotUploadIdempotencyKey,
    durableUploadIdempotencyKey,
  } = await loadPure('src/lib/uploadIntent.ts');
  assert.equal(normalizeUploadIntentId(undefined, 'slot-7'), 'legacy:slot-7');
  assert.equal(normalizeUploadIntentId(undefined, 'slot-7'), 'legacy:slot-7');
  assert.equal(slotUploadIdempotencyKey('legacy:slot-7'), 'recording-upload-v1:slot:legacy:slot-7');
  assert.equal(durableUploadIdempotencyKey('native-9'), 'recording-upload-v1:durable:native-9');
  assert.equal(normalizeUploadKeyOverride('recording-upload-v2:restart:valid'), 'recording-upload-v2:restart:valid');
  assert.equal(normalizeUploadKeyOverride('recording-upload-v2:restart:bad\nheader'), null);
  assert.equal(normalizeSupersededUploadKey('recording-upload-v1:slot:valid'), 'recording-upload-v1:slot:valid');
  assert.equal(normalizeSupersededUploadKey('recording-upload-v1:slot:bad\rheader'), null);
  const reducer = await read('src/hooks/useMultiPatientSession.ts');
  const clear = reducer.slice(reducer.indexOf("case 'CLEAR_AUDIO'"), reducer.indexOf("case 'CONTINUE_RECORDING'"));
  const update = reducer.slice(reducer.indexOf("case 'UPDATE_FORM'"), reducer.indexOf("case 'SET_AUDIO_STATE'"));
  assert.match(clear, /uploadIntentId: createUploadIntentId\(\)/);
  assert.doesNotMatch(update, /createUploadIntentId|pendingConfirm: null/);
  assert.match(reducer, /function invalidatePendingConfirmForAudioChange/);
  assert.match(reducer, /if \(!slot\.pendingConfirm\) return \{ pendingConfirm: null \}/);
  assert.match(reducer, /uploadIntentId: createUploadIntentId\(\)/);
  for (const action of ['SAVE_AUDIO', 'CONTINUE_RECORDING', 'UPDATE_SEGMENT', 'DELETE_SEGMENT', 'REPLACE_ALL_SEGMENTS']) {
    const start = reducer.indexOf(`case '${action}'`);
    const end = reducer.indexOf("case '", start + 6);
    assert.match(reducer.slice(start, end === -1 ? undefined : end), /invalidatePendingConfirmForAudioChange/);
  }
  const restore = reducer.slice(
    reducer.indexOf("case 'RESTORE_SESSION'"),
    reducer.indexOf("case 'UPDATE_SEGMENT'"),
  );
  assert.match(restore, /uploadKeyOverride: normalizeUploadKeyOverride\(slot\.uploadKeyOverride\)/);
  assert.match(
    restore,
    /supersededUploadKey: normalizeSupersededUploadKey\(slot\.supersededUploadKey\)/,
  );

  const draftStorage = await read('src/lib/draftStorage.ts');
  assert.match(draftStorage, /uploadIntentRotated[\s\S]*slot\.serverDraftId \?\? null/);
  assert.match(draftStorage, /durableIntentRotated[\s\S]*slot\.serverDraftId \?\? null/);
  assert.match(draftStorage, /if \(clonePendingConfirm\(draft\.pendingConfirm\)\) continue/);
  const stashAudio = await read('src/lib/stashAudioManager.ts');
  assert.match(stashAudio, /else if \(!pendingConfirm\)/);
  assert.match(stashAudio, /s\.segments\.length > 0 \|\| s\.durable != null \|\| !!clonePendingConfirm\(s\.pendingConfirm\)/);
});

test('upload orchestration preserves ordering, persistence, fallback, and bounded recovery contracts', async () => {
  const api = await read('src/api/recordings.ts');
  const record = await read('app/(app)/(tabs)/record.tsx');
  const reducer = await read('src/hooks/useMultiPatientSession.ts');
  const strings = await read('src/constants/strings.ts');

  const execute = api.slice(api.indexOf('async function executeResilientUpload'), api.indexOf('export const recordingsApi'));
  assert.ok(execute.indexOf('preflightLocalFiles') < execute.indexOf('requestPreparation'));
  assert.match(api, /validatePreparedUploadEnvelope\(raw, expectedFileCount\)/);
  assert.match(api, /const keys = uploads\.map\(\(entry\) => entry\.fileKey\)/);
  assert.match(api, /runWithConcurrency\(files\.length, SEGMENT_UPLOAD_CONCURRENCY, uploadOne\)/);
  assert.match(api, /await invokePreparedCallback\(options\.onRecordingPrepared/);
  assert.match(api, /await invokeHintCallback\(options\.onR2Complete, hint\)/);
  assert.match(api, /PENDING_CONFIRM_PERSIST_TIMEOUT_MS/);
  assert.match(api, /RECORDING_ANCHOR_PERSIST_TIMEOUT_MS/);
  assert.match(api, /recording_anchor_write_timeout/);
  assert.match(api, /pending_confirm_write_timeout/);
  assert.match(api, /pending_confirm_clear_timeout/);
  assert.match(api, /persistence\.settled[\s\S]*invokeClearHint/);
  assert.match(api, /committed_late_anchor/);
  assert.match(api, /if \(usingRefreshedUrl\)/);
  assert.match(api, /error\.status !== 409 \|\| error\.code !== 'UPLOAD_INTENT_CONFLICT'/);
  assert.match(api, /isRouteLevelPrepare404\(error\)/);
  assert.match(api, /if \(!isRouteLevelPrepare404\(error\)\) throw error/);
  assert.match(api, /current\.status === 'draft' \|\| current\.status === 'uploading'|probedRecording\.status === 'draft'/);
  assert.match(api, /if \(staleRestartUsed\)/);
  assert.match(api, /staleRestartUsed = true/);
  assert.match(api, /isStaleCanonicalPreparationError/);
  assert.match(api, /trackStaleRecovery\('url_refresh', 'canonical_changed'/);
  assert.doesNotMatch(execute, /\.delete\(|safeDelete/);
  const legacy = api.slice(api.indexOf('async function legacyUpload'), api.indexOf('async function executeResilientUpload'));
  assert.match(legacy, /createdForLegacyUpload/);
  assert.match(legacy, /orphan_pending_confirm/);

  assert.match(record, /effectiveUploadIdempotencyKey\(/);
  assert.match(record, /supersededIdempotencyKey/);
  assert.match(
    record,
    /error\.recoveryOutcome === 'restart_available' && localAudioAvailableForRestart/,
  );
  assert.match(
    record,
    /if \(slot\.supersededUploadKey \|\| uploadRestartSlotIdsRef\.current\.has\(slotId\)\) return/,
  );
  assert.match(record, /markSubmitIntent\(\[slot\.id\]\)[\s\S]*persistControlledUploadRestart/);
  assert.match(
    record,
    /beginUploadAttemptReset[\s\S]*durableRecorder\.resetUploadAttempt[\s\S]*commitUploadAttemptReset/,
  );
  assert.match(record, /await draftStorage\.updatePendingConfirm/);
  assert.match(record, /recordingsApi\.confirmPendingUpload/);
  assert.match(record, /if \(slot\.pendingConfirm\)/);
  assert.match(record, /hasCompleteLocalAudio/);
  assert.match(record, /if \(!hasCompleteLocalAudio\)/);
  assert.match(record, /resume: slot\.pendingConfirm \?\? undefined/);
  const loadDraft = record.slice(
    record.indexOf('const loadDraft = useCallback('),
    record.indexOf('const { draftSlotId } = useLocalSearchParams'),
  );
  assert.ok(loadDraft.indexOf('validatePendingConfirm(draft.pendingConfirm)') < loadDraft.indexOf('fileExists(seg.uri)'));
  assert.match(loadDraft, /if \(!restoredPendingConfirm\)/);
  const continuation = record.slice(
    record.indexOf('const handleContinueRecording = useCallback('),
    record.indexOf('const handleRecordAgain = useCallback('),
  );
  assert.doesNotMatch(continuation, /deleteOrphanServerRecording/);
  assert.match(continuation, /slot\?\.pendingConfirm/);
  assert.doesNotMatch(continuation, /slot\?\.durable && slot\.pendingConfirm/);
  assert.match(record, /type: 'SET_PENDING_CONFIRM', slotId: slot\.id, pendingConfirm: null/);
  assert.match(record, /reason === 'committed_late_anchor' \|\| reason === 'committed_late_hint'/);
  assert.match(record, /await draftStorage\.deleteDraft\(draftSlotId\)/);
  assert.doesNotMatch(record, /setUploadStatus\(slot\.id, 'uploading', \{ pendingConfirm: null \}\)/);
  assert.match(record, /if \(slot\?\.pendingConfirm\) \{[\s\S]*?'Finish Submission First'/);
  assert.match(reducer, /case 'REPLACE_ALL_SEGMENTS':[\s\S]*?if \(slot\.pendingConfirm\) return slot/);
  assert.match(record, /slotHasRecoverableAudio\(s\)/);
  const card = await read('src/components/PatientSlotCard.tsx');
  const panel = await read('src/components/SubmitPanel.tsx');
  const stashes = await read('src/hooks/useStashedSessions.ts');
  assert.match(card, /const hasCapturedAudio = slotHasRecoverableAudio\(slot\)/);
  assert.match(card, /!hasPendingConfirm && !isFinishSaving/);
  assert.match(panel, /slotHasRecoverableAudio\(s\)/);
  assert.match(stashes, /pendingConfirm !== null/);
  assert.match(stashes, /requiredPreStashSegmentCount/);
  assert.match(stashes, /clonePendingConfirm\(sourceSlot\?\.pendingConfirm\) \? 0 : stashedSlot\.segments\.length/);
  const draftSync = record.slice(
    record.indexOf('const syncServerDraft = useCallback('),
    record.indexOf('const scheduleDraftSync = useCallback('),
  );
  assert.doesNotMatch(draftSync, /deleteRecordingWithRetry\(serverId/);
  assert.match(
    draftSync,
    /if \(slot\.supersededUploadKey \|\| uploadRestartSlotIdsRef\.current\.has\(slotId\)\) return/,
  );
  assert.match(strings, /We couldn't finish the upload\. The recording is still saved on this device/);

  const pendingDraftSync = await read('src/hooks/usePendingDraftSync.ts');
  assert.match(
    pendingDraftSync,
    /draft\.supersededUploadKey \|\| draft\.uploadRestartPending/,
  );
});

test('native durable manifests persist and hydrate only non-PHI confirmation proof', async () => {
  const bridge = await read('modules/captivet-durable-recorder/index.ts');
  const android = await read('modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt');
  const ios = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(bridge, /typeof mod\.setPendingConfirm !== 'function'/);
  assert.match(bridge, /toNativePendingConfirmProof/);
  assert.match(bridge, /JSON\.parse\(manifest\.pendingConfirmJson\)/);
  assert.match(bridge, /pendingConfirmJson: proofJson/);
  assert.doesNotMatch(
    bridge.slice(bridge.indexOf('export async function setPendingConfirm'), bridge.indexOf('function hydratePendingConfirm')),
    /metadata|files/,
  );
  assert.match(android, /mutateManifest\(ctx\.applicationContext, uId, rId\) \{ it\.pendingConfirmJson = pendingJson \}/);
  assert.match(ios, /mutateManifestAtomically\(userId: userId, recordingId: recordingId\)/);
  assert.match(ios, /manifest\.pendingConfirmJson = pendingConfirmJson/);
});

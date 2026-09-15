import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';
const { getRecordingFailureAction: action, getRecordingFailureRemedyCategory: category, isRecordingPermanentFailure, RECORDING_PERMANENT_ERROR_CODES } = await loadTsModule('src/lib/recordingRetryState.ts');
const cat = (...ids) => ({ default: ids[0] ?? null, options: ids.map(id => ({ id, label: id })) });
const models = { transcription: cat('gemini-3.5-transcribe', 'nova-3-medical', 'nova-3'), soap: cat('gemini-a', 'claude-a') };
const failure = (errorCode, extra = {}) => ({ status: 'failed', errorCode, costBreakdown: { transcriptionModel: 'nova-3', modelUsed: 'gemini-a' }, ...extra });

test('verified permanent codes and remedy categories stay separate', () => {
  const permanent = ['INVALID_AUDIO', 'AUDIO_TOO_LONG', 'MISSING_AUDIO', 'MISSING_DEEPGRAM_KEY', 'INVALID_DEEPGRAM_KEY', 'MISSING_TRANSCRIPTION_KEY', 'INVALID_TRANSCRIPTION_KEY', 'MISSING_LLM_KEY', 'INVALID_LLM_KEY', 'PAYMENT_REQUIRED', 'CREDENTIALS_REQUIRED', 'TRIAL_SOAP_LIMIT_REACHED', 'R2_NOT_CONFIGURED', 'IMPORT_FAILED'];
  assert.equal(RECORDING_PERMANENT_ERROR_CODES.size, 14);
  for (const code of permanent) assert.equal(isRecordingPermanentFailure(code), true);
  for (const code of ['AUDIO_TOO_LONG', 'MISSING_DEEPGRAM_KEY', 'INVALID_DEEPGRAM_KEY', 'MISSING_TRANSCRIPTION_KEY', 'INVALID_TRANSCRIPTION_KEY']) assert.equal(category(code), 'transcription');
  for (const code of ['MISSING_LLM_KEY', 'INVALID_LLM_KEY']) assert.equal(category(code), 'soap');
  for (const code of permanent.filter(code => !code.endsWith('_KEY') && code !== 'AUDIO_TOO_LONG')) {
    assert.equal(category(code), null);
    assert.equal(action(failure(code), models), 'retry');
  }
  for (const code of ['TRANSCRIPTION_FAILED', 'UNKNOWN', null, undefined]) {
    assert.equal(isRecordingPermanentFailure(code), false);
    assert.equal(action(failure(code), models), 'retry');
  }
});

test('failure action table covers status, missing models and unusable categories', () => {
  assert.equal(action(failure('AUDIO_TOO_LONG'), models), 'reprocess');
  for (const status of ['retry_scheduled', 'transcribing', 'generating', 'completed']) assert.equal(action(failure('AUDIO_TOO_LONG', { status }), models), 'retry');
  for (const input of [null, undefined]) assert.equal(action(failure('AUDIO_TOO_LONG'), input), 'retry');
  for (const failing of ['AUDIO_TOO_LONG', 'INVALID_LLM_KEY']) {
    for (const empty of ['transcription', 'soap']) assert.equal(action(failure(failing), { ...models, [empty]: cat() }), 'reprocess_blocked');
  }
  assert.equal(action(failure('AUDIO_TOO_LONG'), { ...models, transcription: cat('gemini-3.5-transcribe') }), 'reprocess_blocked');
});

test('key failures need recognized distinct providers in the failing category', () => {
  for (const code of ['INVALID_DEEPGRAM_KEY', 'MISSING_TRANSCRIPTION_KEY']) {
    assert.equal(action(failure(code), models), 'reprocess');
    assert.equal(action(failure(code), { ...models, transcription: cat('nova-3', 'nova-3-medical', 'unknown') }), 'reprocess_blocked');
  }
  assert.equal(action(failure('INVALID_LLM_KEY'), { ...models, soap: cat('gemini-a', 'gemini-b', 'unknown') }), 'reprocess_blocked');
  assert.equal(action(failure('INVALID_LLM_KEY'), models), 'reprocess');
  assert.equal(action(failure('INVALID_TRANSCRIPTION_KEY', { foreignLanguage: true }), { ...models, transcription: cat('nova-3-medical', 'nova-3') }), 'reprocess_blocked');
  assert.equal(action(failure('INVALID_LLM_KEY', { foreignLanguage: true }), { ...models, transcription: cat('gemini-3.5-transcribe') }), 'reprocess');
});

test('detail wires gated inline remedy, shared query, secondary Retry and clipboard-only details', async () => {
  const detail = await readFile(new URL('../app/(app)/(tabs)/recordings/[id].tsx', import.meta.url), 'utf8');
  assert.match(detail, /queryKey: \['orgAiModels'\]/);
  assert.match(detail, /refetchOnMount: 'always',[\s\S]*?enabled: !!user && canRecordAppointments/);
  assert.match(detail, /getRecordingFailureAction\(recording, aiModels\)/);
  assert.match(detail, /showFailureRemedy = canRetryProcessing && retryPresentation === 'retry'/);
  assert.match(detail, /remedyCategory=\{offerRemedy \? remedyCategory/);
  assert.match(detail, /remedyErrorCode=\{offerRemedy \? recording.errorCode/);
  const failed = detail.slice(detail.indexOf('{/* Failed */}'), detail.indexOf('{/* Transcript Quality'));
  assert.match(failed, /variant=\{showFailureRemedy \? 'secondary' : 'primary'\}/);
  assert.match(failed, /<\/Card>\s*\{offerRemedy && reprocessSheet\}/);
  assert.match(failed, /copyWithAutoClear\(recording.errorMessage/);
  assert.doesNotMatch(failed, /\{recording.errorMessage\}/);
  assert.match(failed, /recording.errorCode === 'AUDIO_TOO_LONG'/);
  assert.match(failed, /user\?\.role === 'owner' \|\| user\?\.role === 'admin'/);
  assert.match(detail, /canReprocess && !showFailureRemedy/);
  assert.match(detail, /!showFailureRemedy && reprocessSheet/);
});

test('sheet validates refreshed selections, normalizes changes and keeps safe errors and MFA', async () => {
  const sheet = await readFile(new URL('../src/components/ReprocessSheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /getInitialReprocessSelection\(models, selectionOptions\)/);
  assert.match(sheet, /reconcileReprocessSelection\(models, previous, selectionOptions\)/);
  assert.match(sheet, /normalizeForForeignLanguage\(v, recordingForeignLanguage\)/);
  assert.match(sheet, /isReprocessSelectionValid\(current.effectiveModels, submitted, current.selectionOptions\)/);
  assert.match(sheet, /disabled=\{mutation.isPending \|\| !selectionValid\}/);
  assert.match(sheet, /mutation.mutate\(confirmedSelection\)/);
  assert.match(sheet, /error.code === 'MFA_REQUIRED'/);
  assert.doesNotMatch(sheet, /error.message/);
  assert.match(sheet, /friendlyErrorMessage\(error\)/);
  assert.match(sheet, /REPROCESS_MODELS_COPY.foreignLanguage/);
  assert.match(sheet, /getCurrentModelLabel\(transcriptionModelId, effectiveModels.transcription\)/);
  assert.match(sheet, /getCurrentModelLabel\(soapModel, effectiveModels.soap\)/);
});


test('single alternatives remain actionable after the failed provider is filtered out', () => {
  const onlyGemini = { transcription: cat('gemini-3.5-transcribe'), soap: cat('gemini-a') };
  assert.equal(action(failure('MISSING_DEEPGRAM_KEY', { costBreakdown: null }), onlyGemini), 'reprocess');
  assert.equal(action(failure('INVALID_LLM_KEY', { costBreakdown: { modelUsed: 'claude-a' } }), onlyGemini), 'reprocess');
  assert.equal(action(failure('AUDIO_TOO_LONG'), { transcription: cat('nova-3'), soap: cat('gemini-a') }), 'reprocess');
  assert.equal(action(failure('INVALID_LLM_KEY', { costBreakdown: null }), onlyGemini), 'reprocess_blocked');
});

test('detail and sheet expose a single remedy and limit setup advice to blocked remedies', async () => {
  const detail = await readFile(new URL('../app/(app)/(tabs)/recordings/[id].tsx', import.meta.url), 'utf8');
  assert.match(detail, /failureAction === 'reprocess' \|\| hasVisibleReprocessModelChoice/);
  assert.match(detail, /showFailureRemedy && failureAction === 'reprocess_blocked' && \(/);
  const sheet = await readFile(new URL('../src/components/ReprocessSheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /selectionOptions = useMemo[\s\S]*?currentTranscriptionModel, currentSoapModel/);
  assert.match(sheet, /showTranscriptionPicker \|\| remedyCategory === 'transcription'/);
  assert.match(sheet, /showSoapPicker \|\| remedyCategory === 'soap'/);
});

test('persisted failed-run pins win over cost metadata from an older success', () => {
  const onlyGemini = { transcription: cat('gemini-3.5-transcribe'), soap: cat('gemini-a') };
  assert.equal(action(failure('INVALID_LLM_KEY', {
    reprocessSoapModel: 'claude-a',
    costBreakdown: { modelUsed: 'gemini-a' },
  }), onlyGemini), 'reprocess');
  assert.equal(action(failure('INVALID_TRANSCRIPTION_KEY', {
    reprocessTranscriptionModel: 'nova-3',
    costBreakdown: { transcriptionModel: 'gemini-3.5-transcribe' },
  }), onlyGemini), 'reprocess');
});

test('first-run generic missing-key errors allow configured models without cost metadata', () => {
  const available = { transcription: cat('gemini-3.5-transcribe'), soap: cat('claude-a') };
  for (const code of ['MISSING_LLM_KEY', 'MISSING_TRANSCRIPTION_KEY']) {
    assert.equal(action(failure(code, { costBreakdown: null }), available), 'reprocess');
    for (const empty of ['transcription', 'soap']) {
      assert.equal(action(failure(code, { costBreakdown: null }), { ...available, [empty]: cat() }), 'reprocess_blocked');
    }
  }
  for (const code of ['INVALID_LLM_KEY', 'INVALID_TRANSCRIPTION_KEY']) {
    assert.equal(action(failure(code, { costBreakdown: null }), available), 'reprocess_blocked');
  }
});

test('detail passes persisted reprocess pins to the chooser ahead of historical costs', async () => {
  const detail = await readFile(new URL('../app/(app)/(tabs)/recordings/[id].tsx', import.meta.url), 'utf8');
  assert.match(detail, /currentSoapModel=\{recording.reprocessSoapModel \?\? recording.costBreakdown\?\.modelUsed\}/);
  assert.match(detail, /currentTranscriptionModel=\{recording.reprocessTranscriptionModel \?\? recording.costBreakdown\?\.transcriptionModel\}/);
});


test('legacy cost provider IDs still expose alternatives', () => {
  const available = { transcription: cat('nova-3'), soap: cat('gemini-a', 'claude-a') };
  for (const modelUsed of ['gemini', 'anthropic']) {
    assert.equal(action(failure('INVALID_LLM_KEY', { costBreakdown: { modelUsed } }), available), 'reprocess');
  }
});

test('confirmation submits its captured choice even after selection reconciliation', async () => {
  const { isReprocessSelectionValid } = await loadTsModule('src/lib/aiModels.ts');
  const sheet = await readFile(new URL('../src/components/ReprocessSheet.tsx', import.meta.url), 'utf8');
  const handler = sheet.match(/onPress=\{\(\) => \{\s*(if \(!selectionValid\) return;[\s\S]*?)\n          \}\}/)?.[1];
  assert.ok(handler, 'execute the real confirmation-opening handler');
  let buttons;
  let submitted;
  const resolvedSelection = { transcriptionModelId: 'nova-3', soapModel: 'gemini-a' };
  const current = { resolvedSelection };
  const run = new Function('selectionValid', 'resolvedSelection', 'Alert', 'mutation', 'REPROCESS_MODELS_COPY', 'latest', handler);
  run(true, resolvedSelection, { alert: (_title, _body, actions) => { buttons = actions; } },
    { mutate: (selection) => { submitted = selection; } }, {}, { current });
  // Simulate an options refresh while the native alert stays open.
  resolvedSelection.soapModel = 'claude-a';
  current.resolvedSelection = { transcriptionModelId: 'nova-3', soapModel: 'claude-a' };
  buttons[1].onPress();
  assert.deepEqual(submitted, { transcriptionModelId: 'nova-3', soapModel: 'gemini-a' });
  assert.equal(isReprocessSelectionValid({ transcription: cat('nova-3'), soap: cat('claude-a') }, submitted), false);
});

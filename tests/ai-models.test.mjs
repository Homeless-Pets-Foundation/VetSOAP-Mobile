import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
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

test('normalizeOrgAiModels tolerates malformed shapes (rule 10)', async () => {
  const { normalizeOrgAiModels } = await loadTsModule('src/lib/aiModels.ts');

  // JSON compare avoids cross-realm prototype mismatch (vm-context objects vs test realm).
  const j = (v) => JSON.stringify(v);

  // null / undefined body → empty categories, null defaults
  const expectedEmpty = { transcription: { default: null, options: [] }, soap: { default: null, options: [] } };
  assert.equal(j(normalizeOrgAiModels(null)), j(expectedEmpty));
  assert.equal(j(normalizeOrgAiModels(undefined)), j(expectedEmpty));

  // missing category
  const onlyTranscription = normalizeOrgAiModels({
    transcription: { default: 'nova-3', options: [{ id: 'nova-3', label: 'Nova 3' }] },
  });
  assert.equal(onlyTranscription.soap.default, null);
  assert.equal(onlyTranscription.soap.options.length, 0);

  // non-array options → []
  const badOptions = normalizeOrgAiModels({ transcription: { options: 'nope' }, soap: {} });
  assert.equal(badOptions.transcription.options.length, 0);

  // option missing id/label is filtered out
  const filtered = normalizeOrgAiModels({
    soap: {
      default: 'gemini',
      options: [
        { id: 'gemini', label: 'Gemini' },
        { id: 'no-label' },
        { label: 'no-id' },
        null,
        'string',
      ],
    },
    transcription: {},
  });
  assert.equal(j(filtered.soap.options), j([{ id: 'gemini', label: 'Gemini' }]));

  // default not in options → first option
  const reset = normalizeOrgAiModels({
    soap: {
      default: 'anthropic',
      options: [{ id: 'gemini', label: 'Gemini' }],
    },
    transcription: {},
  });
  assert.equal(reset.soap.default, 'gemini');

  // empty options → default null even when a string default was sent
  const emptyDefault = normalizeOrgAiModels({ soap: { default: 'gemini', options: [] }, transcription: {} });
  assert.equal(emptyDefault.soap.default, null);
});

test('hasSelectableModels requires both usable + at least one real choice', async () => {
  const { hasSelectableModels } = await loadTsModule('src/lib/aiModels.ts');

  const cat = (def, ids) => ({ default: def, options: ids.map((id) => ({ id, label: id })) });

  // both single → no choice → false
  assert.equal(
    hasSelectableModels({ transcription: cat('a', ['a']), soap: cat('x', ['x']) }),
    false
  );
  // transcription has 2 → choice exists → true
  assert.equal(
    hasSelectableModels({ transcription: cat('a', ['a', 'b']), soap: cat('x', ['x']) }),
    true
  );
  // soap has 2 → true
  assert.equal(
    hasSelectableModels({ transcription: cat('a', ['a']), soap: cat('x', ['x', 'y']) }),
    true
  );
  // soap empty/no default → not usable → false even though transcription has a choice
  assert.equal(
    hasSelectableModels({ transcription: cat('a', ['a', 'b']), soap: { default: null, options: [] } }),
    false
  );
  // transcription empty → false
  assert.equal(
    hasSelectableModels({ transcription: { default: null, options: [] }, soap: cat('x', ['x', 'y']) }),
    false
  );
});

test('hasVisibleReprocessModelChoice ignores hidden foreign-language transcription choices', async () => {
  const { FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL, hasVisibleReprocessModelChoice } =
    await loadTsModule('src/lib/aiModels.ts');

  const cat = (def, ids) => ({ default: def, options: ids.map((id) => ({ id, label: id })) });
  const models = {
    transcription: cat(FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL, [
      FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL,
      'nova-3-medical',
    ]),
    soap: cat('glm', ['glm']),
  };

  assert.equal(hasVisibleReprocessModelChoice(models), true);
  assert.equal(hasVisibleReprocessModelChoice(models, { recordingForeignLanguage: true }), false);
  assert.equal(
    hasVisibleReprocessModelChoice(
      {
        transcription: cat(FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL, [
          FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL,
          'nova-3-medical',
        ]),
        soap: cat('glm', ['glm', 'gemini']),
      },
      { recordingForeignLanguage: true }
    ),
    true
  );
  assert.equal(
    hasVisibleReprocessModelChoice(
      {
        transcription: cat('nova-3-medical', ['nova-3-medical']),
        soap: cat('glm', ['glm', 'gemini']),
      },
      { recordingForeignLanguage: true }
    ),
    false
  );
});

test('getCurrentModelLabel maps id → label, falls back to raw id', async () => {
  const { getCurrentModelLabel } = await loadTsModule('src/lib/aiModels.ts');

  const cat = { default: 'gemini', options: [{ id: 'gemini', label: 'Gemini (Google)' }] };
  assert.equal(getCurrentModelLabel(null, cat), '');
  assert.equal(getCurrentModelLabel(undefined, cat), '');
  assert.equal(getCurrentModelLabel('gemini', cat), 'Gemini (Google)');
  // id not in options (e.g. a raw model string from costBreakdown) → raw value, never blank
  assert.equal(getCurrentModelLabel('gemini-2.5-pro', cat), 'gemini-2.5-pro');
});

const ai = await loadTsModule('src/lib/aiModels.ts');
const cat = (...ids) => ({ default: ids[0] ?? null, options: ids.map(id => ({ id, label: id })) });
const gemini = 'gemini-3.5-transcribe';
const models = { transcription: cat(gemini, 'nova-3-medical', 'nova-3'), soap: cat('gemini-3.8-flash', 'gemini-3.7-flash', 'claude-opus-4-7') };

test('remedy selection excludes defaults or explicit IDs with safe fallback', () => {
  assert.equal(ai.pickRemedyModel(models.transcription), 'nova-3-medical');
  assert.equal(ai.pickRemedyModel(models.transcription, { excludeModelId: 'nova-3-medical' }), gemini);
  assert.equal(ai.pickRemedyModel(cat()), null);
  assert.equal(ai.pickRemedyModel(cat('nova-3')), 'nova-3');
  assert.equal(ai.pickRemedyModel(models.soap, { requireDistinctProvider: true }), 'claude-opus-4-7');
  assert.equal(ai.pickRemedyModel(cat('gemini-a', 'gemini-b'), { requireDistinctProvider: true }), 'gemini-b');
});

test('provider mapping recognizes supported families and ignores unknown IDs', () => {
  for (const [id, provider] of [['nova-3', 'deepgram'], ['nova-3-medical', 'deepgram'], [gemini, 'gemini'], ['claude-a', 'anthropic'], ['gpt-a', 'openai'], ['glm-a', 'z_ai'], ['muse-spark-a', 'meta']]) {
    assert.equal(ai.deriveModelProvider(id), provider);
  }
  for (const id of ['unknown', '', null, 'nova-unknown']) assert.equal(ai.deriveModelProvider(id), null);
});

test('foreign-language filtering retains Gemini, normalizes only Deepgram and never invents Nova', () => {
  for (const [id, foreign, expected] of [['nova-3-medical', true, 'nova-3'], [gemini, true, gemini], [null, true, null], ['nova-3-medical', false, 'nova-3-medical']]) {
    assert.equal(ai.normalizeForForeignLanguage(id, foreign), expected);
  }
  const effective = ai.getEffectiveReprocessModels(models, true);
  assert.equal(effective.transcription.options.map(o => o.id).join(','), `${gemini},nova-3`);
  assert.equal(effective.transcription.default, gemini);
  assert.equal(ai.getEffectiveTranscriptionCategory(cat('nova-3-medical'), true).default, null);
  const geminiOnly = { ...models, transcription: cat(gemini) };
  assert.equal(ai.hasVisibleReprocessModelChoice(geminiOnly, { recordingForeignLanguage: true }), true);
  assert.equal(ai.hasReprocessRemedyForCategory(geminiOnly, 'soap', { recordingForeignLanguage: true }), true);
});

test('initial selection changes only the remedy category, including changed org defaults', () => {
  const options = { remedyCategory: 'transcription', remedyErrorCode: 'AUDIO_TOO_LONG' };
  const changed = { ...models, transcription: { ...models.transcription, default: 'nova-3' } };
  for (const input of [models, changed]) {
    const selected = ai.getInitialReprocessSelection(input, options);
    assert.equal(selected.transcriptionModelId, 'nova-3-medical');
    assert.equal(selected.soapModel, models.soap.default);
    assert.equal(ai.getInitialReprocessSelection(input, { ...options, recordingForeignLanguage: true }).transcriptionModelId, 'nova-3');
  }
  const soap = ai.getInitialReprocessSelection(models, { remedyCategory: 'soap', remedyErrorCode: 'INVALID_LLM_KEY' });
  assert.equal(soap.soapModel, 'claude-opus-4-7');
  assert.equal(soap.transcriptionModelId, gemini);
  const tx = ai.getInitialReprocessSelection({ ...models, transcription: cat('nova-3-medical', 'nova-3', gemini) }, { remedyCategory: 'transcription', remedyErrorCode: 'INVALID_DEEPGRAM_KEY' });
  assert.equal(tx.transcriptionModelId, gemini);
});

test('refresh preserves valid manual choices and reconciles removed or hidden selections', () => {
  const options = { remedyCategory: 'soap', remedyErrorCode: 'INVALID_LLM_KEY', recordingForeignLanguage: true };
  const selection = { transcriptionModelId: gemini, soapModel: 'gemini-3.7-flash' };
  assert.equal(JSON.stringify(ai.reconcileReprocessSelection(models, selection, options)), JSON.stringify(selection));
  const removed = { ...models, soap: cat('gemini-3.8-flash', 'gpt-5.5') };
  assert.equal(ai.reconcileReprocessSelection(removed, selection, options).soapModel, 'gpt-5.5');
  const hidden = { ...selection, transcriptionModelId: 'nova-3-medical' };
  const effective = ai.getEffectiveReprocessModels(models, true);
  assert.equal(ai.isReprocessSelectionValid(effective, hidden), false);
  const fixed = ai.reconcileReprocessSelection(models, hidden, options);
  assert.equal(fixed.transcriptionModelId, 'nova-3');
  assert.equal(ai.isReprocessSelectionValid(effective, fixed), true);
  assert.equal(ai.isReprocessSelectionValid(effective, { ...fixed, soapModel: 'removed' }), false);
  assert.equal(ai.isReprocessSelectionValid(effective, { ...fixed, transcriptionModelId: null }), false);
});

test('refreshing defaults preserves valid choices and removed transcription uses the remedy rules', () => {
  const selection = { transcriptionModelId: 'nova-3-medical', soapModel: 'claude-opus-4-7' };
  const changed = { transcription: { ...models.transcription, default: 'nova-3' }, soap: { ...models.soap, default: 'gemini-3.7-flash' } };
  assert.equal(JSON.stringify(ai.reconcileReprocessSelection(changed, selection)), JSON.stringify(selection));
  const removed = { ...changed, transcription: cat(gemini, 'nova-3') };
  const fixed = ai.reconcileReprocessSelection(removed, selection, { remedyCategory: 'transcription', remedyErrorCode: 'AUDIO_TOO_LONG' });
  assert.equal(fixed.transcriptionModelId, 'nova-3');
  assert.equal(fixed.soapModel, selection.soapModel);
  const disclosure = { ...models, transcription: { default: gemini, options: [{ id: gemini, label: 'Gemini (free tier may train on audio)' }, { id: 'nova-3', label: 'Nova 3' }] } };
  assert.equal(ai.getEffectiveReprocessModels(disclosure, true).transcription.options[0].label, disclosure.transcription.options[0].label);
});

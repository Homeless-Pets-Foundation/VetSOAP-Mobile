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

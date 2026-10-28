import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const strings = await loadTsModule('src/constants/strings.ts');
const copy = strings.TEMPLATE_AVAILABILITY_COPY;
const source = await readFile(new URL('src/components/PatientForm.tsx', root), 'utf8');
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {},
  Fragment: 'Fragment',
};
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText, {
  exports: module.exports, module,
  require: (name) => name === 'react' ? { __esModule: true, default: react, ...react }
    : name.endsWith('constants/strings') ? strings
      : name.endsWith('useThemeColors') ? { useThemeColors: () => ({}) }
        : new Proxy({}, { get: (_target, key) => key }),
});

function nodes(node) {
  return !node || typeof node !== 'object' ? []
    : [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
}

function render(props = {}) {
  const tree = module.exports.PatientForm({
    formData: { patientName: '' }, onUpdate() {}, templates: [], ...props,
  });
  const all = nodes(tree);
  return {
    texts: all.flatMap((node) => node.props?.children ?? []).flat(Infinity).filter((value) => typeof value === 'string'),
    find: (type) => all.filter((node) => node.type === type),
  };
}

test('initial loading, successful empty and failed loading have distinct truthful guidance', () => {
  const loading = render({ templatesLoading: true });
  assert(loading.texts.includes(copy.loading));
  assert(!loading.texts.includes(copy.empty));
  assert(render().texts.includes(copy.empty));
  const failed = render({ templatesError: true });
  assert(failed.texts.includes(copy.failed));
  assert(!failed.texts.includes(copy.empty));
});

test('retry is actionable and shows in-flight feedback', () => {
  let retried = 0;
  const onRetryTemplates = () => { retried++; };
  const failed = render({ templatesError: true, templatesRetrying: true, onRetryTemplates });
  const retry = failed.find('Button').find((button) => button.props.onPress === onRetryTemplates);
  assert.equal(retry.props.loading, true);
  retry.props.onPress();
  assert.equal(retried, 1);
});

test('background refresh failure retains cached options, selection and default state', () => {
  const updates = [];
  const view = render({
    templates: [{ id: 'saved', name: 'Saved template' }], templatesError: true,
    formData: { patientName: '', templateId: 'saved' }, defaultTemplateId: 'saved',
    onSetDefaultTemplate() {}, onUpdate: (...args) => updates.push(args),
  });
  assert(view.texts.includes(copy.refreshFailed));
  assert(!view.texts.includes(copy.noSelection));
  assert(view.texts.includes(strings.TEMPLATE_DEFAULT_COPY.defaultLabel));
  assert.equal(view.find('SegmentedControl')[0].props.value, 'saved');
  assert.equal(view.find('SegmentedControl')[0].props.options[0].value, 'saved');
  assert.deepEqual(updates, []);
});

test('absent selection is explicit; an unavailable saved selection is explained and never cleared', () => {
  assert(render().texts.includes(copy.noSelection));
  const updates = [];
  const missing = render({
    templates: [{ id: 'available', name: 'Available' }],
    formData: { patientName: '', templateId: 'unavailable' },
    onUpdate: (...args) => updates.push(args),
  });
  assert(missing.texts.includes(copy.unavailable));
  assert(!missing.texts.includes(copy.noSelection));
  assert.equal(missing.find('SegmentedControl')[0].props.value, 'unavailable');
  assert.deepEqual(updates, []);
  const unknown = render({ formData: { patientName: '', templateId: 'saved' }, templatesError: true });
  assert(!unknown.texts.includes(copy.unavailable), 'a failed first fetch cannot prove unavailability');
});

test('template selection retains existing species autofill and explicit deselection behavior', () => {
  const updates = [];
  const view = render({
    templates: [{ id: 'feline', name: 'Feline', species: ['Feline'] }],
    onUpdate: (...args) => updates.push(args),
  });
  const select = view.find('SegmentedControl')[0];
  select.props.onValueChange('feline');
  assert.deepEqual(updates, [['templateId', 'feline'], ['species', 'Feline']]);
  updates.length = 0;
  select.props.onValueChange(null);
  assert.deepEqual(updates, [['templateId', undefined]]);
});

test('template hook exposes cached data, default, refetch and fetching state', async () => {
  const template = { id: 'default', isDefault: true };
  const query = { data: [template], isLoading: false, isPending: false, isFetching: true, error: new Error('offline'), refetch() {} };
  const { useTemplates } = await loadTsModule('src/hooks/useTemplates.ts', {
    '@tanstack/react-query': { useQuery: () => query },
    '../api/templates': { templatesApi: { list: async () => ({ data: [] }) } },
  });
  const result = useTemplates();
  assert.equal(result.templates, query.data);
  assert.equal(result.defaultTemplate, template);
  assert.equal(result.error, query.error);
  assert.equal(result.refetch, query.refetch);
  assert.equal(result.isFetching, true);
});

test('first offline pending query is never reported as successfully empty', async () => {
  const { useTemplates } = await loadTsModule('src/hooks/useTemplates.ts', {
    '@tanstack/react-query': { useQuery: () => ({ data: undefined, isPending: true, isLoading: false, isFetching: false, error: null }) },
    '../api/templates': { templatesApi: { list: async () => ({ data: [] }) } },
  });
  assert.equal(useTemplates().isLoading, true);
});

test('template error, retry and fetching changes reach every Record pager dependency', async () => {
  const record = await readFile(new URL('app/(app)/(tabs)/record.tsx', root), 'utf8');
  const slot = await readFile(new URL('src/components/PatientSlotCard.tsx', root), 'utf8');
  for (const name of ['templatesError', 'templatesRetrying', 'handleRetryTemplates']) {
    assert(record.split(name).length - 1 >= 4, `${name} must reach renderItem dependencies and FlatList extraData`);
  }
  assert.match(record, /onRetryTemplates=\{handleRetryTemplates\}/);
  assert.match(slot, /templatesError=\{templatesError\}/);
  assert.match(slot, /templatesRetrying=\{templatesRetrying\}/);
  assert.match(slot, /onRetryTemplates=\{onRetryTemplates\}/);
});

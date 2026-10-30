import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const strings = await loadTsModule('src/constants/strings.ts');
const copy = strings.EXPORT_COPY;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function hooks() {
  const values = [];
  let index = 0;
  let effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment',
    useState(initial) {
      const i = index++;
      if (i >= values.length) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], (next) => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
    },
    useRef: (initial) => react.useState(() => ({ current: initial }))[0],
    useMemo(callback, dependencies) {
      const i = index++;
      if (!values[i] || dependencies.some((value, j) => !Object.is(value, values[i].dependencies[j]))) {
        values[i] = { dependencies, value: callback() };
      }
      return values[i].value;
    },
    useCallback: (callback, dependencies) => react.useMemo(() => callback, dependencies),
    useEffect(callback, dependencies) {
      const i = index++;
      const previous = values[i];
      if (!previous || dependencies.some((value, j) => !Object.is(value, previous.dependencies[j]))) {
        effects.push(() => { previous?.cleanup?.(); values[i] = { dependencies, cleanup: callback() }; });
      }
    },
    memo: (component, compare) => Object.assign(component, { compare }),
  };
  return {
    react,
    render(component, props) {
      index = 0;
      effects = [];
      const tree = component(props);
      for (const effect of effects) effect();
      return tree;
    },
    unmount: () => values.forEach((value) => value?.cleanup?.()),
  };
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}

async function loadTsx(path, mocks) {
  const module = { exports: {} };
  const source = await readFile(new URL(path, root), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports,
    require: (name) => { assert(name in mocks, `Unexpected dependency ${name}`); return mocks[name]; },
  });
  return module.exports;
}

async function harness({ mark = async () => returnedNote, shareResult = true } = {}) {
  const h = hooks();
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const timers = [];
  const cache = await loadTsModule('src/lib/recordingQueryCache.ts', {
    './attentionFeed': { validateAttentionListRow: () => null },
  }, { setTimeout: (callback) => { timers.push(callback); return timers.length; } });
  const calls = { mark: [], copy: 0, text: 0, pdf: 0, events: [] };
  const sharing = await loadTsModule('src/lib/share.ts', {
    'react-native': {
      Share: {
        sharedAction: 'sharedAction',
        share: async () => {
          calls.text++;
          return { action: shareResult ? 'sharedAction' : 'dismissedAction' };
        },
      },
    },
    './fileOps': { safeDeleteFile() {} },
  });
  let user = { id: 'user1', organizationId: 'org1' };
  const api = await loadTsx('src/components/ExportSheet.tsx', {
    react: h.react, 'react-native': { View: 'View' }, './ui/Text': { Text: 'Text' },
    'lucide-react-native': {},
    'expo-haptics': { NotificationFeedbackType: { Success: 'success' }, notificationAsync: async () => {} },
    '@tanstack/react-query': { useQueryClient: () => client },
    '../hooks/useAuth': { useAuthUser: () => user },
    '../lib/recordingQueryCache': cache,
    '../api/soapNotes': { soapNotesApi: { export: (...args) => { calls.mark.push(args); return mark(...args); } } },
    '../constants/strings': strings,
    '../lib/analytics': { trackEvent: (event) => calls.events.push(event) },
    '../lib/secureClipboard': { copyWithAutoClear: async () => { calls.copy++; } },
    '../lib/soapPdf': { buildSoapPlainText: () => 'Synthetic SOAP', buildSoapHtml: () => '<p>Synthetic SOAP</p>' },
    '../lib/share': {
      shareText: sharing.shareText,
      sharePdfHtml: async () => { calls.pdf++; return shareResult; },
    },
    './ui/Button': { Button: 'Button' }, './ui/Card': { Card: 'Card' }, './Toast': { Toast: 'Toast' },
    '../hooks/useThemeColors': { useThemeColors: () => ({}) },
    './ui/styles': { CLIP_SAFE: {}, clipSafe: (value) => value },
  });
  client.setQueryData(['recording', recording.id], recording);
  client.setQueryData(['soapNote', recording.id], originalNote);
  client.setQueryData(['recordings', 'recent'], { data: [recording], total: 1 });
  client.setQueryData(['recordings', 'list', '', 'all'], { pages: [{ data: [recording], total: 1 }], pageParams: [1] });
  const render = (note = originalNote) => h.render(api.ExportSheet, { recording, soapNote: note });
  const press = (label) => {
    const button = nodes(render()).find((node) => node.type === 'Button' && node.props.children.includes(label));
    assert(button, `Missing button ${label}`);
    button.props.onPress();
  };
  return { ...h, client, calls, render, press, setUser: (next) => { user = next; }, flush: () => timers.splice(0).forEach((callback) => callback()) };
}

const recording = {
  id: 'recording1', organizationId: 'org1', userId: 'user1', status: 'completed',
  patientName: 'Synthetic Patient', clientName: 'Synthetic Client', createdAt: '2026-10-28T00:00:00Z', isExported: false,
};
const originalNote = { id: 'soap1', isExported: false, exportedTo: null };
const returnedNote = { id: 'soap1', isExported: true, exportedTo: 'ezyvet', plan: { content: 'Returned server note' } };

test('explicit marking uses returned SOAP and immediately updates detail, recent and infinite recording rows', async () => {
  const h = await harness();
  h.press(copy.markPims);
  h.press('ezyVet');
  await settle();
  assert.equal(h.calls.mark.length, 1);
  assert.equal(h.calls.mark[0][0], 'soap1');
  assert.equal(h.calls.mark[0][1].exportedTo, 'ezyvet');
  assert.deepEqual(h.client.getQueryData(['soapNote', recording.id]), returnedNote);
  assert.equal(h.client.getQueryData(['recording', recording.id]).isExported, true);
  assert.equal(h.client.getQueryData(['recordings', 'recent']).data[0].isExported, true);
  assert.equal(h.client.getQueryData(['recordings', 'list', '', 'all']).pages[0].data[0].isExported, true);
  h.flush();
  assert.equal(h.client.getQueryState(['recordings', 'recent']).isInvalidated, true);
  assert.equal(nodes(h.render(returnedNote)).find((node) => node.type === 'Toast').props.message, copy.marked);
  h.unmount();
});

test('failed marking keeps export state unchanged and displays retryable feedback', async () => {
  const h = await harness({ mark: async () => { throw new Error('network failed'); } });
  h.press(copy.markPims);
  h.press('ezyVet');
  await settle();
  assert.equal(h.client.getQueryData(['recording', recording.id]).isExported, false);
  assert.equal(h.client.getQueryData(['soapNote', recording.id]), originalNote);
  assert(nodes(h.render()).some((node) => node.props?.accessibilityRole === 'alert' && node.props.children.includes(copy.markFailed)));
  h.unmount();
});

test('copy and successful or cancelled share sheets never mark export completion', async () => {
  for (const shareResult of [true, false]) {
    const h = await harness({ shareResult });
    for (const label of [copy.copyAll, copy.shareText, copy.sharePdf]) { h.press(label); await settle(); }
    assert.equal(h.calls.mark.length, 0);
    assert.deepEqual([h.calls.copy, h.calls.text, h.calls.pdf], [1, 1, 1]);
    assert.equal(h.client.getQueryData(['recording', recording.id]).isExported, false);
    h.unmount();
  }
});

test('a late export response cannot repopulate caches after unmount or an account or organization switch', async () => {
  for (const scopeChange of ['unmount', 'account', 'organization']) {
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const h = await harness({ mark: () => response });
    h.press(copy.markPims);
    h.press('ezyVet');
    if (scopeChange === 'unmount') h.unmount();
    else {
      h.setUser({ id: scopeChange === 'account' ? 'user2' : 'user1', organizationId: scopeChange === 'organization' ? 'org2' : 'org1' });
      h.render();
    }
    h.client.clear();
    resolve(returnedNote);
    await settle();
    h.flush();
    assert.equal(h.client.getQueryData(['recording', recording.id]), undefined);
    assert.equal(h.client.getQueryData(['soapNote', recording.id]), undefined);
    assert.equal(h.calls.events.length, 0);
    h.unmount();
  }
});

test('recording row memo updates immediately and only explicit true values render marked status', async () => {
  const h = hooks();
  const { RecordingCard } = await loadTsx('src/components/RecordingCard.tsx', {
    react: h.react, 'react-native': { View: 'View', Pressable: 'Pressable' }, './ui/Text': { Text: 'Text' },
    'expo-router': { useRouter: () => ({ push() {} }) }, 'lucide-react-native': {},
    './StatusBadge': { StatusBadge: 'StatusBadge' }, '../constants/strings': strings,
    '../lib/recordingDisplay': { displayPatientName: (row) => row.patientName, isUntitledVisit: () => false },
    '../hooks/useThemeColors': { useThemeColors: () => ({}) }, './ui/styles': { CLIP_SAFE: {}, clipSafe: (value) => value },
  });
  const before = { recording };
  const after = { recording: { ...recording, isExported: true } };
  assert.equal(RecordingCard.compare(before, before), true);
  assert.equal(RecordingCard.compare(before, after), false);
  for (const isExported of [undefined, null, false, true]) {
    const tree = h.render(RecordingCard, { recording: { ...recording, isExported } });
    const marker = nodes(tree).some((node) => node.type === 'Text' && node.props.children.includes(copy.markedStatus));
    assert.equal(marker, isExported === true);
    assert.equal(tree.props.accessibilityLabel.includes(copy.markedStatus), isExported === true);
  }
});

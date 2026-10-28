import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTsModule } from './helpers/loadTs.mjs';

const history = await loadTsModule('src/lib/recordingHistory.ts');
const { RECORDING_HISTORY_COPY: COPY } = await loadTsModule('src/constants/strings.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const range = { preset: 'custom', from: '2026-10-28', through: '2026-10-30' };

function nodes(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((child) => nodes(child, predicate));
  if (!value || typeof value !== 'object') return [];
  return [...(value.type && predicate(value) ? [value] : []),
    ...Object.values(value.props ?? {}).flatMap((child) => nodes(child, predicate))];
}
const text = (node) => node.props.children.flat(Infinity).filter((value) => typeof value === 'string').join('');

async function datesHarness(platform = 'android', value = range, nativeAvailable = true) {
  const hooks = [];
  const listeners = new Set();
  const opened = [];
  const dismissed = [];
  const applied = [];
  let nativeLoads = 0;
  let closed = 0;
  let locked = false;
  let focused = true;
  let cursor;
  let effects;
  let changed;
  let tree;
  const props = { visible: true, value,
    onClose: () => { closed++; props.visible = false; },
    onApply: (filter) => { applied.push(plain(filter)); props.value = filter; props.visible = false; },
  };
  const react = {
    Fragment: 'Fragment',
    createElement: (type, nodeProps, ...children) => ({ type, props: { ...nodeProps, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => {
        const result = typeof next === 'function' ? next(hooks[index]) : next;
        if (!Object.is(result, hooks[index])) { hooks[index] = result; changed = true; }
      }];
    },
    useRef: (initial) => react.useState(() => ({ current: initial }))[0],
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((item, i) => !Object.is(item, hooks[index].dependencies[i]))) {
        hooks[index] = { value: callback, dependencies };
      }
      return hooks[index].value;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((item, i) => !Object.is(item, previous.dependencies[i]))) {
        hooks[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const AppState = { currentState: 'active', addEventListener: (_, callback) => {
    listeners.add(callback); return { remove: () => listeners.delete(callback) };
  } };
  const native = { default: 'NativeDatePicker', DateTimePickerAndroid: {
    open: (options) => opened.push(options),
    dismiss: async (mode) => { dismissed.push(mode); },
  } };
  const mocks = {
    react, 'react-native': { AppState, Platform: { OS: platform }, UIManager: { hasViewManagerConfig: () => nativeAvailable }, View: 'View' },
    '@react-navigation/native': { useFocusEffect: (callback) => react.useEffect(() => focused ? callback() : undefined, [focused, callback]) },
    '../hooks/useAppLocked': { useAppLocked: () => locked },
    './ui/Text': { Text: 'Text' }, './ui/Button': { Button: 'Button' }, './ui/Sheet': { Sheet: 'Sheet' },
    '../lib/recordingHistory': history, '../constants/strings': { RECORDING_HISTORY_COPY: COPY },
  };
  const module = { exports: {} };
  const source = await readFile(new URL('../src/components/RecordingDatesSheet.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, console,
    require: (name) => {
      if (name === '@react-native-community/datetimepicker') {
        nativeLoads++;
        if (!nativeAvailable) throw new Error('Native module missing from this development client');
        return native;
      }
      assert.ok(name in mocks, `Unexpected dependency ${name}`);
      return mocks[name];
    },
  });
  function render() {
    let renders = 0;
    do {
      changed = false; cursor = 0; effects = [];
      const visibleBefore = props.visible;
      tree = module.exports.RecordingDatesSheet(props);
      for (const effect of effects) effect();
      if (props.visible !== visibleBefore) changed = true;
      assert.ok(++renders < 12, 'picker render should settle');
    } while (changed);
    return tree;
  }
  const buttons = () => nodes(tree, (node) => node.type === 'Button');
  render();
  return {
    props, opened, dismissed, applied, render,
    loads: () => nativeLoads, closed: () => closed,
    press(label) {
      const button = buttons().find((node) => text(node) === label || text(node).startsWith(`${label}: `));
      assert.ok(button, `Missing button ${label}`);
      button.props.onPress(); render();
    },
    field: (label) => buttons().find((node) => text(node).startsWith(`${label}: `))?.props.children.join(''),
    picker: () => nodes(tree, (node) => node.type === 'NativeDatePicker')[0],
    alerts: () => nodes(tree, (node) => node.props.accessibilityRole === 'alert').map(text),
    stop(reason) {
      if (reason === 'close') props.visible = false;
      if (reason === 'background') {
        AppState.currentState = 'background'; for (const listener of listeners) listener('background');
      }
      if (reason === 'lock') locked = true;
      if (reason === 'blur') focused = false;
      render();
    },
  };
}

test('presets load without native code and apply only after explicit Apply', async () => {
  const h = await datesHarness('android', { preset: 'all' });
  assert.equal(h.loads(), 0);
  h.press(COPY.presets.last7);
  assert.equal(h.applied.length, 0);
  h.press(COPY.cancel);
  assert.equal(h.props.value.preset, 'all');
  h.props.visible = true; h.render();
  h.press(COPY.presets.today); h.press(COPY.apply);
  assert.deepEqual(h.applied, [{ preset: 'today' }]);
  assert.equal(h.loads(), 0);
});

test('Android uses the imperative native picker and preserves custom dates on cancellation', async () => {
  const h = await datesHarness();
  h.press(COPY.from);
  assert.equal(h.loads(), 1);
  assert.equal(h.opened[0].mode, 'date');
  assert.equal(h.opened[0].value.getHours(), 12);
  assert.equal(h.picker(), undefined, 'Android does not render the iOS component');
  h.opened[0].onChange({ type: 'dismissed' }, new Date(2026, 9, 29)); h.render();
  assert.equal(h.field(COPY.from), 'From: 2026-10-28');
  h.opened[0].onChange({ type: 'set' }, new Date(2026, 9, 29)); h.render();
  assert.equal(h.field(COPY.from), 'From: 2026-10-29');
  h.press(COPY.cancel);
  assert.deepEqual(plain(h.props.value), range);
  h.props.visible = true; h.render();
  assert.equal(h.field(COPY.from), 'From: 2026-10-28');
});

test('custom Apply validates order and iOS uses its native spinner component', async () => {
  const invalid = await datesHarness('android', { preset: 'custom', from: '2026-10-30', through: '2026-10-28' });
  invalid.press(COPY.apply);
  assert.equal(invalid.applied.length, 0);
  assert.deepEqual(invalid.alerts(), [COPY.invalidRange]);
  const ios = await datesHarness('ios');
  ios.press(COPY.from);
  assert.equal(ios.opened.length, 0);
  assert.equal(ios.picker().props.display, 'spinner');
  ios.picker().props.onChange({ type: 'set' }, new Date(2026, 9, 29)); ios.render();
  ios.press(COPY.apply);
  assert.deepEqual(ios.applied, [{ preset: 'custom', from: '2026-10-29', through: '2026-10-30' }]);
});

test('older development clients show native-module guidance and still apply presets', async () => {
  const h = await datesHarness('android', range, false);
  assert.equal(h.loads(), 0);
  assert.doesNotThrow(() => h.press(COPY.from));
  assert.deepEqual(h.alerts(), [COPY.pickerUnavailable]);
  h.press(COPY.presets.yesterday); h.press(COPY.apply);
  assert.deepEqual(h.applied, [{ preset: 'yesterday' }]);
});

test('late native results cannot mutate dates after close, background, lock, or blur', async () => {
  for (const platform of ['android', 'ios']) {
    for (const reason of ['close', 'background', 'lock', 'blur']) {
      const h = await datesHarness(platform);
      h.press(COPY.from);
      const callback = platform === 'android' ? h.opened[0].onChange : h.picker().props.onChange;
      const before = h.field(COPY.from);
      h.stop(reason);
      callback({ type: 'set' }, new Date(2026, 9, 29)); h.render();
      assert.equal(h.field(COPY.from), before, `${platform} callback after ${reason} must be ignored`);
      assert.ok(h.dismissed.includes('date'));
      assert.equal(h.applied.length, 0);
    }
  }
});

test('replacing filter scope invalidates native callbacks from the previous account', async () => {
  for (const platform of ['android', 'ios']) {
    const h = await datesHarness(platform);
    h.press(COPY.from);
    const callback = platform === 'android' ? h.opened[0].onChange : h.picker().props.onChange;
    h.props.value = { preset: 'all' }; h.render();
    callback({ type: 'set' }, new Date(2026, 9, 29)); h.render();
    assert.equal(h.field(COPY.from), undefined);
    assert.equal(h.applied.length, 0);
  }
});


test('older iOS clients without the native view stay usable before requiring the picker', async () => {
  const h = await datesHarness('ios', range, false);
  h.press(COPY.from);
  assert.equal(h.loads(), 0);
  assert.equal(h.picker(), undefined);
  assert.deepEqual(h.alerts(), [COPY.pickerUnavailable]);
});

test('Android native open failures show retryable guidance and late failures are ignored', async () => {
  const h = await datesHarness();
  h.press(COPY.from);
  h.opened[0].onError(new Error('native open failed')); h.render();
  assert.deepEqual(h.alerts(), [COPY.pickerUnavailable]);
  const late = await datesHarness();
  late.press(COPY.from); late.stop('close');
  late.opened[0].onError(new Error('late failure')); late.render();
  assert.deepEqual(late.alerts(), []);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { loadTsModule } from './helpers/loadTs.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const strings = await loadTsModule('src/constants/strings.ts');
const copy = strings.RECOVERY_PREVIEW_COPY;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function hooks() {
  const values = [];
  let index = 0;
  let effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
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
  };
  return {
    react,
    render(component, props) {
      index = 0;
      effects = [];
      const result = component(props);
      for (const effect of effects) effect();
      return result;
    },
    unmount: () => values.forEach((value) => value?.cleanup?.()),
  };
}

async function playbackHarness({ mode = async () => {}, seek = async () => {} } = {}) {
  const h = hooks();
  const activity = (await loadTsModule('src/lib/recordingActivity.ts')).recordingActivity;
  const calls = { mode: 0, replace: [], play: 0, pause: 0, removed: 0 };
  let listener;
  const player = {
    addListener(_event, callback) { listener = callback; return { remove: () => { calls.removed++; } }; },
    replace: (source) => calls.replace.push(source.uri),
    play: () => { calls.play++; }, pause: () => { calls.pause++; }, seekTo: seek,
    setPlaybackRate() {},
  };
  const { useAudioPlayback } = await loadTsModule('src/hooks/useAudioPlayback.ts', {
    react: h.react,
    'expo-audio': {
      useAudioPlayer: () => player,
      setAudioModeAsync: () => { calls.mode++; return mode(); },
    },
    'react-native-reanimated': {
      useSharedValue: (value) => h.react.useRef({ value }).current,
      useFrameCallback() {},
    },
  });
  let current;
  const render = () => { current = h.render(() => useAudioPlayback(() => !activity.isActive())); return current; };
  const status = (changes = {}) => listener({ isLoaded: true, playing: false, isBuffering: false, currentTime: 0, duration: 2, ...changes });
  render();
  return { ...h, calls, activity, render, status, current: () => current };
}

test('aborted source and unmounted player reject native-mode completions before source replacement', async () => {
  for (const cancel of ['abort', 'unmount']) {
    const native = deferred();
    const h = await playbackHarness({ mode: () => native.promise });
    const controller = new AbortController();
    const loading = h.current().loadSource('file:///cache/preview.aac', controller.signal);
    if (cancel === 'abort') controller.abort();
    else h.unmount();
    native.resolve();
    await loading;
    assert.deepEqual(h.calls.replace, []);
    assert.equal(h.calls.play, 0);
    if (cancel === 'unmount') assert.equal(h.calls.removed, 1);
    else h.unmount();
  }
});

test('active and paused recorder ownership block preparation and late source replacement', async () => {
  for (const capturing of [true, false]) {
    const native = deferred();
    const h = await playbackHarness({ mode: () => native.promise });
    h.activity.setCapturing(capturing);
    h.activity.setActive(true);
    await h.current().loadSource('file:///cache/preview.aac');
    assert.equal(h.calls.mode, 0);
    h.activity.setActive(false);
    const loading = h.current().loadSource('file:///cache/preview.aac');
    h.activity.setActive(true);
    native.resolve();
    await loading;
    assert.deepEqual(h.calls.replace, []);
    h.unmount();
  }
});

test('an aborted prior attempt cannot replace the newer preview after retry', async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const h = await playbackHarness({ mode: () => (++count === 1 ? first.promise : second.promise) });
  const controller = new AbortController();
  const previous = h.current().loadSource('file:///cache/old.aac', controller.signal);
  controller.abort();
  const current = h.current().loadSource('file:///cache/new.aac', new AbortController().signal);
  second.resolve();
  await current;
  first.resolve();
  await previous;
  assert.deepEqual(h.calls.replace, ['file:///cache/new.aac']);
  h.unmount();
});

test('native-mode and rewind continuations cannot start playback after cancellation or recorder ownership', async () => {
  for (const stage of ['mode', 'rewind']) {
    for (const cancellation of ['unmount', 'ownership']) {
      const native = deferred();
      const h = await playbackHarness(stage === 'mode' ? { mode: () => native.promise } : { seek: () => native.promise });
      h.status({ currentTime: stage === 'rewind' ? 2 : 0 });
      h.render().play();
      await settle();
      if (cancellation === 'unmount') h.unmount();
      else h.activity.setActive(true);
      native.resolve();
      await settle();
      assert.equal(h.calls.play, 0);
      if (cancellation !== 'unmount') h.unmount();
    }
  }
});

test('permitted playback still loads, plays and pauses normally', async () => {
  const h = await playbackHarness();
  await h.current().loadSource('file:///cache/preview.aac');
  h.status();
  h.render().play();
  await settle();
  assert.deepEqual(h.calls.replace, ['file:///cache/preview.aac']);
  assert.equal(h.calls.play, 1);
  h.current().pause();
  assert.equal(h.calls.pause, 1);
  h.unmount();
});

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
}

async function previewHarness({ prepare, load } = {}) {
  const h = hooks();
  const timers = new Map();
  const intervals = new Map();
  let timerId = 0;
  const setTimeout = (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; };
  const clearTimeout = (id) => timers.delete(id);
  const timeout = await loadTsModule('src/lib/promiseTimeout.ts', {}, { setTimeout, clearTimeout });
  const calls = { prepare: [], load: [], pause: 0, toggle: 0, cleanup: [], stopped: 0 };
  let locked = false;
  let recorderActive = false;
  const appState = { currentState: 'active' };
  const playback = {
    isLoaded: false, isPlaying: false, currentTimeRef: { current: 0 },
    loadSource: (...args) => { calls.load.push(args); return load ? load(...args) : Promise.resolve(); },
    pause: () => { calls.pause++; }, toggle: () => { calls.toggle++; },
  };
  const mocks = {
    react: h.react, 'react-native': { AppState: appState, View: 'View' },
    './ui/Text': { Text: 'Text' }, './ui/Button': { Button: 'Button' },
    '../hooks/useAudioPlayback': { useAudioPlayback: () => playback },
    '../hooks/useAppLocked': { useAppLocked: () => locked },
    '../lib/recordingActivity': { recordingActivity: { isActive: () => recorderActive } },
    '../lib/audioTempFiles': { audioTempFiles: { cleanupFile: (uri) => calls.cleanup.push(uri) } },
    '../lib/promiseTimeout': timeout,
    '../lib/durableAudio/recoveryPreview': {
      RECOVERY_PREVIEW_MAX_SECONDS: 60,
      prepareRecoveryPreview: (...args) => {
        calls.prepare.push(args);
        return prepare ? prepare(...args) : Promise.resolve({ uri: `file:///cache/preview${calls.prepare.length}.aac`, durationSeconds: 0.128 });
      },
    },
    '../constants/strings': strings,
  };
  const module = { exports: {} };
  const source = await readFile(new URL('../src/components/RecoveryAudioPreview.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, AbortController, setTimeout, clearTimeout,
    setInterval: (callback) => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: (id) => intervals.delete(id),
    require: (name) => { assert(name in mocks, `Unexpected dependency ${name}`); return mocks[name]; },
  });
  const offer = { recordingId: 'rec1' };
  const onStop = () => { calls.stopped++; h.unmount(); };
  const render = () => h.render(module.exports.RecoveryAudioPreview, { offer, userId: 'user1', onStop });
  const press = (label) => {
    const button = nodes(render()).find((node) => node.type === 'Button' && node.props.children.includes(label));
    assert(button, `Missing button ${label}`);
    button.props.onPress();
  };
  render();
  return {
    ...h, calls, playback, render, press, appState,
    setLocked: (value) => { locked = value; }, setRecorderActive: (value) => { recorderActive = value; },
    fireTimeouts: () => {
      for (const [id, timer] of [...timers]) { if (timers.delete(id)) timer.callback(); }
    },
    tick: () => [...intervals.values()].forEach((callback) => callback()),
  };
}

test('preview readiness timeout offers retry, aborts stale load and cleans source on retry', async () => {
  const h = await previewHarness();
  await settle();
  h.render();
  h.fireTimeouts();
  await settle();
  assert(nodes(h.render()).some((node) => node.props?.children?.includes(copy.failed)));
  assert.equal(h.calls.load[0][1].aborted, true);
  h.press(copy.retry);
  h.render();
  await settle();
  assert.equal(h.calls.prepare.length, 2);
  assert(h.calls.cleanup.includes('file:///cache/preview1.aac'));
  h.unmount();
});

test('Stop aborts preparation and deletes a late result without loading or playing it', async () => {
  const pending = deferred();
  const h = await previewHarness({ prepare: () => pending.promise });
  h.press(copy.stop);
  assert.equal(h.calls.prepare[0][2].aborted, true);
  pending.resolve({ uri: 'file:///cache/late.aac', durationSeconds: 1 });
  await settle();
  assert.deepEqual(h.calls.load, []);
  assert(h.calls.cleanup.includes('file:///cache/late.aac'));
  assert.equal(h.calls.toggle, 0);
});

test('failed native load offers retry and deletes derived audio', async () => {
  const h = await previewHarness({ load: async () => { throw new Error('native failure'); } });
  await settle();
  assert(nodes(h.render()).some((node) => node.props?.children?.includes(copy.failed)));
  assert(h.calls.cleanup.includes('file:///cache/preview1.aac'));
  assert.equal(h.calls.load[0][1].aborted, true);
  h.unmount();
});

test('preview never autoplays; explicit play is blocked during active or paused ownership', async () => {
  const h = await previewHarness();
  await settle();
  h.playback.isLoaded = true;
  h.render();
  assert.equal(h.calls.toggle, 0);
  h.press(copy.play);
  assert.equal(h.calls.toggle, 1);
  h.setRecorderActive(true);
  h.press(copy.play);
  assert.equal(h.calls.toggle, 1);
  h.unmount();
});

test('available duration, backgrounding and app lock stop or disable preview playback', async () => {
  for (const reason of ['duration', 'background', 'locked']) {
    const h = await previewHarness();
    await settle();
    h.playback.isLoaded = true;
    h.render();
    if (reason === 'duration') h.playback.currentTimeRef.current = 0.128;
    else if (reason === 'background') h.appState.currentState = 'background';
    else { h.setLocked(true); h.render(); }
    h.tick();
    assert.equal(h.calls.stopped, 1);
    assert(h.calls.cleanup.includes('file:///cache/preview1.aac'));
    assert.equal(h.calls.load[0][1].aborted, true);
  }
});

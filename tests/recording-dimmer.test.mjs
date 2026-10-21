// recordingDimmer keeps a recording tablet awake but not at full backlight:
// after a minute untouched the (Android) window dims, and any touch, keyboard
// use, return to the app, or the recording stopping restores it. The failure
// modes worth fencing are a screen that STAYS dim after the recording ends, a
// dim that BRIGHTENS a screen the vet had turned down, and dimming while the
// vet is typing (keyboard touches never reach the app's views).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const flush = () => new Promise((r) => setImmediate(r));

async function setup({ brightness = 0.8, bridge = true } = {}) {
  const { createRecordingDimmer, RECORDING_DIM_IDLE_MS, RECORDING_DIM_LEVEL } = await loadTsModule(
    'src/lib/recordingDimmer.ts',
    {
      'react-native': {
        Platform: { OS: 'android' },
        AppState: { addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: () => ({ remove() {} }) },
      },
    },
  );
  const state = { brightness, systemRestores: 0, sets: [] };
  const timers = [];
  let onForeground = null;
  let onKeyboard = null;
  let pendingGet = null;
  const native = {
    getBrightnessAsync: () =>
      pendingGet ? pendingGet.promise : Promise.resolve(state.brightness),
    setBrightnessAsync: async (v) => {
      state.sets.push(v);
      state.brightness = v;
    },
    restoreSystemBrightnessAsync: async () => {
      state.systemRestores += 1;
      state.brightness = brightness;
    },
  };
  const dimmer = createRecordingDimmer({
    loadBridge: () => (bridge ? native : null),
    subscribeForeground: (fn) => {
      onForeground = fn;
      return () => {
        onForeground = null;
      };
    },
    subscribeKeyboard: (fn) => {
      onKeyboard = fn;
      return () => {
        onKeyboard = null;
      };
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
  });
  const idle = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    await flush();
  };
  const holdGet = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    pendingGet = { promise };
    return () => {
      pendingGet = null;
      resolve(state.brightness);
    };
  };
  return {
    dimmer,
    state,
    timers,
    idle,
    holdGet,
    RECORDING_DIM_IDLE_MS,
    RECORDING_DIM_LEVEL,
    foreground: () => onForeground?.(),
    keyboard: (open) => onKeyboard?.(open),
  };
}

test('dims after the idle window while recording', async () => {
  const t = await setup();
  t.dimmer.start();
  assert.equal(t.timers[0].ms, t.RECORDING_DIM_IDLE_MS);
  await t.idle();
  assert.deepEqual(t.state.sets, [t.RECORDING_DIM_LEVEL]);
});

test('a touch restores brightness and re-arms the timer', async () => {
  const t = await setup();
  t.dimmer.start();
  await t.idle();
  t.dimmer.noteActivity();
  await flush();
  assert.equal(t.state.systemRestores, 1);
  assert.equal(t.state.brightness, 0.8);
  await t.idle();
  assert.equal(t.state.sets.length, 2, 'dims again after another idle window');
});

test('stopping the recording always restores — the screen never stays dim', async () => {
  const t = await setup();
  t.dimmer.start();
  await t.idle();
  t.dimmer.stop();
  await flush();
  assert.equal(t.state.brightness, 0.8);
  t.dimmer.noteActivity();
  await t.idle();
  assert.equal(t.state.sets.length, 1, 'no dimming once stopped');
});

test('a stop that lands while the dim is in flight undoes it', async () => {
  const t = await setup();
  t.dimmer.start();
  const release = t.holdGet();
  const pending = t.idle();
  t.dimmer.stop();
  release();
  await pending;
  await flush();
  assert.equal(t.state.brightness, 0.8);
});

test('never brightens a screen already at or below the dim level', async () => {
  const t = await setup({ brightness: 0.1 });
  t.dimmer.start();
  await t.idle();
  assert.deepEqual(t.state.sets, []);
});

test('never dims while the keyboard is open', async () => {
  const t = await setup();
  t.dimmer.start();
  t.keyboard(true);
  await t.idle();
  assert.deepEqual(t.state.sets, []);
  t.keyboard(false);
  await t.idle();
  assert.deepEqual(t.state.sets, [t.RECORDING_DIM_LEVEL]);
});

test('returning to the app counts as activity', async () => {
  const t = await setup();
  t.dimmer.start();
  await t.idle();
  t.foreground();
  await flush();
  assert.equal(t.state.brightness, 0.8);
});

test('without a bridge (iOS / old dev-client) it does nothing', async () => {
  const t = await setup({ bridge: false });
  t.dimmer.start();
  assert.equal(t.timers.length, 0);
  t.dimmer.noteActivity();
  t.dimmer.stop();
});

test('wiring: record.tsx starts/stops the dimmer with keep-awake; touches are tracked app-wide', async () => {
  const record = await readFile(new URL('../app/(app)/(tabs)/record.tsx', import.meta.url), 'utf8');
  assert.match(record, /activateKeepAwakeAsync\(RECORDING_KEEP_AWAKE_TAG\)\.catch\(\(\) => \{\}\);\s*recordingDimmer\.start\(\);/);
  assert.ok((record.match(/recordingDimmer\.stop\(\)/g) ?? []).length >= 3, 'stop on not-recording, effect cleanup and unmount');
  const layout = await readFile(new URL('../app/(app)/_layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /onTouchStart=\{noteRecordingUserActivity\}/);
  const sheet = await readFile(new URL('../src/components/ui/Sheet.tsx', import.meta.url), 'utf8');
  assert.match(sheet, /onTouchStart=\{noteRecordingUserActivity\}/);
  const src = await readFile(new URL('../src/lib/recordingDimmer.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(Platform\.OS !== 'android'\) return null;/, 'iOS never dims');
});

test('expo-brightness never brings WRITE_SETTINGS into the Android manifest', async () => {
  const cfg = await readFile(new URL('../app.config.ts', import.meta.url), 'utf8');
  const blocked = cfg.slice(cfg.indexOf('blockedPermissions'));
  assert.match(blocked, /'android\.permission\.WRITE_SETTINGS'/);
  assert.doesNotMatch(cfg, /['"]expo-brightness['"]\s*[,\]]/, 'its config plugin (adds WRITE_SETTINGS) stays unregistered');
});

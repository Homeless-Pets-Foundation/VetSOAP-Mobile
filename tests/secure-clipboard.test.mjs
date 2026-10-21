// secureClipboard must never clear on the way OUT of the app: leaving is how
// a copied SOAP note / client email / MFA setup key reaches the PIMS, Mail or
// an authenticator. The shipped bug wiped the clipboard on every non-'active'
// AppState, so "Copy All -> switch app -> paste" pasted nothing. A stale copy
// is still cleared — while foregrounded, or on the first return after expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTs.mjs';

async function setup() {
  const clipboard = { value: '', reads: 0, writes: [] };
  const appState = { currentState: 'active', listeners: [] };
  const timers = [];

  const mod = await loadTsModule(
    'src/lib/secureClipboard.ts',
    {
      'expo-clipboard': {
        setStringAsync: async (v) => {
          clipboard.value = v;
          clipboard.writes.push(v);
          return true;
        },
        getStringAsync: async () => {
          clipboard.reads += 1;
          return clipboard.value;
        },
      },
      'react-native': {
        AppState: {
          get currentState() {
            return appState.currentState;
          },
          addEventListener: (_event, fn) => {
            appState.listeners.push(fn);
            return { remove() {} };
          },
        },
      },
    },
    {
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (t) => {
        if (t) t.cleared = true;
      },
    }
  );

  const setAppState = async (next) => {
    appState.currentState = next;
    for (const fn of appState.listeners) fn(next);
    await new Promise((r) => setImmediate(r));
  };
  const fireTimers = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    await new Promise((r) => setImmediate(r));
  };

  return { mod, clipboard, setAppState, fireTimers, timers };
}

test('leaving the app does not clear the copied text', async () => {
  const { mod, clipboard, setAppState } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  await setAppState('inactive'); // iOS app switcher / Control Center
  await setAppState('background'); // switched to the PIMS
  assert.equal(clipboard.value, 'SOAP note');
});

test('the clear delay is long enough to switch apps and paste', async () => {
  const { mod, timers } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  assert.ok(mod.CLIPBOARD_CLEAR_DELAY_MS >= 60_000);
  assert.equal(timers[0].ms, mod.CLIPBOARD_CLEAR_DELAY_MS);
});

test('a stale copy is cleared when the timer expires in the foreground', async () => {
  const { mod, clipboard, fireTimers } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  await fireTimers();
  assert.equal(clipboard.value, '');
});

test('expiry while away defers the clear to the next return, without reading in the background', async () => {
  const { mod, clipboard, setAppState, fireTimers } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  await setAppState('background');
  await fireTimers();
  assert.equal(clipboard.value, 'SOAP note', 'still pasteable while away');
  assert.equal(clipboard.reads, 0, 'no clipboard read from the background');
  await setAppState('active');
  assert.equal(clipboard.value, '');
});

test('text the user copied elsewhere afterwards is never wiped', async () => {
  const { mod, clipboard, setAppState, fireTimers } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  await setAppState('background');
  clipboard.value = 'something from the PIMS';
  await fireTimers();
  await setAppState('active');
  assert.equal(clipboard.value, 'something from the PIMS');
});

test('clearClipboard (sign-out) clears immediately and cancels any deferred clear', async () => {
  const { mod, clipboard, setAppState, fireTimers } = await setup();
  await mod.copyWithAutoClear('SOAP note');
  mod.clearClipboard();
  assert.equal(clipboard.value, '');
  clipboard.value = 'next user copy';
  await fireTimers();
  await setAppState('active');
  assert.equal(clipboard.value, 'next user copy');
});

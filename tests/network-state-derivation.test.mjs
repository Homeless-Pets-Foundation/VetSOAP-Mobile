import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const { networkStateFromNetInfo } = await loadTsModule('src/lib/networkState.ts');

/** The server's telemetry schema rejects anything outside this enum with a 400. */
const SERVER_NETWORK_STATES = ['wifi', 'cellular', 'none', 'unknown'];

test('networkStateFromNetInfo maps the two named transports', () => {
  assert.equal(networkStateFromNetInfo({ isConnected: true, type: 'wifi' }), 'wifi');
  assert.equal(networkStateFromNetInfo({ isConnected: true, type: 'cellular' }), 'cellular');
});

test('an explicitly disconnected radio is none', () => {
  assert.equal(networkStateFromNetInfo({ isConnected: false, type: 'none' }), 'none');
  // Disconnected wins over a stale transport label.
  assert.equal(networkStateFromNetInfo({ isConnected: false, type: 'wifi' }), 'none');
});

test('unresolved NetInfo is unknown, not none', () => {
  // useNetInfo() returns { isConnected: null, type: 'unknown' } on first render.
  // Reporting that as 'none' would invent an offline device; it is genuinely
  // unknown, and this is the single largest source of network_state: 'unknown'
  // in production telemetry.
  assert.equal(networkStateFromNetInfo({ isConnected: null, type: 'unknown' }), 'unknown');
});

test('connected over an unrecognized transport is unknown', () => {
  for (const type of ['ethernet', 'vpn', 'other', 'wimax', 'bluetooth']) {
    assert.equal(networkStateFromNetInfo({ isConnected: true, type }), 'unknown');
  }
});

test('null or undefined input returns unknown without throwing', () => {
  // This runs inside a catch block that must never throw.
  assert.equal(networkStateFromNetInfo(null), 'unknown');
  assert.equal(networkStateFromNetInfo(undefined), 'unknown');
  assert.equal(networkStateFromNetInfo({}), 'unknown');
});

test('every return value is a member of the server NetworkState enum', () => {
  const inputs = [
    null,
    undefined,
    {},
    { isConnected: true, type: 'wifi' },
    { isConnected: true, type: 'cellular' },
    { isConnected: false, type: 'none' },
    { isConnected: null, type: 'unknown' },
    { isConnected: true, type: 'ethernet' },
    { isConnected: true },
    { type: 'wifi' },
  ];

  for (const input of inputs) {
    const value = networkStateFromNetInfo(input);
    assert.ok(
      SERVER_NETWORK_STATES.includes(value),
      `${JSON.stringify(input)} produced ${value}, which the server would 400`
    );
  }
});

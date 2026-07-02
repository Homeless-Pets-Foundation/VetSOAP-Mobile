import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const MOD = 'src/lib/minVersion.ts';

test('compareVersions handles uneven lengths', async () => {
  const { compareVersions } = await loadTsModule(MOD);
  assert.equal(compareVersions('1.2.0', '1.2'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4') < 0, true);
  assert.equal(compareVersions('2.0', '1.9.9') > 0, true);
  assert.equal(compareVersions('1.13.0', '1.13.0'), 0);
});

test('isVersionBelow', async () => {
  const { isVersionBelow } = await loadTsModule(MOD);
  assert.equal(isVersionBelow('1.12.4', '1.13.0'), true);
  assert.equal(isVersionBelow('1.13.0', '1.13.0'), false);
  assert.equal(isVersionBelow('1.14.0', '1.13.0'), false);
});

test('record-start gate: unknown floor fails OPEN (allow)', async () => {
  const { getRecordStartGate, __resetMinVersionFloor } = await loadTsModule(MOD, {
    'expo-application': { nativeApplicationVersion: '1.0.0' },
  });
  __resetMinVersionFloor();
  assert.equal(getRecordStartGate(), 'allow');
});

test('record-start gate: known-below-floor blocks (even offline)', async () => {
  const { getRecordStartGate, setMinVersionFloor } = await loadTsModule(MOD, {
    'expo-application': { nativeApplicationVersion: '1.12.0' },
  });
  setMinVersionFloor('1.13.0');
  assert.equal(getRecordStartGate(), 'block');
});

test('record-start gate: at/above floor allows', async () => {
  const { getRecordStartGate, setMinVersionFloor } = await loadTsModule(MOD, {
    'expo-application': { nativeApplicationVersion: '1.13.0' },
  });
  setMinVersionFloor('1.13.0');
  assert.equal(getRecordStartGate(), 'allow');
});

test('setMinVersionFloor ignores malformed values', async () => {
  const { setMinVersionFloor, getMinVersionFloor, __resetMinVersionFloor } = await loadTsModule(MOD);
  __resetMinVersionFloor();
  setMinVersionFloor('not-a-version');
  assert.equal(getMinVersionFloor(), null);
  setMinVersionFloor('1.13.2');
  assert.equal(getMinVersionFloor(), '1.13.2');
});

test('gate fails open when current version undeterminable', async () => {
  const { getRecordStartGate, setMinVersionFloor } = await loadTsModule(MOD, {
    'expo-application': { nativeApplicationVersion: null },
    'expo-constants': { default: {} },
  });
  setMinVersionFloor('1.13.0');
  assert.equal(getRecordStartGate(), 'allow');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const MOD = 'src/lib/freeSpace.ts';

test('classifyFreeSpace thresholds: 500 warn / 250 block', async () => {
  const { classifyFreeSpace, FREE_SPACE_WARN_BYTES, FREE_SPACE_BLOCK_BYTES } = await loadTsModule(MOD, {
    'expo-file-system': { Paths: { availableDiskSpace: 0 } },
  });
  const MiB = 1024 * 1024;
  assert.equal(FREE_SPACE_WARN_BYTES, 500 * MiB);
  assert.equal(FREE_SPACE_BLOCK_BYTES, 250 * MiB);
  assert.equal(classifyFreeSpace(1000 * MiB), 'ok');
  assert.equal(classifyFreeSpace(400 * MiB), 'warn');
  assert.equal(classifyFreeSpace(200 * MiB), 'block');
  assert.equal(classifyFreeSpace(250 * MiB), 'warn'); // exactly at block floor -> not below
  assert.equal(classifyFreeSpace(500 * MiB), 'ok'); // exactly at warn floor -> not below
});

test('unknown free space fails OPEN (ok)', async () => {
  const { classifyFreeSpace } = await loadTsModule(MOD, {
    'expo-file-system': { Paths: { availableDiskSpace: 0 } },
  });
  assert.equal(classifyFreeSpace(NaN), 'ok');
  assert.equal(classifyFreeSpace(-1), 'ok');
});

test('checkPreRecordFreeSpace reads Paths.availableDiskSpace', async () => {
  const MiB = 1024 * 1024;
  const low = await loadTsModule(MOD, { 'expo-file-system': { Paths: { availableDiskSpace: 100 * MiB } } });
  assert.equal(low.checkPreRecordFreeSpace(), 'block');
  const ok = await loadTsModule(MOD, { 'expo-file-system': { Paths: { availableDiskSpace: 900 * MiB } } });
  assert.equal(ok.checkPreRecordFreeSpace(), 'ok');
});

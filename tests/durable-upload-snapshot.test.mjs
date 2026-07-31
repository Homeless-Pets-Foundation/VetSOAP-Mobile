import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

test('durable upload snapshots are unique and current-launch classified', async () => {
  const snapshot = await loadTsModule(
    'src/lib/durableUploadSnapshot.ts',
  );
  const first = snapshot.createDurableUploadSnapshotBasename();
  const second = snapshot.createDurableUploadSnapshotBasename();
  assert.notEqual(first, second);
  assert.match(
    first,
    /^durable-upload-v2-[a-z0-9]+-[1-9][0-9]*\.aac$/,
  );
  assert.equal(snapshot.isDurableUploadSnapshotBasename(first), true);
  assert.equal(
    snapshot.isCurrentLaunchDurableUploadSnapshotBasename(first),
    true,
  );
  assert.equal(snapshot.isStaleDurableUploadSnapshotBasename(first), false);
});

test('prior-launch v2 and exact legacy snapshots are stale, near matches are not', async () => {
  const firstMath = Object.create(Math);
  firstMath.random = () => 0.111;
  const firstProcess = await loadTsModule(
    'src/lib/durableUploadSnapshot.ts',
    {},
    { Math: firstMath },
  );
  const prior = firstProcess.createDurableUploadSnapshotBasename();
  const nextMath = Object.create(Math);
  nextMath.random = () => 0.999;
  const nextProcess = await loadTsModule(
    'src/lib/durableUploadSnapshot.ts',
    {},
    { Math: nextMath },
  );
  assert.equal(nextProcess.isStaleDurableUploadSnapshotBasename(prior), true);
  assert.equal(
    nextProcess.isStaleDurableUploadSnapshotBasename(
      'durable-upload-11111111-1111-4111-8111-111111111111.aac',
    ),
    true,
  );
  assert.equal(
    nextProcess.isStaleDurableUploadSnapshotBasename(
      `durable-upload-dr-${'a'.repeat(32)}.aac`,
    ),
    true,
  );
  for (const preserved of [
    'durable-upload-11111111-1111-4111-8111-111111111111.aac.bak',
    'durable-upload-not-a-uuid.aac',
    'durable-upload-v2-token-0.aac',
    'durable-upload-v2-token-1.m4a',
    'audio.aac',
    'patient-recording.aac',
  ]) {
    assert.equal(
      nextProcess.isStaleDurableUploadSnapshotBasename(preserved),
      false,
      preserved,
    );
  }
});

test('cache cleanup deletes only legacy m4a and strict stale durable snapshots', async () => {
  const cleanup = await loadTsModule('src/lib/audioCacheCleanup.ts');
  const deleted = [];
  cleanup.cleanupAudioCacheEntries(
    [
      { name: 'legacy.m4a', uri: 'cache://legacy.m4a', isFile: true },
      {
        name: 'durable-upload-11111111-1111-4111-8111-111111111111.aac',
        uri: 'cache://legacy.aac',
        isFile: true,
      },
      { name: 'audio.aac', uri: 'documents://audio.aac', isFile: true },
      { name: 'drafts', uri: 'documents://drafts', isFile: false },
      { name: 'stashed-audio', uri: 'documents://stashes', isFile: false },
      { name: 'RECOVERY_INTENT', uri: 'secure://intent', isFile: true },
      { name: 'support-vault', uri: 'documents://vault', isFile: false },
      {
        name: 'durable-upload-11111111-1111-4111-8111-111111111111.aac',
        uri: 'cache://snapshot-directory',
        isFile: false,
      },
    ],
    (uri) => deleted.push(uri),
  );
  assert.deepEqual(deleted, [
    'cache://legacy.m4a',
    'cache://legacy.aac',
  ]);
});

test('one cache deletion failure is swallowed without widening or stopping cleanup', async () => {
  const cleanup = await loadTsModule('src/lib/audioCacheCleanup.ts');
  const calls = [];
  assert.doesNotThrow(() =>
    cleanup.cleanupAudioCacheEntries(
      [
        { name: 'first.m4a', uri: 'cache://first', isFile: true },
        { name: 'audio.aac', uri: 'cache://preserve', isFile: true },
        { name: 'second.m4a', uri: 'cache://second', isFile: true },
      ],
      (uri) => {
        calls.push(uri);
        if (uri === 'cache://first') throw new Error('delete failed');
      },
    ),
  );
  assert.deepEqual(calls, ['cache://first', 'cache://second']);
});

test('deferred cache cleanup runs even while an unrelated auth promise never settles', async () => {
  const cleanup = await loadTsModule('src/lib/audioCacheCleanup.ts');
  let calls = 0;
  const authGetSession = new Promise(() => {});
  void authGetSession;
  const timer = cleanup.scheduleAudioCacheCleanup(() => {
    calls += 1;
  }, 5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 1);
  } finally {
    clearTimeout(timer);
  }
});

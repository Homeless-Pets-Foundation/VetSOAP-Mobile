import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('record upload orchestration wires every bounded preflight boundary', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  for (const required of [
    'probePendingDurableAvailability',
    'probePendingStandardAvailability',
    'readDurableUploadMetadata',
    'readUploadMetadataBatch',
    "'segment_metadata'",
    "'silence_metadata'",
    "'split_output_metadata'",
    'presentNativePreflightTimeout',
  ]) {
    assert.match(record, new RegExp(required));
  }
  assert.doesNotMatch(
    record,
    /durable-upload-\$\{durable\.recordingId\}\.aac/,
  );
  assert.match(record, /createDurableUploadSnapshotUri\(Paths\.cache\.uri\)/);
  const durableRead = record.indexOf(
    'const durableMetadata = await readDurableUploadMetadata({',
  );
  const snapshot = record.indexOf(
    'const tempUri = createDurableUploadSnapshotUri(Paths.cache.uri);',
    durableRead,
  );
  const api = record.indexOf(
    'durableResult = await recordingsApi.createWithFile(',
    snapshot,
  );
  assert.ok(durableRead >= 0 && snapshot > durableRead && api > snapshot);
  assert.match(
    record.slice(api, api + 5_000),
    /idempotencyKey: uploadKeyForSlot\(slot\)/,
  );
});

test('upload attempt finally releases ownership, keep-awake, snapshot, and split scratch', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(
    record,
    /finally\s*\{\s*uploadingSlotIdsRef\.current\.delete\(slot\.id\);\s*keepAwakeLease\.release\(\);\s*if \(durableSnapshotUri\) safeDeleteFile\(durableSnapshotUri\);\s*for \(const tempUri of splitTempUris\) safeDeleteFile\(tempUri\);\s*if \(splitTempDir\) safeDeleteDirectory\(splitTempDir\);/,
  );
  assert.match(
    record,
    /durableSnapshotUri = tempUri;\s*durableUploadUri = tempUri;/,
  );
});

test('native timeout branch returns before generic submit-failure telemetry', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const dedicated = record.indexOf(
    'const nativePreflightTimeout = presentNativePreflightTimeout(',
  );
  const genericAnalytics = record.indexOf(
    "name: 'submit_failed'",
    dedicated,
  );
  const dedicatedReturn = record.indexOf('return null;', dedicated);
  assert.ok(dedicated >= 0);
  assert.ok(dedicatedReturn > dedicated);
  assert.ok(genericAnalytics > dedicatedReturn);
  assert.match(
    record,
    /function isRecoverableSubmitFailure\(error: unknown\): boolean \{\s*if \(isNativePreflightTimeout\(error\)\) return true;/,
  );
  const dedicatedBlock = record.slice(dedicated, dedicatedReturn + 12);
  assert.doesNotMatch(
    dedicatedBlock,
    /reportClientError|captureException|breadcrumb|autoStashableFailuresRef/,
  );
  assert.doesNotMatch(
    dedicatedBlock,
    /deleteDraft|setPendingConfirm|markUploaded|purgeAfterUpload|slot\.segments/,
  );
});

test('API, split, and FFmpeg metadata reads use shared native batches', async () => {
  const [api, split, ffmpeg] = await Promise.all([
    read('src/api/recordings.ts'),
    read('src/lib/oversizedSplit.ts'),
    read('src/lib/ffmpeg.ts'),
  ]);
  assert.match(
    api,
    /createNativePreflightBatch\(mode, files\.length\)/,
  );
  assert.match(api, /batch\.read\('api_metadata'/);
  assert.match(
    api,
    /if \(isNativePreflightTimeout\(preflightError\)\) throw preflightError;/,
  );
  assert.match(split, /'split_input_metadata'/);
  assert.match(ffmpeg, /'silence_metadata'/);
  assert.match(ffmpeg, /'split_input_metadata'/);
  assert.match(ffmpeg, /'split_output_metadata'/);
  assert.match(
    ffmpeg,
    /if \(isNativePreflightTimeout\(error\)\) throw error;/,
  );
});

test('auth schedules cache cleanup independently and clears its timer', async () => {
  const auth = await read('src/auth/AuthProvider.tsx');
  const effect = auth.indexOf(
    'const cacheCleanupTimer =',
  );
  const authRequest = auth.indexOf(
    "measurePhase(\n      'auth_init_get_session'",
    effect,
  );
  assert.ok(effect >= 0);
  assert.ok(authRequest > effect);
  assert.match(auth, /clearTimeout\(cacheCleanupTimer\);/);
  assert.match(auth, /cleanupAudioCacheEntries\(/);
  assert.match(
    auth,
    /scheduleAudioCacheCleanup\(cleanupAudioCache\)/,
  );
  assert.match(
    auth,
    /Promise\.resolve\(cleanupAudioCache\(\)\)/,
    'sign-out must use the same strict cleanup path',
  );
});

test('development failpoint has a runtime-only diagnostic action', async () => {
  const settings = await read('app/(app)/settings.tsx');
  const helper = await read('src/lib/nativePreflight.ts');
  assert.match(
    settings,
    /\{__DEV__ \? \(\s*<>\s*<SectionHeading>DEVELOPMENT DIAGNOSTICS/,
  );
  assert.match(settings, /armNativePreflightHang\(operation\)/);
  assert.match(settings, /clearNativePreflightHang\(\)/);
  assert.match(helper, /if \(!__DEV__ \|\| !isNativePreflightOperation\(operation\)\) return false;/);
});

test('Submit All continues after a slot-level timeout returns null', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(
    record,
    /for \(const slot of slotsToUpload\) \{\s*setSubmittingSlotId\(slot\.id\);\s*const recordingId = await uploadSlot\(slot\);\s*if \(!recordingId\) \{[\s\S]*?failedSlotIds\.push\(slot\.id\);[\s\S]*?\} else \{[\s\S]*?submittedRecordingIds\.push\(recordingId\);[\s\S]*?\}\s*\}/,
  );
  assert.doesNotMatch(
    record,
    /if \(!recordingId\) \{[\s\S]{0,250}\bbreak;/,
  );
});

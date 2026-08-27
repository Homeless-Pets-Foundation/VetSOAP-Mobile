import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const load = () => loadTsModule('src/lib/uploadPreflight.ts');

test('pending durable manifest timeout fails closed before source selection', async () => {
  const { probePendingDurableAvailability } = await load();
  let sourceSelected = false;
  await assert.rejects(
    probePendingDurableAvailability({
      getManifest: () => new Promise(() => {}),
      sourceUriFromManifest: () => {
        sourceSelected = true;
        return 'file:///durable.aac';
      },
      getMetadata: async () => ({ exists: true, size: 100 }),
      options: { timeoutMs: 5 },
    }),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.operation === 'durable_manifest' &&
      error.mode === 'durable',
  );
  assert.equal(sourceSelected, false);
});

test('pending durable ordinary missing audio retains confirmation-only semantics', async () => {
  const { probePendingDurableAvailability } = await load();
  const result = await probePendingDurableAvailability({
    getManifest: async () => ({ audioFile: { uri: 'file:///gone.aac' } }),
    sourceUriFromManifest: (manifest) => manifest.audioFile.uri,
    getMetadata: async () => ({ exists: false, size: 0 }),
    options: { timeoutMs: 50, now: () => 0 },
  });
  assert.equal(result.hasCompleteLocalAudio, false);
  assert.equal(result.sourceUri, 'file:///gone.aac');
});

test('pending standard batch timeout does not mutate its segment inputs', async () => {
  const { probePendingStandardAvailability } = await load();
  const uris = ['file:///one.m4a', 'file:///two.m4a'];
  const before = [...uris];
  let calls = 0;
  await assert.rejects(
    probePendingStandardAvailability(
      uris,
      async () => {
        calls += 1;
        if (calls === 1) return { exists: true, size: 100 };
        return new Promise(() => {});
      },
      { timeoutMs: 5 },
    ),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.mode === 'standard' &&
      error.fileCount === 2,
  );
  assert.deepEqual(uris, before);
});

test('main durable native rejection is preserved and phase tagged', async () => {
  const { readDurableUploadMetadata } = await load();
  const expected = new Error('native manifest failure');
  await assert.rejects(
    readDurableUploadMetadata({
      getManifest: async () => {
        throw expected;
      },
      sourceUriFromManifest: () => null,
      getMetadata: async () => ({ exists: true, size: 1 }),
      options: { timeoutMs: 50, now: () => 0 },
    }),
    (error) => error === expected && error.uploadPhase === 'preflight',
  );
});

test('standard metadata batch uses one deadline across all files', async () => {
  const { readUploadMetadataBatch } = await load();
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    readUploadMetadataBatch(
      ['file:///one.m4a', 'file:///two.m4a'],
      'standard',
      'segment_metadata',
      async () => {
        calls += 1;
        clock += 6;
        return { exists: true, size: 10 };
      },
      { timeoutMs: 10, now: () => clock },
    ),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.fileCount === 2,
  );
  assert.equal(calls, 2);
});

async function loadFfmpegSilenceHarness(getInfoAsync, onExecute) {
  const nativePreflight = await loadTsModule('src/lib/nativePreflight.ts');
  const ffmpeg = await loadTsModule(
    'src/lib/ffmpeg.ts',
    {
      'ffmpeg-kit-react-native': {
        FFmpegKit: {
          execute: async () => {
            onExecute();
            throw new Error('FFmpeg must not start');
          },
        },
        FFprobeKit: {},
        ReturnCode: { isSuccess: () => false },
      },
      'expo-file-system/legacy': {
        getInfoAsync,
        writeAsStringAsync: async () => {},
      },
      'expo-file-system': {
        File: class {},
        Directory: class {},
      },
      './audioTempFiles': { audioTempFiles: {} },
      './waveformCache': {
        getCachedPeaks: () => null,
        cachePeaks: () => {},
      },
      './monitoring': { breadcrumb: () => {} },
      './nativePreflight': nativePreflight,
    },
  );
  return { ffmpeg, nativePreflight };
}

test('silence metadata timeout propagates instead of becoming ffmpeg_error', async () => {
  let executions = 0;
  const { ffmpeg, nativePreflight } = await loadFfmpegSilenceHarness(
    () => new Promise(() => {}),
    () => {
      executions += 1;
    },
  );
  const batch = nativePreflight.createNativePreflightBatch('standard', 1, {
    timeoutMs: 5,
  });
  await assert.rejects(
    ffmpeg.checkAudioSilenceForUpload(
      'file:///recording.m4a',
      {},
      { batch },
    ),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.operation === 'silence_metadata',
  );
  assert.equal(executions, 0);
});

test('ordinary silence metadata failure remains inconclusive', async () => {
  let executions = 0;
  const { ffmpeg } = await loadFfmpegSilenceHarness(
    async () => {
      throw new Error('ordinary native read failure');
    },
    () => {
      executions += 1;
    },
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await ffmpeg.checkAudioSilenceForUpload(
          'file:///recording.m4a',
        ),
      ),
    ),
    { status: 'inconclusive', reason: 'ffmpeg_error' },
  );
  assert.equal(executions, 0);
});

async function loadOversizedHarness({
  getInfoAsync,
  splitAudioBySize,
  nativePreflight,
  onDelete,
  onEnsure,
}) {
  return loadTsModule(
    'src/lib/oversizedSplit.ts',
    {
      'expo-file-system': {
        Paths: {
          document: { uri: 'file:///documents/' },
          availableDiskSpace: 10_000_000_000,
        },
        Directory: class {
          exists = false;
        },
      },
      'expo-file-system/legacy': { getInfoAsync },
      './ffmpeg': { splitAudioBySize },
      './fileOps': {
        safeDeleteDirectory: onDelete,
        ensureDirectory: onEnsure,
      },
      './nativePreflight': nativePreflight,
    },
  );
}

test('split input metadata timeout aborts before FFmpeg or scratch creation', async () => {
  const nativePreflight = await loadTsModule(
    'src/lib/nativePreflight.ts',
    {},
    { setTimeout: (callback) => setTimeout(callback, 0) },
  );
  let splits = 0;
  let directories = 0;
  const oversized = await loadOversizedHarness({
    getInfoAsync: () => new Promise(() => {}),
    splitAudioBySize: async () => {
      splits += 1;
      return [];
    },
    nativePreflight,
    onDelete: () => {},
    onEnsure: () => {
      directories += 1;
    },
  });
  await assert.rejects(
    oversized.maybeSplitForUpload(
      [{ uri: 'file:///large.m4a', duration: 60 }],
      { userId: 'user', slotId: 'slot' },
    ),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.operation === 'split_input_metadata',
  );
  assert.equal(splits, 0);
  assert.equal(directories, 0);
});

test('split output metadata timeout preserves the typed error and removes scratch', async () => {
  const nativePreflight = await loadTsModule('src/lib/nativePreflight.ts');
  const deleted = [];
  const ensured = [];
  const timeout = new nativePreflight.NativePreflightTimeoutError(
    'split_output_metadata',
    'standard',
    2,
  );
  const oversized = await loadOversizedHarness({
    getInfoAsync: async () => ({
      exists: true,
      size: 251 * 1024 * 1024,
    }),
    splitAudioBySize: async () => {
      throw timeout;
    },
    nativePreflight,
    onDelete: (uri) => deleted.push(uri),
    onEnsure: (uri) => ensured.push(uri),
  });
  await assert.rejects(
    oversized.maybeSplitForUpload(
      [{ uri: 'file:///large.m4a', duration: 60 }],
      { userId: 'user', slotId: 'slot' },
    ),
    (error) =>
      error === timeout &&
      error.code === 'NATIVE_PREFLIGHT_TIMEOUT',
  );
  assert.ok(ensured.length >= 2, 'attempt and segment scratch dirs were created');
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^file:\/\/\/documents\/split-temp\/user\/slot-/);
});

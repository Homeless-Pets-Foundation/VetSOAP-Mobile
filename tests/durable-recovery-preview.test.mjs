import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const MODULE = 'src/lib/durableAudio/recoveryPreview.ts';
const SOURCE = 'file:///private/Application%20Support/durable-recordings/user1/rec1/audio.aac';

function frame() {
  const bytes = new Uint8Array(107).fill(0x2a);
  bytes.set([0xff, 0xf1, 0x60, 0x40, 13, 0x7f, 0xfc]);
  return bytes;
}

function audio(count = 2, tornBytes = 0) {
  const bytes = new Uint8Array(count * 107 + tornBytes);
  for (let i = 0; i < count; i++) bytes.set(frame(), i * 107);
  if (tornBytes) bytes.set(frame().slice(0, tornBytes), count * 107);
  return bytes;
}

function offer(bytes, overrides = {}) {
  return {
    schemaVersion: 3, recordingId: 'rec1', userId: 'user1', slotId: 'slot1', state: 'stopped',
    startedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:01:00.000Z',
    container: 'adts', codec: 'aac_lc', bitrate: 48000, sampleRate: 16000, channels: 1,
    adtsFrameCount: 2, durationMs: 128, capturedDurationMs: 128,
    audioFile: { uri: SOURCE, committedBytes: bytes.length, completeFrameBytes: bytes.length },
    peakDb: -10, appVersion: '1.0.0', buildNumber: '1', ...overrides,
  };
}

async function setup({ bytes = audio(), overrides = {}, missing = false, unreadable = false, writeFails = false } = {}) {
  const m = offer(bytes, overrides);
  const files = new Map([[m.audioFile.uri, bytes.slice()]]);
  const preserved = {
    offers: [m], drafts: [{ id: 'saved-draft' }], holds: ['held'], tombstones: ['uploaded'],
    uploads: { pending: 'unchanged' }, manifests: JSON.stringify(m),
  };
  const before = JSON.stringify(preserved);
  const calls = { read: [], write: [], close: 0, cleanup: [] };
  let recorderActive = false;
  const fileOps = {
    writeFilePrefix(source, dest, count) {
      calls.write.push({ source, dest, count });
      files.set(dest, files.get(source).slice(0, count));
      return !writeFails;
    },
  };
  const mod = await loadTsModule(MODULE, {
    'expo-file-system': {
      File: class {
        constructor(uri) { this.uri = uri; }
        get exists() { return !missing && files.has(this.uri); }
        get size() { return files.get(this.uri)?.length ?? 0; }
        open() {
          const uri = this.uri;
          return {
            readBytes(count) {
              calls.read.push(count);
              if (unreadable) throw new Error('locked storage');
              return files.get(uri).slice(0, count);
            },
            close() { calls.close++; },
          };
        }
      },
    },
    '../fileOps': fileOps,
    '../audioTempFiles': {
      audioTempFiles: {
        ensureDir() {},
        getTrimOutputPath(_index, suffix) { return `file:///cache/audio-edit/${suffix}.m4a`; },
        cleanupFile(uri) { calls.cleanup.push(uri); files.delete(uri); },
      },
    },
    './recoveryState': { durableRecoveryStore: { getSnapshot: () => preserved.offers } },
    '../recordingActivity': { recordingActivity: { isActive: () => recorderActive } },
  }, {
    setTimeout: (callback, ms) => setTimeout(callback, ms === 10_000 ? 10 : ms),
  });
  return {
    ...mod, m, files, calls, preserved,
    setRecorderActive: (next) => { recorderActive = next; },
    unchanged() {
      assert.equal(JSON.stringify(preserved), before);
      assert.deepEqual(files.get(m.audioFile.uri), bytes);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('short recovery preview reads/copies complete AAC frames without changing saved work', async () => {
  const s = await setup();
  const result = await s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal);
  assert.equal(result.durationSeconds, 0.128);
  assert.match(result.uri, /^file:\/\/\/cache\/audio-edit\/recovery-preview-\d+\.aac$/);
  assert.deepEqual(s.files.get(result.uri), audio());
  assert.deepEqual(s.calls.read, [214]);
  assert.equal(s.calls.close, 1);
  assert.equal(s.calls.write.length, 1);
  s.unchanged();
});

test('validating legacy confirmation proof never hydrates or rewrites the recovery offer', async () => {
  const recordingId = '11111111-1111-4111-8111-111111111111';
  const s = await setup({ overrides: {
    pendingConfirmJson: JSON.stringify({
      recordingId,
      fileKey: `recordings/22222222-2222-4222-8222-222222222222/${recordingId}.aac`,
    }),
  } });
  await s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal);
  assert.equal(Object.hasOwn(s.m, 'pendingConfirm'), false);
  s.unchanged();
});

test('preparation reads at most 1 MiB and labels at most 60 seconds as preview', async () => {
  const s = await setup({ bytes: audio(12_000) });
  const result = await s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal);
  assert.deepEqual(s.calls.read, [1024 * 1024]);
  assert.equal(s.calls.write[0].count, Math.floor(60 * 16000 / 1024) * 107);
  assert.equal(result.durationSeconds, 59.968);
  s.unchanged();
});

test('torn tail and stale complete-byte hint never copy an incomplete frame', async () => {
  for (const extraHint of [0, 1000]) {
    const bytes = audio(2, 35);
    const s = await setup({ bytes, overrides: {
      audioFile: { uri: SOURCE, committedBytes: bytes.length, completeFrameBytes: bytes.length + extraHint },
    } });
    const result = await s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal);
    assert.deepEqual(s.calls.read, [bytes.length]);
    assert.deepEqual(s.files.get(result.uri), audio());
    s.unchanged();
  }
});

test('manifest boundary limits reads even when source holds more complete frames', async () => {
  const s = await setup({ bytes: audio(8), overrides: {
    audioFile: { uri: SOURCE, committedBytes: 856, completeFrameBytes: 214 },
  } });
  await s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal);
  assert.deepEqual(s.calls.read, [214]);
  s.unchanged();
});

test('wrong account, invalid identifiers and noncanonical paths fail before reading', async () => {
  for (const changes of [
    { userId: 'other' }, { recordingId: '../rec1' }, { slotId: 'bad/slot' }, { state: 'uploaded' },
    ...[
      'https://example.test/audio.aac', 'file://remote/durable-recordings/user1/rec1/audio.aac',
      'file:///tmp/durable-recordings/other/rec1/audio.aac',
      'file:///tmp/durable-recordings/user1/other/audio.aac',
      'file:///tmp/durable-recordings/user1/rec1/other.aac',
      'file:///tmp/../durable-recordings/user1/rec1/audio.aac',
      'file:///tmp/%2e%2e/durable-recordings/user1/rec1/audio.aac',
      'file:///tmp/%2f/durable-recordings/user1/rec1/audio.aac',
      'file:///tmp/%255c/durable-recordings/user1/rec1/audio.aac',
      'file:///tmp/durable-recordings/user1/rec1/audio.aac?query',
    ].map((uri) => ({ audioFile: { uri, committedBytes: 214, completeFrameBytes: 214 } })),
  ]) {
    const s = await setup({ overrides: changes });
    await assert.rejects(s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal));
    assert.equal(s.calls.read.length, 0);
    assert.equal(s.calls.write.length, 0);
    s.unchanged();
  }
});

test('retired offer, cancelled request and active or paused recorder cannot prepare', async () => {
  const s = await setup();
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(s.prepareRecoveryPreview(s.m, 'user1', cancellation.signal));
  await assert.rejects(s.prepareRecoveryPreview({ ...s.m }, 'user1', new AbortController().signal));
  s.setRecorderActive(true);
  await assert.rejects(s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal));
  assert.equal(s.calls.read.length, 0);
  s.unchanged();
});

test('missing, unreadable, malformed and failed-copy audio stay untouched without whole-source fallback', async () => {
  for (const options of [{ missing: true }, { unreadable: true }, { bytes: new Uint8Array(40) }, { writeFails: true }]) {
    const s = await setup(options);
    await assert.rejects(s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal));
    assert.equal(s.calls.write.length, options.writeFails ? 1 : 0);
    assert.equal(s.files.size, 1);
    if (options.unreadable) assert.equal(s.calls.close, 1);
    s.unchanged();
  }
});

test('timeout and cancellation retire late reads before any copy', async () => {
  for (const cancel of [false, true]) {
    const s = await setup();
    const read = deferred();
    const controller = new AbortController();
    let copied = false;
    const promise = s.prepareRecoveryPreview(s.m, 'user1', controller.signal, {
      readPrefix: () => read.promise,
      writePrefix: () => { copied = true; return true; },
    });
    if (cancel) controller.abort();
    await assert.rejects(promise);
    read.resolve(audio());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(copied, false);
    s.unchanged();
  }
});

test('late copy after timeout or cancellation deletes its derived output', async () => {
  for (const cancel of [false, true]) {
    const s = await setup();
    const write = deferred();
    const started = deferred();
    const controller = new AbortController();
    let destination;
    const promise = s.prepareRecoveryPreview(s.m, 'user1', controller.signal, {
      readPrefix: async () => audio(),
      writePrefix: async (_source, dest) => {
        destination = dest;
        started.resolve();
        await write.promise;
        s.files.set(dest, audio());
        return true;
      },
    });
    await started.promise;
    if (cancel) controller.abort();
    await assert.rejects(promise);
    write.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.files.has(destination), false);
    assert(s.calls.cleanup.includes(destination));
    s.unchanged();
  }
});

test('ownership or account-offer changes during preparation reject late completion', async () => {
  for (const change of ['recorder', 'account']) {
    const s = await setup();
    const read = deferred();
    let copied = false;
    const promise = s.prepareRecoveryPreview(s.m, 'user1', new AbortController().signal, {
      readPrefix: () => read.promise,
      writePrefix: () => { copied = true; return true; },
    });
    if (change === 'recorder') s.setRecorderActive(true);
    else s.preserved.offers = [];
    read.resolve(audio());
    await assert.rejects(promise);
    assert.equal(copied, false);
    if (change === 'account') s.preserved.offers = [s.m];
    s.unchanged();
  }
});

test('preview preparation never imports the manifest bridge or recovery mutations', async () => {
  const source = await readFile(new URL(`../${MODULE}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /captivet-durable-recorder|getManifest\(|listRecoverableSessions\(|saveDraft\(|\.remove\(|\.discard\(|\.purge\(/);
});


test('recovery labels retain width and explicit actions stack at large text sizes', async () => {
  const source = await readFile(new URL('../app/(app)/durable-recovery.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="text-display font-semibold text-content-primary flex-1">Recovered Recordings/);
  assert.match(source, /className="text-content-primary font-medium flex-1">Unsaved recording/);
  assert.match(source, /<View className="gap-2 mt-1">[\s\S]*?handleRestore\(m\)[\s\S]*?handleDiscard\(m\)/);
});

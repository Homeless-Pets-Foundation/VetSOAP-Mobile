import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const entries = new Map();
let throwOnOpen = false;
let failCloseTimes = 0;
let closeCalls = 0;

class MockFile {
  constructor(parent, name) {
    this.uri = parent instanceof MockDirectory ? `${parent.uri}/${name}` : String(parent);
  }

  get name() {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }

  get exists() {
    return entries.get(this.uri)?.exists === true;
  }

  open() {
    if (throwOnOpen) throw new Error('synthetic provider open failure');
    const entry = entries.get(this.uri);
    if (!entry?.exists) throw new Error('missing');
    return {
      writeBytes(bytes) {
        entry.bytes.push(...bytes);
      },
      close() {
        closeCalls += 1;
        if (failCloseTimes > 0) {
          failCloseTimes -= 1;
          throw new Error('synthetic provider close failure');
        }
      },
    };
  }

  move(destination) {
    if (destination.exists) throw new Error('destination exists');
    const entry = entries.get(this.uri);
    if (!entry?.exists) throw new Error('missing');
    entries.set(destination.uri, entry);
    entries.set(this.uri, { exists: false, bytes: [] });
    this.uri = destination.uri;
  }

  delete() {
    const entry = entries.get(this.uri);
    if (!entry?.exists) throw new Error('missing');
    entry.exists = false;
  }
}

class MockDirectory {
  static selected = new MockDirectory('content://downloads');

  static async pickDirectoryAsync() {
    return MockDirectory.selected;
  }

  constructor(uri) {
    this.uri = uri;
  }

  createFile(name) {
    const file = new MockFile(this, name);
    if (file.exists) throw new Error('destination exists');
    entries.set(file.uri, { exists: true, bytes: [] });
    return file;
  }

  list() {
    return [...entries.entries()]
      .filter(([uri, entry]) => entry.exists && uri.startsWith(`${this.uri}/`))
      .map(([uri]) => new MockFile(uri));
  }
}

const native = await loadTsModule(
  'src/lib/audioDownloadNative.ts',
  {
    'expo-file-system': { Directory: MockDirectory, File: MockFile },
    'expo/fetch': { fetch: async () => { throw new Error('unused'); } },
  }
);

test.beforeEach(() => {
  entries.clear();
  throwOnOpen = false;
  failCloseTimes = 0;
  closeCalls = 0;
});

test('native destination registers a staging file before the first provider open', async () => {
  const destination = await native.pickAudioDownloadDestination();
  const file = destination.create('attempt.partial', 'final.m4a', 'audio/mp4');
  throwOnOpen = true;

  assert.throws(() => file.write(Uint8Array.from([1])));
  assert.equal(file.remove(), true);
  assert.equal(entries.get('content://downloads/attempt.partial').exists, false);
});

test('native destination promotes a verified staging file only on commit', async () => {
  const destination = await native.pickAudioDownloadDestination();
  const file = destination.create('attempt.partial', 'final.m4a', 'audio/mp4');
  file.write(Uint8Array.from([1, 2, 3]));
  file.close();

  assert.equal(entries.has('content://downloads/final.m4a'), false);
  file.commit();
  assert.equal(entries.get('content://downloads/attempt.partial').exists, false);
  assert.deepEqual(entries.get('content://downloads/final.m4a').bytes, [1, 2, 3]);
});

test('native destination retries a failed provider close during rollback so the partial can be deleted', async () => {
  const destination = await native.pickAudioDownloadDestination();
  const file = destination.create('attempt.partial', 'final.m4a', 'audio/mp4');
  file.write(Uint8Array.from([1, 2, 3]));
  failCloseTimes = 1;

  assert.throws(() => file.close(), /synthetic provider close failure/);
  // The wrapper is closed to further writes even though the handle is still open.
  assert.throws(() => file.write(Uint8Array.from([4])), /closed/);

  // remove() retries the native close before asking the provider to delete.
  assert.equal(file.remove(), true);
  assert.equal(closeCalls, 2);
  assert.equal(entries.get('content://downloads/attempt.partial').exists, false);
});

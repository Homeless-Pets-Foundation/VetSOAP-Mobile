import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const download = await loadTsModule('src/lib/audioDownload.ts');
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

function manifest({
  urls = ['https://r2.test/part-1', 'https://r2.test/part-2'],
  sizes = [3, 4],
  expiresAt = new Date(NOW + 18 * 60 * 1000).toISOString(),
} = {}) {
  const count = urls.length;
  return {
    expiresAt,
    totalSizeBytes: sizes.reduce((sum, size) => sum + size, 0),
    files: urls.map((url, index) => ({
      partNumber: index + 1,
      partCount: count,
      filename:
        count === 1
          ? 'Captivet-recording-2026-09-01-id.m4a'
          : `Captivet-recording-2026-09-01-id-part-${String(index + 1).padStart(2, '0')}-of-${String(count).padStart(2, '0')}.m4a`,
      mimeType: 'audio/mp4',
      sizeBytes: sizes[index],
      url,
    })),
  };
}

function makeDestination({
  existing = [],
  failCreateAt = -1,
  failWriteAt = -1,
  failCommitAt = -1,
  removeResult = true,
} = {}) {
  const targets = [];
  const createdNames = [];
  const finalNames = [];
  return {
    targets,
    createdNames,
    finalNames,
    api: {
      listNames() {
        return [...existing];
      },
      create(name, finalName) {
        if (targets.length === failCreateAt) throw new Error('synthetic create failure');
        const targetIndex = targets.length;
        const target = {
          name,
          finalName,
          chunks: [],
          closes: 0,
          removed: false,
          committed: false,
          write(bytes) {
            if (targetIndex === failWriteAt) throw new Error('synthetic open/write failure');
            this.chunks.push([...bytes]);
          },
          close() {
            this.closes += 1;
          },
          remove() {
            this.removed = true;
            return removeResult;
          },
          commit() {
            if (targetIndex === failCommitAt) throw new Error('synthetic commit failure');
            this.committed = true;
          },
        };
        targets.push(target);
        createdNames.push(name);
        finalNames.push(finalName);
        return target;
      },
    },
  };
}

async function* chunks(...values) {
  for (const value of values) yield Uint8Array.from(value);
}

function response(url, values, overrides = {}) {
  const total = values.reduce((sum, value) => sum + value.length, 0);
  return {
    status: 200,
    redirected: false,
    finalUrl: url,
    contentLength: total,
    chunks: chunks(...values),
    ...overrides,
  };
}

async function rejectionCode(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected audio download to reject');
}

test('manifest requests have an absolute deadline even when auth refresh hangs', async () => {
  const error = await rejectionCode(
    download.waitForAudioDownloadManifest(
      new Promise(() => {}),
      new AbortController().signal,
      5
    )
  );
  assert.equal(error.code, 'manifest_fetch_failed');
});

test('cancellation settles a hanging manifest refresh and observes its late rejection', async () => {
  const controller = new AbortController();
  let rejectSource;
  const source = new Promise((_resolve, reject) => {
    rejectSource = reject;
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const pending = download.waitForAudioDownloadManifest(source, controller.signal, 50);
    controller.abort();
    const error = await rejectionCode(pending);
    assert.equal(error.code, 'cancelled');
    rejectSource(new Error('late auth refresh rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('streams parts sequentially and reports byte progress through exact completion', async () => {
  const source = manifest();
  const destination = makeDestination();
  const fetchOrder = [];
  const progress = [];
  let active = 0;
  let maxActive = 0;

  const result = await download.downloadAudioManifest({
    manifest: source,
    destination: destination.api,
    refreshManifest: async () => source,
    fetchPart: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      fetchOrder.push(url);
      const value = url.endsWith('1') ? response(url, [[1], [2, 3]]) : response(url, [[4, 5, 6, 7]]);
      active -= 1;
      return value;
    },
    signal: new AbortController().signal,
    now: () => NOW,
    onProgress: (value) => progress.push({ ...value }),
  });

  assert.equal(result.bytesWritten, 7);
  assert.equal(result.partCount, 2);
  assert.deepEqual(fetchOrder, source.files.map((file) => file.url));
  assert.equal(maxActive, 1);
  assert.equal(destination.targets.length, 2);
  assert.deepEqual(destination.targets[0].chunks, [[1], [2, 3]]);
  assert.deepEqual(progress.at(-1), {
    bytesWritten: 7,
    totalBytes: 7,
    partNumber: 2,
    partCount: 2,
  });
  assert.equal(destination.targets.some((target) => target.removed), false);
  assert.equal(destination.targets.every((target) => target.committed), true);
  assert.equal(destination.createdNames.every((name) => name.endsWith('.partial')), true);
  assert.deepEqual(destination.finalNames, source.files.map((file) => file.filename));
});

test('rejects oversized and short bodies and rolls back every file from the attempt', async () => {
  for (const [values, expectedCode] of [
    [[[1, 2, 3, 4]], 'size_exceeded'],
    [[[1, 2]], 'size_mismatch'],
  ]) {
    const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
    const destination = makeDestination({ existing: ['pre-existing.m4a'] });
    const error = await rejectionCode(
      download.downloadAudioManifest({
        manifest: source,
        destination: destination.api,
        refreshManifest: async () => source,
        fetchPart: async (url) => response(url, values, { contentLength: null }),
        signal: new AbortController().signal,
        now: () => NOW,
      })
    );
    assert.equal(error.code, expectedCode);
    assert.equal(error.rollbackIncomplete, false);
    assert.equal(destination.targets[0].removed, true);
    assert.deepEqual(destination.createdNames.includes('pre-existing.m4a'), false);
  }
});

test('a later multipart failure rolls back both completed and partial files', async () => {
  const source = manifest();
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) =>
        url.endsWith('1')
          ? response(url, [[1, 2, 3]])
          : response(url, [[4, 5]], { contentLength: null }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );

  assert.equal(error.code, 'size_mismatch');
  assert.equal(destination.targets.length, 2);
  assert.equal(destination.targets.every((target) => target.removed), true);
  assert.equal(destination.targets.some((target) => target.committed), false);
});

test('blocks redirects before creating a destination file', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => response(url, [[1, 2, 3]], { redirected: true }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'redirect_blocked');
  assert.equal(destination.targets.length, 0);
});

test('aborts the network response after detecting an oversized stream', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  let networkAborted = false;
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url, signal) => {
        signal.addEventListener('abort', () => {
          networkAborted = true;
        });
        return response(url, [[1, 2, 3, 4]], { contentLength: null });
      },
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );

  assert.equal(error.code, 'size_exceeded');
  assert.equal(networkAborted, true);
});

test('watchdog settles even when a stalled fetch ignores abort', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: () => new Promise(() => {}),
      signal: new AbortController().signal,
      now: () => NOW,
      partTimeoutMs: 5,
    })
  );
  assert.equal(error.code, 'part_timeout');
  assert.equal(destination.targets.length, 0);
});

test('watchdog settles a stalled stream that ignores abort and rolls back written bytes', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => ({
        status: 200,
        redirected: false,
        finalUrl: url,
        contentLength: 3,
        chunks: (async function* () {
          yield Uint8Array.from([1]);
          await new Promise(() => {});
        })(),
      }),
      signal: new AbortController().signal,
      now: () => NOW,
      partTimeoutMs: 5,
    })
  );
  assert.equal(error.code, 'part_timeout');
  assert.equal(destination.targets[0].removed, true);
});

test('refreshes before guaranteed expiry and resumes with unchanged descriptors', async () => {
  const initial = manifest({
    urls: ['https://r2.test/object?signature=old'],
    sizes: [3],
    expiresAt: new Date(NOW + 18 * 60 * 1000).toISOString(),
  });
  const refreshed = manifest({ urls: ['https://r2.test/object?signature=fresh'], sizes: [3] });
  const destination = makeDestination();
  let refreshCount = 0;
  const fetched = [];

  await download.downloadAudioManifest({
    manifest: initial,
    destination: destination.api,
    refreshManifest: async () => {
      refreshCount += 1;
      return refreshed;
    },
    fetchPart: async (url) => {
      fetched.push(url);
      return response(url, [[1, 2, 3]]);
    },
    signal: new AbortController().signal,
    now: () => NOW,
    elapsedNow: (() => {
      let calls = 0;
      return () => (calls++ === 0 ? 0 : 101);
    })(),
    manifestRefreshAfterMs: 100,
  });

  assert.equal(refreshCount, 1);
  assert.deepEqual(fetched, ['https://r2.test/object?signature=fresh']);
});

test('refreshes once after an R2 authorization-expiry response and retries the same part', async () => {
  const initial = manifest({ urls: ['https://r2.test/object?signature=old'], sizes: [3] });
  const refreshed = manifest({ urls: ['https://r2.test/object?signature=fresh'], sizes: [3] });
  const destination = makeDestination();
  const fetched = [];
  let refreshCount = 0;

  await download.downloadAudioManifest({
    manifest: initial,
    destination: destination.api,
    refreshManifest: async () => {
      refreshCount += 1;
      return refreshed;
    },
    fetchPart: async (url) => {
      fetched.push(url);
      if (url.endsWith('old')) {
        return response(url, [], { status: 403, contentLength: 0 });
      }
      return response(url, [[1, 2, 3]]);
    },
    signal: new AbortController().signal,
    now: () => NOW,
  });

  assert.equal(refreshCount, 1);
  assert.deepEqual(fetched, [
    'https://r2.test/object?signature=old',
    'https://r2.test/object?signature=fresh',
  ]);
});

test('fails closed when a refreshed manifest changes ordered descriptors', async () => {
  const initial = manifest({
    urls: ['https://r2.test/object?signature=old'],
    sizes: [3],
    expiresAt: new Date(NOW + 18 * 60 * 1000).toISOString(),
  });
  const changed = manifest({ urls: ['https://r2.test/object?signature=fresh'], sizes: [4] });
  const destination = makeDestination();
  let fetchCount = 0;
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: initial,
      destination: destination.api,
      refreshManifest: async () => changed,
      fetchPart: async () => {
        fetchCount += 1;
        throw new Error('must not fetch');
      },
      signal: new AbortController().signal,
      now: () => NOW,
      elapsedNow: (() => {
        let calls = 0;
        return () => (calls++ === 0 ? 0 : 101);
      })(),
      manifestRefreshAfterMs: 100,
    })
  );
  assert.equal(error.code, 'manifest_changed');
  assert.equal(fetchCount, 0);
});

test('cancellation aborts streaming and removes the partial file', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [4] });
  const destination = makeDestination();
  const controller = new AbortController();
  async function* cancellingChunks() {
    yield Uint8Array.from([1, 2]);
    controller.abort();
    yield Uint8Array.from([3, 4]);
  }
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => ({
        status: 200,
        redirected: false,
        finalUrl: url,
        contentLength: 4,
        chunks: cancellingChunks(),
      }),
      signal: controller.signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'cancelled');
  assert.equal(destination.targets[0].removed, true);
});

test('cancellation settles even when the pending stream read ignores abort', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  const controller = new AbortController();
  let reads = 0;
  const stalledChunks = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: Uint8Array.from([1]) });
          return new Promise(() => {});
        },
        return() {
          return new Promise(() => {});
        },
      };
    },
  };
  const pending = download.downloadAudioManifest({
    manifest: source,
    destination: destination.api,
    refreshManifest: async () => source,
    fetchPart: async (url) => ({
      status: 200,
      redirected: false,
      finalUrl: url,
      contentLength: 3,
      chunks: stalledChunks,
    }),
    signal: controller.signal,
    now: () => NOW,
  });
  setTimeout(() => controller.abort(), 5);

  const error = await rejectionCode(pending);
  assert.equal(error.code, 'cancelled');
  assert.equal(destination.targets[0].removed, true);
});

test('one batch-wide timestamp suffix resolves any collision without overwriting originals', () => {
  const source = manifest();
  const resolved = download.resolveBatchDownloadFilenames(
    source.files,
    [source.files[1].filename],
    NOW
  );
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every((name) => name.includes('-20260901-120000-000.m4a')));
  assert.ok(resolved.every((name) => !source.files.some((file) => file.filename === name)));
});

test('discloses incomplete rollback when the provider refuses deletion', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination({ removeResult: false });
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => response(url, [[1, 2]], { contentLength: null }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'size_mismatch');
  assert.equal(error.rollbackIncomplete, true);
});

test('a first-write/open failure remains included in rollback reporting', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination({ failWriteAt: 0, removeResult: false });
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => response(url, [[1, 2, 3]]),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );

  assert.equal(error.code, 'write_failed');
  assert.equal(destination.targets.length, 1);
  assert.equal(destination.targets[0].removed, true);
  assert.equal(error.rollbackIncomplete, true);
});

test('a promotion failure rolls back staged and already-promoted files', async () => {
  const source = manifest();
  const destination = makeDestination({ failCommitAt: 1 });
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) =>
        url.endsWith('1') ? response(url, [[1, 2, 3]]) : response(url, [[4, 5, 6, 7]]),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );

  assert.equal(error.code, 'write_failed');
  assert.equal(destination.targets.every((target) => target.removed), true);
});

test('cancellation during an authorization-expiry manifest refresh stays a cancellation', async () => {
  const initial = manifest({ urls: ['https://r2.test/object?signature=old'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: initial,
      destination: destination.api,
      refreshManifest: async () => {
        throw new download.AudioDownloadError('cancelled');
      },
      fetchPart: async (url) => response(url, [], { status: 403, contentLength: 0 }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'cancelled');
  assert.equal(destination.targets.length, 0);
});

test('a genuine refresh failure is still reported as manifest_refresh_failed', async () => {
  const initial = manifest({ urls: ['https://r2.test/object?signature=old'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: initial,
      destination: destination.api,
      refreshManifest: async () => {
        throw new Error('api unavailable');
      },
      fetchPart: async (url) => response(url, [], { status: 403, contentLength: 0 }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'manifest_refresh_failed');
});

test('a response stream that drops mid-body is a network failure, not a write failure', async () => {
  const source = manifest({ urls: ['https://r2.test/one'], sizes: [3] });
  const destination = makeDestination();
  const error = await rejectionCode(
    download.downloadAudioManifest({
      manifest: source,
      destination: destination.api,
      refreshManifest: async () => source,
      fetchPart: async (url) => ({
        status: 200,
        redirected: false,
        finalUrl: url,
        contentLength: 3,
        chunks: (async function* () {
          yield Uint8Array.from([1]);
          throw new Error('socket hang up');
        })(),
      }),
      signal: new AbortController().signal,
      now: () => NOW,
    })
  );
  assert.equal(error.code, 'network_failed');
  assert.deepEqual(destination.targets[0].chunks, [[1]]);
  assert.equal(destination.targets[0].removed, true);
});

test('the recording detail screen validates downloads against the recording tenant', async () => {
  const source = await readFile(
    new URL('../app/(app)/(tabs)/recordings/[id].tsx', import.meta.url),
    'utf8'
  );
  assert.match(source, /<RecordingAudioPlayer[\s\S]*?organizationId=\{recording\.organizationId\}/);
  assert.doesNotMatch(source, /organizationId=\{user\?\.organizationId/);
});

test('download UI prevents double taps, resets state in finally, and aborts on unmount', async () => {
  const source = await readFile(
    new URL('../src/components/RecordingAudioDownload.tsx', import.meta.url),
    'utf8'
  );
  assert.match(source, /if \(disabled \|\| inFlightRef\.current\) return;/);
  assert.match(source, /inFlightRef\.current = true;/);
  assert.match(source, /finally \{[\s\S]*inFlightRef\.current = false;/);
  assert.match(source, /return \(\) => \{[\s\S]*abortRef\.current\?\.abort\(\);/);
  assert.match(source, /pickAudioDownloadDestination\(\)[\s\S]*getDownloadManifest/);
  assert.match(source, /withPromiseTimeout\([\s\S]*pickAudioDownloadDestination\(\)/);
  assert.match(source, /const manifest = await requestManifest\(\)/);
  assert.match(source, /refreshManifest: requestManifest/);
  assert.match(source, /code === 'cancelled'[\s\S]*error\.rollbackIncomplete/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)/);
});

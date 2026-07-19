import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

function recordingId(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

test('draft-presence contract accepts 1 and 50 unique IDs and rejects empty, duplicate, and 51', async () => {
  const { draftPresenceRequestSchema } = await loadTsModule(
    'src/api/draftPresenceContract.ts',
  );
  assert.equal(
    draftPresenceRequestSchema.safeParse({ recordingIds: [recordingId(1)] }).success,
    true,
  );
  assert.equal(
    draftPresenceRequestSchema.safeParse({
      recordingIds: Array.from({ length: 50 }, (_, index) => recordingId(index)),
    }).success,
    true,
  );
  for (const recordingIds of [
    [],
    [recordingId(1), recordingId(1)],
    Array.from({ length: 51 }, (_, index) => recordingId(index)),
  ]) {
    assert.equal(
      draftPresenceRequestSchema.safeParse({ recordingIds }).success,
      false,
    );
  }
});

test('draft-presence response parser rejects malformed, duplicate, and foreign rows', async () => {
  const { parseDraftPresenceResponse } = await loadTsModule(
    'src/api/draftPresenceContract.ts',
  );
  const requested = [recordingId(1), recordingId(2)];
  assert.deepEqual(
    parseDraftPresenceResponse(requested, {
      recordings: [{ id: requested[0], status: 'completed' }],
    }),
    { recordings: [{ id: requested[0], status: 'completed' }] },
  );

  for (const response of [
    { recordings: [{ id: requested[0], status: 'not-a-status' }] },
    {
      recordings: [
        { id: requested[0], status: 'draft' },
        { id: requested[0], status: 'draft' },
      ],
    },
    { recordings: [{ id: recordingId(99), status: 'draft' }] },
    { recordings: [], unexpected: true },
  ]) {
    assert.throws(() => parseDraftPresenceResponse(requested, response));
  }
});

test('batch snapshot deduplicates IDs, preserves statuses, and marks omissions missing', async () => {
  const { runDraftPresenceBatches } = await loadTsModule(
    'src/lib/draftPresenceBatch.ts',
  );
  const first = recordingId(1);
  const second = recordingId(2);
  const requests = [];
  const snapshot = await runDraftPresenceBatches(
    [second, first, first],
    async (ids) => {
      requests.push([...ids]);
      return { recordings: [{ id: second, status: 'completed' }] };
    },
    () => true,
  );

  assert.deepEqual(requests, [[first, second]]);
  assert.equal(snapshot.statusById.get(first), 'missing');
  assert.equal(snapshot.statusById.get(second), 'completed');
});

test('batch snapshot chunks more than 50 IDs with no more than two requests in flight', async () => {
  const { runDraftPresenceBatches } = await loadTsModule(
    'src/lib/draftPresenceBatch.ts',
  );
  const ids = Array.from({ length: 101 }, (_, index) => recordingId(index));
  let active = 0;
  let maxActive = 0;
  const chunkSizes = [];
  const snapshot = await runDraftPresenceBatches(
    ids,
    async (chunk) => {
      active++;
      maxActive = Math.max(maxActive, active);
      chunkSizes.push(chunk.length);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { recordings: chunk.map((id) => ({ id, status: 'draft' })) };
    },
    () => true,
  );

  assert.deepEqual(chunkSizes.sort((a, b) => b - a), [50, 50, 1]);
  assert.equal(maxActive, 2);
  assert.equal(snapshot.statusById.size, 101);
});

test('failed, timed-out, or scope-interrupted chunk publishes no partial snapshot', async () => {
  const { runDraftPresenceBatches } = await loadTsModule(
    'src/lib/draftPresenceBatch.ts',
  );
  const ids = Array.from({ length: 51 }, (_, index) => recordingId(index));

  const failed = await runDraftPresenceBatches(
    ids,
    async (chunk) => {
      if (chunk.length === 1) throw new Error('failed chunk');
      return { recordings: chunk.map((id) => ({ id, status: 'draft' })) };
    },
    () => true,
  );
  assert.equal(failed, null);

  const timedOut = await runDraftPresenceBatches(
    [ids[0]],
    async () => {
      throw new Error('Request timeout after 10000ms');
    },
    () => true,
  );
  assert.equal(timedOut, null);

  let valid = true;
  const interrupted = await runDraftPresenceBatches(
    [ids[0]],
    async (chunk) => {
      valid = false;
      return { recordings: chunk.map((id) => ({ id, status: 'draft' })) };
    },
    () => valid,
  );
  assert.equal(interrupted, null);
});

async function loadRuntimeHarness() {
  let appState = 'active';
  let userId = 'user-a';
  let userScopeVersion = 1;
  const appListeners = new Set();
  const userListeners = new Set();
  let aborted = false;
  let requests = 0;
  let requestImpl = async (ids) => ({
    recordings: ids.map((id) => ({ id, status: 'draft' })),
  });
  const draftStorage = {
    getUserId: () => userId,
    getUserScopeVersion: () => userScopeVersion,
    subscribeUserIdChanges(listener) {
      userListeners.add(listener);
      return () => userListeners.delete(listener);
    },
  };
  const AppState = {
    get currentState() {
      return appState;
    },
    addEventListener(_event, listener) {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  };
  const recordingsApi = {
    draftPresence(ids, { signal }) {
      requests++;
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return requestImpl(ids, signal);
    },
  };
  const mod = await loadTsModule('src/api/draftPresence.ts', {
    'react-native': { AppState },
    './recordings': { recordingsApi },
    '../lib/draftStorage': { draftStorage },
    '../lib/monitoring': {
      measurePhase: (_name, _tags, fn) => fn(),
    },
  });
  return {
    mod,
    get requests() {
      return requests;
    },
    get aborted() {
      return aborted;
    },
    setRequestImpl(value) {
      requestImpl = value;
    },
    background() {
      appState = 'background';
      for (const listener of appListeners) listener(appState);
    },
    changeUser(nextUserId) {
      userId = nextUserId;
      userScopeVersion++;
      for (const listener of userListeners) listener(userId);
    },
  };
}

test('runtime snapshot aborts and returns unknown when the app backgrounds', async () => {
  const harness = await loadRuntimeHarness();
  harness.setRequestImpl((_ids, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  );
  const promise = harness.mod.getDraftPresenceSnapshot('user-a', [recordingId(1)]);
  await Promise.resolve();
  harness.background();
  assert.equal(await promise, null);
  assert.equal(harness.aborted, true);
});

test('runtime snapshot aborts and returns unknown when auth scope changes', async () => {
  const harness = await loadRuntimeHarness();
  harness.setRequestImpl((_ids, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  );
  const promise = harness.mod.getDraftPresenceSnapshot('user-a', [recordingId(1)]);
  await Promise.resolve();
  harness.changeUser('user-b');
  assert.equal(await promise, null);
  assert.equal(harness.aborted, true);
});

test('runtime snapshot reuses a validated superset without another request', async () => {
  const harness = await loadRuntimeHarness();
  const first = recordingId(1);
  const second = recordingId(2);
  const superset = await harness.mod.getDraftPresenceSnapshot('user-a', [first, second]);
  const subset = await harness.mod.getDraftPresenceSnapshot('user-a', [first]);
  assert.equal(superset.statusById.get(first), 'draft');
  assert.equal(subset.statusById.get(first), 'draft');
  assert.equal(harness.requests, 1);
});

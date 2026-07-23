import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { loadTsModule } from './helpers/loadTs.mjs';

// Phase 3 of docs/plans/2026-07-23-sentry-error-remediation.md (Connect repo):
// - REACT-NATIVE-1F: 'no_local_meta' from updateServerDraftId surfaces to
//   callers so the just-created server row can be deleted instead of
//   stranding forever.
// - REACT-NATIVE-1A/1B: measurePhase suppresses the slow-phase warning when
//   the app left 'active' mid-measurement (performance.now() keeps counting
//   through suspension); the phase_complete breadcrumb keeps the raw duration.

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

// ─── monitoring: suspension guard ────────────────────────────────────

async function loadMonitoringHarness() {
  let now = 0;
  const breadcrumbs = [];
  const messages = [];
  const appStateListeners = [];
  const appState = {
    currentState: 'active',
    addEventListener(_event, cb) {
      appStateListeners.push(cb);
      return { remove() {} };
    },
  };
  const sentry = {
    init() {},
    setTag() {},
    addBreadcrumb(value) {
      breadcrumbs.push(value);
    },
    captureMessage(message, context) {
      messages.push({ message, context });
    },
    breadcrumbsIntegration: () => ({ name: 'Breadcrumbs' }),
  };
  const monitoring = await loadTsModule(
    'src/lib/monitoring.ts',
    {
      '@sentry/react-native': sentry,
      'react-native': {
        DeviceEventEmitter: { addListener() {} },
        Platform: { OS: 'android' },
        AppState: appState,
      },
      'expo-constants': {
        __esModule: true,
        default: { expoConfig: { version: 'test' } },
      },
      '../config': { SENTRY_DSN: 'https://public@example.invalid/1' },
      './rateLimitMonitoring': {
        shouldEmit: () => ({ emit: true, suppressedPriorWindow: 0 }),
      },
      'expo-application': {
        applicationId: 'com.captivet.test',
        nativeApplicationVersion: '0.0.0',
        nativeBuildVersion: '0',
      },
    },
    {
      performance: { now: () => now },
    },
  );
  monitoring.initMonitoring();
  return {
    monitoring,
    breadcrumbs,
    messages,
    appState,
    suspend() {
      for (const cb of appStateListeners) cb('background');
    },
    setNow(value) {
      now = value;
    },
  };
}

test('measurePhase suppresses the slow-phase warning when the app left active mid-measurement', async () => {
  const harness = await loadMonitoringHarness();
  await harness.monitoring.measurePhase('registerDevice', undefined, async () => {
    harness.suspend();
    harness.setNow(614_498);
  });

  const slow = harness.messages.filter((m) => m.message === 'slow_phase_registerDevice');
  assert.equal(slow.length, 0, 'suspended-window duration must not open a slow-phase issue');

  const crumb = harness.breadcrumbs.find((b) => b.message === 'phase_complete');
  assert.ok(crumb, 'phase_complete breadcrumb must survive suppression');
  assert.equal(crumb.data.duration_ms, 614_498, 'breadcrumb keeps the raw duration');
  assert.equal(crumb.data.app_suspended, 'true');
});

test('measurePhase still warns at the threshold when the app stayed active', async () => {
  const harness = await loadMonitoringHarness();
  await harness.monitoring.measurePhase(
    'fetchUser',
    undefined,
    async () => {
      harness.setNow(10_000);
    },
    { warningThresholdMs: 10_000 },
  );

  const slow = harness.messages.filter((m) => m.message === 'slow_phase_fetchUser');
  assert.equal(slow.length, 1, 'guard must not suppress genuine foreground latency');
});

test('measurePhase treats a non-active start state as suspended', async () => {
  const harness = await loadMonitoringHarness();
  harness.appState.currentState = 'background';
  await harness.monitoring.measurePhase('fetchUser', undefined, async () => {
    harness.setNow(60_000);
  });

  const slow = harness.messages.filter((m) => m.message === 'slow_phase_fetchUser');
  assert.equal(slow.length, 0);
});

test('measurePhase below threshold stays silent with the guard installed', async () => {
  const harness = await loadMonitoringHarness();
  await harness.monitoring.measurePhase(
    'fetchUser',
    undefined,
    async () => {
      harness.setNow(9_999);
    },
    { warningThresholdMs: 10_000 },
  );
  assert.equal(harness.messages.length, 0);
});

// ─── draftStorage: no_local_meta orphan surfacing ────────────────────

function makeSecureStore(state = new Map()) {
  const counters = { reads: 0, writes: 0, deletes: 0 };
  const mock = {
    AFTER_FIRST_UNLOCK: 'after_first_unlock',
    async getItemAsync(key) {
      counters.reads++;
      return state.has(key) ? state.get(key) : null;
    },
    async setItemAsync(key, value) {
      counters.writes++;
      state.set(key, value);
    },
    async deleteItemAsync(key) {
      counters.deletes++;
      state.delete(key);
    },
  };
  return { state, counters, mock };
}

async function loadTsModuleWithMocks(path, mocks) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const module = { exports: {} };
  const requireShim = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`module not mocked in test: ${id}`);
  };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireShim,
    Error,
    TypeError,
    RangeError,
    Promise,
    setTimeout,
    clearTimeout,
    console,
  });
  return module.exports;
}

async function loadDraftStorage(state) {
  const store = makeSecureStore(state);
  const captured = [];
  const mod = await loadTsModuleWithMocks('src/lib/draftStorage.ts', {
    'expo-secure-store': store.mock,
    'expo-file-system': {
      File: class {
        constructor(uri) {
          this.uri = uri;
        }
        copy() {}
        move() {}
      },
      Paths: {
        document: { uri: 'file:///doc/' },
        cache: { uri: 'file:///cache/' },
        availableDiskSpace: 1024 * 1024 * 1024,
      },
    },
    'expo-file-system/legacy': {
      async copyAsync() {},
      async moveAsync() {},
    },
    './fileOps': {
      fileExists: () => true,
      safeDeleteFile: () => {},
      safeDeleteDirectory: () => {},
      ensureDirectory: () => true,
    },
    './durableAudio/paths': {
      isValidDurableId: (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
    },
    './durableAudio/tombstone': {
      durableTombstone: { has: async () => false },
    },
    './pendingConfirm': {
      clonePendingConfirm: (value) => (value ? structuredClone(value) : null),
    },
    './uploadIntent': {
      normalizeUploadIntentId: (value, slotId) => value || `legacy:${slotId}`,
      normalizeUploadKeyOverride: (value) => value || null,
      normalizeSupersededUploadKey: (value) => value || null,
      isAudioChangeUploadIdempotencyKey: (value) =>
        typeof value === 'string' && value.startsWith('recording-upload-v3:audio-change:'),
      effectiveUploadIdempotencyKey: ({ uploadKeyOverride, durableRecordingId, uploadIntentId }) =>
        uploadKeyOverride ||
        (durableRecordingId
          ? `recording-upload-v1:durable:${durableRecordingId}`
          : `recording-upload-v1:slot:${uploadIntentId}`),
    },
    './pimsPatientIdIntent': {
      isPimsPatientIdExplicitlyCleared: (value, persistedIntent) =>
        persistedIntent === true || value === null,
    },
    './monitoring': {
      captureMessage: (message, level, context) => {
        captured.push({ message, level, context });
      },
      breadcrumb: () => {},
    },
    './analytics': {
      trackEvent: () => {},
    },
  });
  return { draftStorage: mod.draftStorage, captured, ...store };
}

function makeSlot(id) {
  return {
    id,
    formData: { patientName: 'redacted' },
    segments: [{ uri: `file:///rec/${id}-seg0.m4a`, duration: 5 }],
  };
}

test('updateServerDraftId returns updated on success and no_user without a bound user', async () => {
  const { draftStorage } = await loadDraftStorage();
  assert.equal(await draftStorage.updateServerDraftId('slot1', 'server-1'), 'no_user');

  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));
  assert.equal(await draftStorage.updateServerDraftId('slot1', 'server-1'), 'updated');
});

test('updateServerDraftId returns no_local_meta at info level when the draft vanished', async () => {
  const { draftStorage, captured } = await loadDraftStorage();
  draftStorage.setUserId('userA');

  const result = await draftStorage.updateServerDraftId('gone-slot', 'server-9');
  assert.equal(result, 'no_local_meta');
  const event = captured.find((c) => c.message === 'draft_update_server_id_no_local_meta');
  assert.ok(event, 'telemetry event must survive the level change');
  assert.equal(event.level, 'info', 'handled event must not reopen a warning-level issue');
});

test('updateServerDraftId refuses no_local_meta when storage is unreadable', async () => {
  const { draftStorage, mock, captured } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const originalGet = mock.getItemAsync;
  mock.getItemAsync = async () => {
    throw new Error('Keystore unavailable');
  };
  try {
    const result = await draftStorage.updateServerDraftId('slot1', 'server-1');
    assert.equal(
      result,
      'persist_failed',
      'unprovable absence must take the non-deleting path',
    );
  } finally {
    mock.getItemAsync = originalGet;
  }
  const event = captured.find((c) => c.message === 'draft_update_server_id_meta_unreadable');
  assert.ok(event, 'unreadable storage must surface its own event');
  assert.equal(
    captured.some((c) => c.message === 'draft_update_server_id_no_local_meta'),
    false,
  );
});

test('updateServerDraftId treats corrupt meta as unreadable, not absent', async () => {
  const { draftStorage, state } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  for (const key of [...state.keys()]) {
    if (key.includes('slot1')) state.set(key, '{not json');
  }

  const result = await draftStorage.updateServerDraftId('slot1', 'server-1');
  assert.equal(result, 'persist_failed', 'corrupt-but-present meta must not orphan-delete');
});

test('updateServerDraftId returns persist_failed when the write throws', async () => {
  const { draftStorage, mock } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const originalSet = mock.setItemAsync;
  mock.setItemAsync = async () => {
    throw new Error('SecureStore write failed');
  };
  try {
    assert.equal(await draftStorage.updateServerDraftId('slot1', 'server-1'), 'persist_failed');
  } finally {
    mock.setItemAsync = originalSet;
  }
});

test('syncPending surfaces the created server id as an orphan when local meta vanished', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const result = await draftStorage.syncPending('userA', async (draft) => {
    // Simulate the race: the user discards the draft while the server create
    // is in flight, so the anchor write finds no local metadata.
    await draftStorage.deleteDraft(draft.slotId);
    return { id: 'server-orphan-1' };
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.succeeded, 1);
  // Element-wise: the array crosses a vm realm, so deepEqual on the array
  // object itself fails on prototype identity.
  assert.equal(result.orphanedServerIds.length, 1);
  assert.equal(result.orphanedServerIds[0], 'server-orphan-1');
});

test('syncPending reports no orphans when the anchor persists', async () => {
  const { draftStorage } = await loadDraftStorage();
  draftStorage.setUserId('userA');
  await draftStorage.saveDraft(makeSlot('slot1'));

  const result = await draftStorage.syncPending('userA', async () => ({ id: 'server-ok-1' }));

  assert.equal(result.succeeded, 1);
  assert.equal(result.orphanedServerIds.length, 0);
});

// ─── source contracts: callers act on the surfaced results ───────────

test('usePendingDraftSync deletes surfaced orphans best-effort with orphan_draft_cleanup', async () => {
  const src = await read('src/hooks/usePendingDraftSync.ts');
  assert.match(src, /for \(const orphanId of result\.orphanedServerIds\)/);
  assert.match(
    src,
    /await recordingsApi\.deleteOrphanDraftIfUnclaimed\(orphanId\);/,
    'orphan cleanup must go through the status-preconditioned never-throwing helper',
  );
});

test('deleteOrphanDraftIfUnclaimed requires a still-draft server status and never throws', async () => {
  const src = await read('src/api/recordings.ts');
  const helper = src.slice(src.indexOf('async deleteOrphanDraftIfUnclaimed'));
  assert.ok(helper.length > 0, 'helper must exist on recordingsApi');
  const body = helper.slice(0, helper.indexOf('},'));
  // Status precondition: a row a concurrent submit claimed (shared
  // idempotency key) leaves 'draft' at confirm and must be skipped.
  assert.match(body, /this\.draftPresence\(\[id\]\)/);
  assert.match(body, /row\.status !== 'draft'/);
  assert.match(body, /return 'skipped'/);
  assert.match(body, /reason: 'orphan_draft_cleanup'/);
  assert.match(body, /catch\s*\{\s*\n\s*return 'failed'/);
});

test('record.tsx deletes the unanchored background create and never deletes mid-submit', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Background reconciliation create: delete on no_local_meta, guarded by
  // scope + submit-intent + durable checks.
  assert.match(src, /anchorResult === 'no_local_meta' &&/);
  assert.match(src, /createdFreshServerRow &&/);
  assert.match(src, /!submitIntentSlotIdsRef\.current\.has\(slotId\)/);
  assert.match(src, /!slot\.durable\?\.recordingId/);
  assert.match(src, /recordingsApi\.deleteOrphanDraftIfUnclaimed\(serverId!\)/);
  // Mid-submit anchor loss must breadcrumb, not delete.
  const midSubmit = src.match(/draft_anchor_missing_mid_submit/g) ?? [];
  assert.equal(midSubmit.length, 2, 'both submit-path call sites record the anomaly instead of deleting');
});

test('AuthProvider raises fetchUser and registerDevice thresholds to 10s', async () => {
  const src = await read('src/auth/AuthProvider.tsx');
  const registerBlock = src.slice(src.indexOf("measurePhase('registerDevice'"));
  assert.match(registerBlock.slice(0, 5000), /\{ warningThresholdMs: 10_000 \}/);
  const fetchBlock = src.slice(src.indexOf("measurePhase('fetchUser'"));
  assert.match(fetchBlock.slice(0, 8000), /\{ warningThresholdMs: 10_000 \}/);
});

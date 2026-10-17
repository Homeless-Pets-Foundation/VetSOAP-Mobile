// Request and upload latency exclude time the app spent in the background.
//
// Android suspends the JS thread while the app is backgrounded, but performance.now()
// and Date.now() keep counting. A request that was in flight when a vet switched apps
// reported the whole absence as latency — Sentry breadcrumbs from clinic tablets showed
// "slow" requests that Railway's [api-perf] log answered in 110-400 ms. The API client
// now reports foreground-only `latency_ms`, the token/device-id read time as `prep_ms`,
// and `app_suspended` so a suspended row can be filtered out rather than believed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

process.env.EXPO_PUBLIC_API_URL = 'https://api.captivet.com';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://shdzitupjltfyembqowp.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME = 'bucket.r2.cloudflarestorage.com';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

function fakeEnvironment(initialState = 'active') {
  let now = 0;
  const listeners = [];
  const appState = {
    currentState: initialState,
    addEventListener(_event, cb) {
      listeners.push(cb);
      return { remove() {} };
    },
  };
  return {
    appState,
    performance: { now: () => now },
    advance(ms) {
      now += ms;
    },
    emit(state) {
      appState.currentState = state;
      for (const cb of listeners) cb(state);
    },
  };
}

async function loadClock(env) {
  return loadTsModule(
    'src/lib/foregroundClock.ts',
    { 'react-native': { AppState: env.appState } },
    { performance: env.performance },
  );
}

test('a timer that stays in the foreground reports plain elapsed time', async () => {
  const env = fakeEnvironment();
  const clock = await loadClock(env);
  const timer = clock.startForegroundTimer();
  env.advance(480);
  assert.equal(timer.elapsedForegroundMs(), 480);
  assert.equal(timer.wasSuspended(), false);
});

test('time in the background is excluded and the timer reports the suspension', async () => {
  const env = fakeEnvironment();
  const clock = await loadClock(env);
  const timer = clock.startForegroundTimer();
  env.advance(100);
  env.emit('background');
  env.advance(41_000);
  env.emit('active');
  env.advance(200);

  assert.equal(timer.elapsedForegroundMs(), 300);
  assert.equal(timer.wasSuspended(), true);
});

test('an absence still in progress is excluded up to now', async () => {
  const env = fakeEnvironment();
  const clock = await loadClock(env);
  const timer = clock.startForegroundTimer();
  env.advance(100);
  env.emit('background');
  env.advance(800);
  assert.equal(timer.elapsedForegroundMs(), 100);
});

test('a timer started after a resume is unaffected by the earlier absence', async () => {
  const env = fakeEnvironment();
  const clock = await loadClock(env);
  clock.startForegroundTimer();
  env.emit('background');
  env.advance(5_000);
  env.emit('active');
  const timer = clock.startForegroundTimer();
  env.advance(250);

  assert.equal(timer.elapsedForegroundMs(), 250);
  assert.equal(timer.wasSuspended(), false);
});

test('a timer started in the background counts only from the resume', async () => {
  const env = fakeEnvironment('background');
  const clock = await loadClock(env);
  const timer = clock.startForegroundTimer();
  env.advance(1_000);
  env.emit('active');
  env.advance(200);

  assert.equal(timer.elapsedForegroundMs(), 200);
  assert.equal(timer.wasSuspended(), true);
});

// ─── API client ──────────────────────────────────────────────────────

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  };
}

async function loadClient({ env, onFetch, response, onDeviceIdRead }) {
  const breadcrumbs = [];
  const events = [];
  const noopModule = new Proxy({}, { get: () => () => {} });
  const mocks = {
    'expo-secure-store': {
      getItemAsync: async () => {
        onDeviceIdRead?.();
        return null;
      },
      setItemAsync: async () => {},
      deleteItemAsync: async () => {},
    },
    'react-native': {
      Platform: { OS: 'android' },
      AppState: env.appState,
      DeviceEventEmitter: { emit() {} },
    },
    'expo-constants': { default: { expoConfig: { extra: {} } } },
    '@sentry/react-native': noopModule,
    'posthog-react-native': noopModule,
    'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i + 1) },
    '../lib/monitoring': {
      breadcrumb: (category, message, data) => breadcrumbs.push({ category, message, data }),
    },
    '../lib/analytics': { trackEvent: (event) => events.push(event) },
  };
  const globals = {
    performance: env.performance,
    fetch: async () => {
      onFetch?.();
      return response;
    },
  };
  const mod = await loadTsModule('src/api/client.ts', mocks, globals);
  const client = new mod.ApiClient();
  client.setToken('token');
  return { client, breadcrumbs, events };
}

test('a request suspended in flight reports foreground latency and app_suspended', async () => {
  const env = fakeEnvironment();
  const { client, breadcrumbs, events } = await loadClient({
    env,
    response: jsonResponse(503, { error: 'Service temporarily unavailable' }),
    onFetch: () => {
      env.advance(150);
      env.emit('background');
      env.advance(60_000);
      env.emit('active');
      env.advance(50);
    },
  });

  await assert.rejects(() => client.request('/api/recordings', {}), (err) => err.status === 503);

  const failed = events.find((event) => event.name === 'api_request_failed');
  assert.ok(failed, 'api_request_failed was not emitted');
  assert.equal(failed.props.latency_ms, 200, 'the 60 s absence must not count as latency');
  assert.equal(failed.props.app_suspended, true);
  const crumb = breadcrumbs.find((b) => b.category === 'network');
  assert.ok(crumb, 'network breadcrumb was not emitted');
  assert.equal(crumb.data.latency_ms, 200);
  assert.equal(crumb.data.app_suspended, true);
});

test('storage reads before sending are reported as prep_ms, not network latency', async () => {
  const env = fakeEnvironment();
  const { client, breadcrumbs } = await loadClient({
    env,
    response: jsonResponse(200, { ok: true }),
    // A degraded Keystore: each SecureStore read takes a second before the send.
    onDeviceIdRead: () => env.advance(1_000),
    onFetch: () => env.advance(120),
  });

  await client.request('/api/recordings', {});

  const crumb = breadcrumbs.find((b) => b.category === 'network');
  assert.ok(crumb, 'network breadcrumb was not emitted');
  assert.ok(crumb.data.prep_ms >= 1_000, `prep_ms ${crumb.data.prep_ms} lost the storage read`);
  assert.equal(crumb.data.latency_ms, 120, 'storage time leaked into network latency');
  assert.equal(crumb.data.app_suspended, false);
});

test('upload latencies use the foreground timer, never wall time', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.doesNotMatch(record, /uploadStartedAt/);
  assert.match(record, /const uploadTimer = startForegroundTimer\(\);/);
  assert.equal(
    (record.match(/Math\.round\(uploadTimer\.elapsedForegroundMs\(\)\)/g) ?? []).length,
    4,
    'every upload latency must be foreground-only',
  );
  assert.equal(
    (record.match(/app_suspended: uploadTimer\.wasSuspended\(\),/g) ?? []).length,
    (record.match(/latency_ms: (latencyMs|durableLatencyMs),/g) ?? []).length,
    'every reported upload latency must say whether the app was suspended',
  );
});

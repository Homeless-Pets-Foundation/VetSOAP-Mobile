// A 401 whose refresh could not run or finish (Codex review on
// VetSOAP-Mobile#234).
//
// After a cold-start restore adopted the persisted session because GoTrue's
// startup stalled, every refresh queued behind that same stall: the request
// that hit a 401 waited in onUnauthorized for as long as the stall lasted.
// The auth layer now bounds the refresh and reports `'unresolved'` when GoTrue
// cannot answer (src/auth/sessionRefresh.ts). That is not proof the session is
// dead, so ApiClient fails the request as RETRYABLE (a RequestTimeoutError,
// which /auth/me and draft sync treat as transient by type) and never
// consults onSessionExpired, whose job is the sign-out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTs.mjs';

process.env.EXPO_PUBLIC_API_URL = 'https://api.captivet.com';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://shdzitupjltfyembqowp.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME = 'bucket.r2.cloudflarestorage.com';

const noopModule = new Proxy({}, { get: () => () => {} });

const mocks = {
  'expo-secure-store': {
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  },
  'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, DeviceEventEmitter: { emit() {} } },
  'expo-constants': { default: { expoConfig: { extra: {} } } },
  '@sentry/react-native': noopModule,
  'posthog-react-native': noopModule,
  'expo-crypto': { getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i + 1) },
};

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    clone() { return this; },
  };
}

async function loadClient(responses) {
  const calls = [];
  const globals = {
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
  const mod = await loadTsModule('src/api/client.ts', mocks, globals);
  return { mod, calls };
}

const UNAUTHORIZED = jsonResponse(401, { error: 'Unauthorized' });

test('an unresolved refresh fails the request as retryable and never reaches the sign-out', async () => {
  const { mod, calls } = await loadClient([UNAUTHORIZED]);
  const client = new mod.ApiClient();
  client.setToken('restored-token');
  let expired = 0;
  client.setOnUnauthorized(async () => 'unresolved');
  client.setOnSessionExpired(async () => {
    expired += 1;
  });

  await assert.rejects(
    () => client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }),
    (err) => {
      assert.equal(err.name, 'RequestTimeoutError', 'retryable, like our own request deadline');
      // Nothing here proves the session ended, so the vet is not told it did.
      assert.doesNotMatch(err.message, /expired|sign in/i);
      return true;
    },
  );
  assert.equal(expired, 0, 'onSessionExpired signs out; GoTrue not answering is no reason to');
  assert.equal(calls.length, 1, 'nothing to retry with: the token did not change');
});

test('a refresh that answered still routes a persistent 401 to the sign-out', async () => {
  // The other direction: only `'unresolved'` skips onSessionExpired.
  const { mod } = await loadClient([UNAUTHORIZED]);
  const client = new mod.ApiClient();
  client.setToken('dead-token');
  let expired = 0;
  client.setOnUnauthorized(async () => {});
  client.setOnSessionExpired(async () => {
    expired += 1;
  });

  await assert.rejects(
    () => client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }),
    (err) => err.status === 401 && err.name === 'ApiError',
  );
  assert.equal(expired, 1);
});

test('a token that changed during an unresolved refresh is still retried', async () => {
  // GoTrue's own late refresh can land while onUnauthorized gave up waiting.
  const { mod, calls } = await loadClient([UNAUTHORIZED, jsonResponse(200, { ok: true })]);
  const client = new mod.ApiClient();
  client.setToken('restored-token');
  client.setOnUnauthorized(async () => {
    client.setToken('token-after-late-refresh');
    return 'unresolved';
  });

  assert.deepEqual(
    await client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }),
    { ok: true },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].authorization, 'Bearer token-after-late-refresh');
});

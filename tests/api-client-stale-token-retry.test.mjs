// A 401 caused by a token refresh that landed WHILE the request was in flight.
//
// Shipped defect (Sentry REACT-NATIVE-1J, `recording_submit_failed:prepare:HTTP_401`):
// the tablet suspended for ~41h with requests in flight, resumed, and the
// AppState-resume refresh (rule 18) minted a new access token. Requests carrying
// the PRE-refresh token came back 401. `request()` then read `oldToken` AFTER the
// fetch had already returned — by which point `currentToken` was the NEW token —
// so `newToken !== oldToken` was false and no retry ever happened. `onUnauthorized`
// could not rescue it either: its "session too fresh (<10s)" guard is keyed on
// `sessionTimestampRef`, which the refresh had just reset, so it returned without
// refreshing, and `onSessionExpired` bailed on the same guard. The raw 401 reached
// `uploadSlot` and the vet's submit failed with a finished recording on the device.
//
// Fix: capture the token BEFORE the fetch and, on a 401, retry once if the
// in-memory token has changed since. The refresh already happened; the request
// just needs to be re-sent with its result.
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

/** Run one request against a scripted sequence of responses. */
async function runScenario({ responses, onFetch }) {
  const calls = [];
  const globals = {
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      onFetch?.(calls.length);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next;
    },
  };
  const mod = await loadTsModule('src/api/client.ts', mocks, globals);
  return { mod, calls };
}

test('a 401 is retried when the token changed while the request was in flight', async () => {
  const responses = [jsonResponse(401, { error: 'Unauthorized' }), jsonResponse(200, { ok: true })];
  let client;
  const { mod, calls } = await runScenario({
    responses,
    onFetch: (n) => {
      // A background refresh lands mid-flight, exactly as the resume path does.
      if (n === 1) client.setToken('token-after-refresh');
    },
  });
  client = new mod.ApiClient();
  client.setToken('token-before-refresh');

  const body = await client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} });

  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 2, 'the stale-token 401 must be retried exactly once');
  assert.equal(calls[0].authorization, 'Bearer token-before-refresh');
  assert.equal(calls[1].authorization, 'Bearer token-after-refresh', 'the retry must carry the refreshed token');
});

test('a 401 with an unchanged token is NOT retried on the stale-token path', async () => {
  // Guard the other direction: the refresh/sign-out flow still owns that case,
  // and a blind retry here would double every genuinely-unauthorized request.
  const responses = [jsonResponse(401, { error: 'Unauthorized' })];
  const { mod, calls } = await runScenario({ responses });
  const client = new mod.ApiClient();
  client.setToken('stable-token');

  await assert.rejects(
    () => client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }),
    (err) => err.status === 401,
  );
  assert.equal(calls.length, 1);
});

test('a 401 is NOT retried when the token changed because the USER changed', async () => {
  // The hazard the "did the token change?" check creates on a shared clinic
  // tablet. Vet A's upload is in flight on the 30s budget; A signs out
  // (AuthProvider handleSignOut -> apiClient.setToken(null)) and vet B signs in
  // (setToken(tokenB)). Supabase has revoked A's session, so A's request comes
  // back 401 — and a bare token-changed check is TRUE, so A's body and A's
  // Idempotency-Key would be re-sent as `Bearer tokenB`, filing A's recording
  // under B's identity. ApiClient has no user identity of its own, so the
  // sign-out itself is the signal: a cleared token ends the epoch.
  const responses = [jsonResponse(401, { error: 'Unauthorized' }), jsonResponse(200, { ok: true })];
  let client;
  const { mod, calls } = await runScenario({
    responses,
    onFetch: (n) => {
      if (n === 1) {
        client.setToken(null);      // A signs out
        client.setToken('token-user-b'); // B signs in
      }
    },
  });
  client = new mod.ApiClient();
  client.setToken('token-user-a');

  await assert.rejects(
    () => client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }),
    (err) => err.status === 401,
    'a user switch must surface the 401, never replay under the new user',
  );
  assert.equal(calls.length, 1, "A's request must not be re-sent with B's token");
});

test('the refresh retry still fires across a refresh that did not clear the token', async () => {
  // Guard the other direction: a plain TOKEN_REFRESHED never nulls the token,
  // so the epoch is unchanged and the stale-token retry must still run.
  const responses = [jsonResponse(401, { error: 'Unauthorized' }), jsonResponse(200, { ok: true })];
  let client;
  const { mod, calls } = await runScenario({
    responses,
    onFetch: (n) => { if (n === 1) client.setToken('token-after-refresh'); },
  });
  client = new mod.ApiClient();
  client.setToken('token-before-refresh');

  assert.deepEqual(await client.request('/api/recordings/prepare-upload', { method: 'POST', body: {} }), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].authorization, 'Bearer token-after-refresh');
});

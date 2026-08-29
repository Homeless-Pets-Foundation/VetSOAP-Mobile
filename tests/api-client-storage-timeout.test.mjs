// Rule 24 on the API request path: the pre-fetch SecureStore reads.
//
// Shipped defect: `doFetch` awaited the auth-token read and then
// `getDeviceIdWithProvenance()` BEFORE creating its AbortController and arming
// the 30s timer. The request budget therefore covered `fetch()` only. A device-id
// cache miss is up to FOUR sequential unbounded native calls
// (secureStorage.ts getItemAsync → setItemAsync → the accessibility-less retry →
// the rule-17 read-back), and secureStorage imports no timeout helper at all.
//
// So a Keystore that HANGS — post-OS-update rebuild, Direct Boot, low storage, or
// a screen-lock change (rule 3) — left `doFetch` never settling: no error thrown,
// no timeout fired, and the user parked on "Still Loading Account" forever. A
// throw was always survivable (secureStorage try/catches to a safe value per rule
// 3); only the hang had no defence, which is precisely what rule 24 exists for.
//
// Fail direction is deliberate: a storage TIMEOUT throws rather than dropping
// `X-Device-Id`. Omitting the header makes the server answer 401
// DEVICE_ID_REQUIRED and forces a sign-out — the same reasoning client.ts already
// applies when it sends an unpersisted id rather than no id at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

test('both pre-fetch storage reads in doFetch are bounded', async () => {
  const src = await read('src/api/client.ts');

  assert.match(src, /const API_STORAGE_READ_TIMEOUT_MS = 10_000;/);
  assert.match(src, /import \{ withPromiseTimeout \} from '\.\.\/lib\/promiseTimeout';/);

  // Neither read may call SecureStore directly on the request path any more.
  assert.doesNotMatch(
    src,
    /:\s*\(await secureStorage\.getToken\(\)\)/,
    'the cold-start token read is unbounded again',
  );
  assert.doesNotMatch(
    src,
    /=\s*await secureStorage\.getDeviceIdWithProvenance\(\);/,
    'the device-id read is unbounded again',
  );
  assert.match(src, /readStorageBounded\(\s*\(\) => secureStorage\.getToken\(\),/);
  assert.match(src, /readStorageBounded\(\s*\(\) => secureStorage\.getDeviceIdWithProvenance\(\),/);
});

test('a storage timeout FAILS CLOSED — X-Device-Id is never dropped', async () => {
  const src = await read('src/api/client.ts');
  // The bound must produce StorageUnavailableError, not a null that would slip
  // through the `deviceId ? {...} : {}` header spread as a silently absent header.
  assert.match(src, /\(\) => new StorageUnavailableError\(operation\)/);
  const errors = await read('src/api/apiErrors.ts');
  assert.match(errors, /export class StorageUnavailableError extends Error/);
  assert.match(src, /export \{\s*ApiError,\s*RequestTimeoutError,\s*StorageUnavailableError,\s*\} from '\.\/apiErrors';/);
});

test('a genuine absence still passes through — only a HANG is an error', async () => {
  // A device that has no id yet must keep its existing unpersisted-id behaviour;
  // conflating "absent" with "timed out" would break first-launch registration.
  const src = await read('src/api/apiErrors.ts');
  assert.match(src, /Only a TIMEOUT produces this/);
  const client = await read('src/api/client.ts');
  assert.match(client, /if \(id && persisted\) this\.cachedDeviceId = id;/);
});

test('the request deadline throws a TYPED error with the message unchanged', async () => {
  const src = await read('src/api/client.ts');
  assert.match(
    src,
    /throw new RequestTimeoutError\(`Request timeout after \$\{timeoutMs\}ms`, \{ cause: error \}\);/,
  );

  // The message is a second contract: uploadRetry matches it to auto-retry.
  const uploadRetry = await read('src/api/uploadRetry.ts');
  assert.match(uploadRetry, /\\btimeout\\b/, 'TRANSIENT_R2_ERROR_RE no longer matches the word timeout');
});

test('the bound is armed before the reads it protects', async () => {
  const src = await read('src/api/client.ts');
  const helper = src.indexOf('async function readStorageBounded');
  const doFetch = src.indexOf('private async doFetch(');
  const tokenRead = src.indexOf("readStorageBounded(\n          () => secureStorage.getToken(),");
  const deviceRead = src.indexOf('readStorageBounded(\n        () => secureStorage.getDeviceIdWithProvenance(),');
  const controller = src.indexOf('const controller = new AbortController();');

  assert.ok(helper > 0 && doFetch > 0 && deviceRead > 0 && controller > 0, 'doFetch shape changed');
  // Both storage reads still precede the controller — that ordering is inherent
  // (the headers are needed to build the request). What changed is that they are
  // now bounded, so preceding it is no longer unbounded exposure.
  assert.ok(deviceRead < controller, 'device-id read moved after the controller');
  assert.ok(tokenRead < deviceRead, 'header order changed unexpectedly');
});

test('AuthProvider bounds its own pre-controller storage reads', async () => {
  const src = await read('src/auth/AuthProvider.tsx');

  assert.match(src, /const AUTH_STORAGE_READ_TIMEOUT_MS = 10_000;/);
  assert.doesNotMatch(
    src,
    /const deviceId = await secureStorage\.getDeviceId\(\);/,
    'an unbounded device-id read is back on an auth path',
  );

  // registerDevice folds a hang into its existing "pending" branch.
  assert.match(src, /readStorageOrNull\(\s*\(\) => secureStorage\.getDeviceId\(\),\s*'register_device',/);
  assert.match(src, /setDeviceRegistrationPending\(true\);/);

  // mfaAuthRequest fails CLOSED: rule 25 forbids routing around device binding
  // on MFA bearer routes, so a hang must not silently omit the header.
  assert.match(src, /readStorageOrThrow\(\s*\(\) => secureStorage\.getDeviceId\(\),\s*'mfa_device_id',/);
});

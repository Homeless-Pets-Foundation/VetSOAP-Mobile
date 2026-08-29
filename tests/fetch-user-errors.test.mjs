// /auth/me retryability — the timeout branch that was missing.
//
// Production symptom: a `/auth/me` request that hit ApiClient's own 30s deadline
// threw a plain Error. `isRetryableFetchUserError` matched only TypeError and
// ApiError, so it returned false and the failure was treated as TERMINAL. Two
// things followed at AuthProvider.tsx:1149 — the [1000, 2000, 4000] backoff
// never ran, and the cached-profile fallback was skipped entirely.
//
// The user-visible cost: an offline vet saw "Can't reach Captivet" instead of
// their cached profile, losing access to their own un-uploaded drafts on the
// device. That defeats the stated purpose of src/lib/userProfileCache.ts. The
// comment directly above the skip already documented the intended contract as
// "network/timeout/5xx" — the code just never implemented the timeout half.
//
// Reproduced live on 2026-08-29: `Details: Request timeout after 30000ms`
// rendered verbatim on the error screen, which is also why the raw message must
// never reach user-facing copy.
//
// These branches are EXECUTED, not regex'd: the classifiers were extracted to
// src/auth/fetchUserErrors.ts precisely so they could be, since
// tests/helpers/loadTs.mjs resolves .ts only and AuthProvider is a .tsx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTs.mjs';

const load = () =>
  loadTsModule('src/auth/fetchUserErrors.ts', {
    'react-native': { Platform: { OS: 'android' } },
  });

test('a request timeout is RETRYABLE — the regression this file exists for', async () => {
  const { isRetryableFetchUserError } = await load();
  const { RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');
  assert.equal(
    isRetryableFetchUserError(new RequestTimeoutError('Request timeout after 30000ms')),
    true,
  );
});

test('a timeout is classified by TYPE, not by its message', async () => {
  // The message belongs to uploadRetry's TRANSIENT_R2_ERROR_RE. If classification
  // were message-based there would be two competing contracts on one string.
  const { isRetryableFetchUserError } = await load();
  assert.equal(
    isRetryableFetchUserError(new Error('Request timeout after 30000ms')),
    false,
    'a look-alike plain Error must NOT be promoted to retryable',
  );
});

test('a storage deadline is RETRYABLE — it must still reach the profile cache', async () => {
  // Regression guard (Codex P1 on PR #194): bounding the pre-fetch Keystore
  // reads introduced a NEW error type into the very path this module fixes. If
  // StorageUnavailableError is terminal, a hung Keystore skips the cached
  // profile and strands the vet exactly as the timeout used to.
  const { isRetryableFetchUserError, fetchUserErrorMessage } = await load();
  const { StorageUnavailableError } = await loadTsModule('src/api/apiErrors.ts');
  const err = new StorageUnavailableError('get_device_id');
  assert.equal(isRetryableFetchUserError(err), true);
  // And it must not be described as a network problem — the network is fine.
  assert.doesNotMatch(fetchUserErrorMessage(err), /internet|connection/i);
  assert.match(fetchUserErrorMessage(err), /storage/i);
});

test('network TypeErrors stay retryable', async () => {
  const { isRetryableFetchUserError } = await load();
  assert.equal(isRetryableFetchUserError(new TypeError('Network request failed')), true);
  assert.equal(isRetryableFetchUserError(new TypeError('something else')), false);
});

test('ApiError retryability is unchanged: 0 and 5xx only', async () => {
  const { isRetryableFetchUserError } = await load();
  const { ApiError } = await loadTsModule('src/api/apiErrors.ts');
  for (const status of [0, 500, 502, 503]) {
    assert.equal(isRetryableFetchUserError(new ApiError('x', status)), true, `status ${status}`);
  }
  // A terminal refusal must NOT render the app from cache — the account may
  // have had its role or org revoked.
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableFetchUserError(new ApiError('x', status)), false, `status ${status}`);
  }
});

test('unknown shapes are terminal', async () => {
  const { isRetryableFetchUserError } = await load();
  for (const v of [null, undefined, 'string', 42, {}, new Error('boom')]) {
    assert.equal(isRetryableFetchUserError(v), false);
  }
});

test('the raw timeout message never reaches the user', async () => {
  const { fetchUserErrorMessage } = await load();
  const { RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');
  const msg = fetchUserErrorMessage(new RequestTimeoutError('Request timeout after 30000ms'));
  assert.doesNotMatch(msg, /30000ms/, 'internal deadline leaked to the screen');
  assert.doesNotMatch(msg, /Request timeout/);
  assert.ok(msg.length > 0);
});

test('offline and server messages stay user-facing', async () => {
  const { fetchUserErrorMessage } = await load();
  const { ApiError } = await loadTsModule('src/api/apiErrors.ts');
  assert.match(fetchUserErrorMessage(new TypeError('Network request failed')), /internet/i);
  assert.equal(fetchUserErrorMessage(new ApiError('Server exploded', 500)), 'Server exploded');
  assert.match(fetchUserErrorMessage(new ApiError('', 503)), /HTTP 503/);
});

test('AuthProvider delegates rather than re-declaring the classifiers', async () => {
  const { readFile } = await import('node:fs/promises');
  const provider = await readFile(
    new URL('../src/auth/AuthProvider.tsx', import.meta.url),
    'utf8',
  );
  assert.match(provider, /from '\.\/fetchUserErrors'/);
  // A second local copy would drift from the tested one.
  assert.doesNotMatch(provider, /function isRetryableFetchUserError/);
  assert.doesNotMatch(provider, /function fetchUserErrorMessage/);
});

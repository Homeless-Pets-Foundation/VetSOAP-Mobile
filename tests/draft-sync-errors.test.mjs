import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTs.mjs';

test('background draft sync treats typed request timeouts and offline fetch failures as transport failures', async () => {
  const { isDraftSyncTransportError } = await loadTsModule('src/lib/draftSyncErrors.ts');
  const { RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');
  assert.equal(isDraftSyncTransportError(new RequestTimeoutError('deadline')), true);
  assert.equal(isDraftSyncTransportError(new TypeError('Network request failed')), true);
});

test('background draft sync retains diagnostics for unexpected, auth, and storage failures', async () => {
  const { isDraftSyncTransportError } = await loadTsModule('src/lib/draftSyncErrors.ts');
  const { ApiError, StorageUnavailableError } = await loadTsModule('src/api/apiErrors.ts');
  for (const error of [
    new Error('Request timeout after 30000ms'),
    new TypeError('Cannot read properties of undefined'),
    new ApiError('Unauthorized', 401),
    new ApiError('Bad gateway', 502),
    new StorageUnavailableError('get_device_id'),
    null,
  ]) assert.equal(isDraftSyncTransportError(error), false);
});

test('a server 409 is classified as a conflict, not a generic sync failure', async () => {
  // Sentry REACT-NATIVE-1Z: `POST /api/recordings` answered 409 and the catch
  // reported it as `captureException(phase: 'sync_server_draft')` carrying the
  // generic 'Something went wrong. Please try again.' — a message that says
  // nothing and a classification that is backwards, since a conflict PROVES the
  // server already has the row.
  const { isDraftSyncConflictError, isDraftSyncTransportError } = await loadTsModule(
    'src/lib/draftSyncErrors.ts',
  );
  const { ApiError, RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');

  const conflict = new ApiError('conflict', 409, false, undefined, 'IDEMPOTENCY_KEY_MISMATCH');
  assert.equal(isDraftSyncConflictError(conflict), true);
  // Untyped 409s count too — the server documents four conflict codes and the
  // client classifies none of them on the create path.
  assert.equal(isDraftSyncConflictError(new ApiError('conflict', 409)), true);

  // The two branches must stay disjoint: a conflict is not retryable transport.
  assert.equal(isDraftSyncTransportError(conflict), false);
  assert.equal(isDraftSyncConflictError(new RequestTimeoutError('deadline')), false);
  for (const other of [new ApiError('nope', 401), new ApiError('boom', 500), new Error('409'), null]) {
    assert.equal(isDraftSyncConflictError(other), false);
  }
});

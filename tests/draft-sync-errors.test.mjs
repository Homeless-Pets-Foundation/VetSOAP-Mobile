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

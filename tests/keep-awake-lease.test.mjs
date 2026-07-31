import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

test('late keep-awake activation triggers a second handled deactivation', async () => {
  const { acquireKeepAwakeLease } = await loadTsModule(
    'src/lib/keepAwakeLease.ts',
  );
  let resolveActivation;
  const deactivations = [];
  const lease = acquireKeepAwakeLease(
    'upload-tag',
    () =>
      new Promise((resolve) => {
        resolveActivation = resolve;
      }),
    async (tag) => {
      deactivations.push(tag);
    },
  );
  lease.release();
  assert.deepEqual(deactivations, ['upload-tag']);
  resolveActivation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(deactivations, ['upload-tag', 'upload-tag']);
});

test('synchronous activation/deactivation throws remain best effort', async () => {
  const { acquireKeepAwakeLease } = await loadTsModule(
    'src/lib/keepAwakeLease.ts',
  );
  assert.doesNotThrow(() => {
    const lease = acquireKeepAwakeLease(
      'upload-tag',
      () => {
        throw new Error('activation bridge threw');
      },
      () => {
        throw new Error('deactivation bridge threw');
      },
    );
    lease.release();
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const { withPromiseTimeout } = await loadTsModule(
  'src/lib/promiseTimeout.ts'
);

test('withPromiseTimeout returns a source value before the deadline', async () => {
  assert.equal(
    await withPromiseTimeout(Promise.resolve(42), 50, 'should not time out'),
    42
  );
});

test('withPromiseTimeout preserves a source rejection', async () => {
  const expected = new Error('native seek failed');

  await assert.rejects(
    withPromiseTimeout(Promise.reject(expected), 50, 'should not time out'),
    (error) => error === expected
  );
});

test('withPromiseTimeout rejects a hanging native operation at its deadline', async () => {
  const startedAt = Date.now();

  await assert.rejects(
    withPromiseTimeout(new Promise(() => {}), 15, 'Audio seek timed out'),
    /Audio seek timed out/
  );
  assert.ok(Date.now() - startedAt < 1_000, 'timeout should release the UI gate promptly');
});

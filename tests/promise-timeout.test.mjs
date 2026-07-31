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

test('withPromiseTimeout returns a supplied timeout error by identity', async () => {
  const expected = Object.assign(new Error('typed timeout'), {
    code: 'TYPED_TIMEOUT',
  });
  await assert.rejects(
    withPromiseTimeout(
      new Promise(() => {}),
      5,
      'fallback message',
      expected,
    ),
    (error) => error === expected && error.code === 'TYPED_TIMEOUT',
  );
});

test('withPromiseTimeout contains a throwing timeout-error factory', async () => {
  await assert.rejects(
    withPromiseTimeout(
      new Promise(() => {}),
      5,
      'must not escape timer',
      () => {
        throw new Error('factory escaped');
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message === 'The operation timed out.',
  );
});

test('late resolve cannot resettle a timed-out public Promise', async () => {
  let resolveSource;
  const source = new Promise((resolve) => {
    resolveSource = resolve;
  });
  const publicPromise = withPromiseTimeout(source, 5, 'deadline');
  await assert.rejects(publicPromise, /deadline/);
  resolveSource('too late');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(publicPromise, /deadline/);
});

test('late rejection stays observed after the public timeout', async () => {
  let rejectSource;
  const source = new Promise((_, reject) => {
    rejectSource = reject;
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const publicPromise = withPromiseTimeout(source, 5, 'deadline');
    await assert.rejects(publicPromise, /deadline/);
    rejectSource(new Error('late native rejection'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

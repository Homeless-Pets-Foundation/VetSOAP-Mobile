import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

test('native preflight timeout fields and fixed mode copy are exact and clamped', async () => {
  const mod = await loadTsModule('src/lib/nativePreflight.ts');
  const error = new mod.NativePreflightTimeoutError(
    'api_metadata',
    'durable',
    99.8,
  );
  assert.equal(error.name, 'NativePreflightTimeoutError');
  assert.equal(error.code, 'NATIVE_PREFLIGHT_TIMEOUT');
  assert.equal(error.uploadPhase, 'preflight');
  assert.equal(error.operation, 'api_metadata');
  assert.equal(error.mode, 'durable');
  assert.equal(error.fileCount, 20);
  assert.equal(
    error.message,
    "Captivet couldn't read the saved recording in time. Your audio is still saved. Fully close and reopen Captivet, then try again.",
  );
  assert.equal(mod.isNativePreflightTimeout(error), true);
  assert.equal(
    mod.isNativePreflightTimeout({
      code: 'NATIVE_PREFLIGHT_TIMEOUT',
      operation: 'arbitrary-path-value',
      mode: 'durable',
      fileCount: 1,
    }),
    false,
  );
  assert.equal(
    mod.isNativePreflightTimeout({
      code: 'NATIVE_PREFLIGHT_TIMEOUT',
      operation: 'api_metadata',
      mode: 'server-injected-mode',
      fileCount: 1,
    }),
    false,
  );
  assert.equal(
    mod.isNativePreflightTimeout({
      code: 'NATIVE_PREFLIGHT_TIMEOUT',
      operation: 'api_metadata',
      mode: 'standard',
      fileCount: 1.5,
    }),
    false,
  );
});

test('native preflight preserves source rejection and synchronous factory throw', async () => {
  const { createNativePreflightBatch } = await loadTsModule(
    'src/lib/nativePreflight.ts',
  );
  const rejection = new Error('native rejected');
  const batch = createNativePreflightBatch('standard', 1, {
    timeoutMs: 100,
  });
  await assert.rejects(
    batch.read('segment_metadata', () => Promise.reject(rejection)),
    (error) => error === rejection,
  );

  const synchronous = new Error('native threw synchronously');
  await assert.rejects(
    batch.read('segment_metadata', () => {
      throw synchronous;
    }),
    (error) => error === synchronous,
  );
});

test('source settling just before the absolute deadline succeeds', async () => {
  let clock = 0;
  const { createNativePreflightBatch } = await loadTsModule(
    'src/lib/nativePreflight.ts',
  );
  const batch = createNativePreflightBatch('standard', 1, {
    timeoutMs: 1_000,
    now: () => clock,
  });
  const result = await batch.read('segment_metadata', async () => {
    clock = 999;
    return 42;
  });
  assert.equal(result, 42);
});

test('one multi-file batch shares one budget and does not start an expired read', async () => {
  let clock = 0;
  let calls = 0;
  const { createNativePreflightBatch } = await loadTsModule(
    'src/lib/nativePreflight.ts',
  );
  const batch = createNativePreflightBatch('standard', 20, {
    timeoutMs: 1_000,
    now: () => clock,
  });
  assert.equal(
    await batch.read('segment_metadata', async () => {
      calls += 1;
      clock = 600;
      return 'first';
    }),
    'first',
  );
  clock = 1_000;
  await assert.rejects(
    batch.read('segment_metadata', async () => {
      calls += 1;
      return 'must not run';
    }),
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.fileCount === 20,
  );
  assert.equal(calls, 1);
});

test('wall-clock deadline wins when timer delivery is paused', async () => {
  let clock = 0;
  let resolveSource;
  const neverDeliverTimer = () => 1;
  const { createNativePreflightBatch } = await loadTsModule(
    'src/lib/nativePreflight.ts',
    {},
    {
      setTimeout: neverDeliverTimer,
      clearTimeout: () => {},
    },
  );
  const batch = createNativePreflightBatch('durable', 1, {
    timeoutMs: 10,
    now: () => clock,
  });
  const pending = batch.read(
    'source_metadata',
    () =>
      new Promise((resolve) => {
        resolveSource = resolve;
      }),
  );
  clock = 11;
  resolveSource('late');
  await assert.rejects(
    pending,
    (error) =>
      error?.code === 'NATIVE_PREFLIGHT_TIMEOUT' &&
      error.operation === 'source_metadata',
  );
});

test('development failpoint is off in production and consumes once in development', async () => {
  const production = await loadTsModule('src/lib/nativePreflight.ts');
  assert.equal(production.getArmedNativePreflightHang(), null);
  assert.equal(production.armNativePreflightHang('api_metadata'), false);
  assert.equal(
    await production
      .createNativePreflightBatch('standard', 1, { timeoutMs: 20, now: () => 0 })
      .read('api_metadata', async () => 'normal'),
    'normal',
  );

  const development = await loadTsModule(
    'src/lib/nativePreflight.ts',
    {},
    { __DEV__: true },
  );
  let factoryCalls = 0;
  assert.equal(development.armNativePreflightHang('api_metadata'), true);
  assert.equal(development.getArmedNativePreflightHang(), 'api_metadata');
  await assert.rejects(
    development
      .createNativePreflightBatch('standard', 1, { timeoutMs: 5, now: () => 0 })
      .read('api_metadata', async () => {
        factoryCalls += 1;
        return 'not reached';
      }),
    (error) => error?.code === 'NATIVE_PREFLIGHT_TIMEOUT',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(development.getArmedNativePreflightHang(), null);
  assert.equal(
    await development
      .createNativePreflightBatch('standard', 1, { timeoutMs: 20, now: () => 0 })
      .read('api_metadata', async () => 'second read'),
    'second read',
  );

  const restarted = await loadTsModule(
    'src/lib/nativePreflight.ts',
    {},
    { __DEV__: true },
  );
  assert.equal(restarted.getArmedNativePreflightHang(), null);
});

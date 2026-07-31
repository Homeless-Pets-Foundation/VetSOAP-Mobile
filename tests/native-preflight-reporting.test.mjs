import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

test('native timeout reporting emits one closed warning with only safe tags', async () => {
  const preflight = await loadTsModule('src/lib/nativePreflight.ts');
  const reporting = await loadTsModule(
    'src/lib/nativePreflightReporting.ts',
  );
  const calls = [];
  const error = new preflight.NativePreflightTimeoutError(
    'api_metadata',
    'durable',
    3,
  );
  const result = reporting.presentNativePreflightTimeout(
    error,
    (...args) => calls.push(args),
  );
  assert.equal(
    result.copy,
    "Captivet couldn't read the saved recording in time. Your audio is still saved. Fully close and reopen Captivet, then try again.",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      'NATIVE_PREFLIGHT_TIMEOUT:api_metadata:durable',
      'warning',
      {
        tags: {
          operation: 'api_metadata',
          mode: 'durable',
          file_count: '3',
        },
      },
    ],
  ]);
  assert.deepEqual(Object.keys(calls[0][2].tags).sort(), [
    'file_count',
    'mode',
    'operation',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /recording|patient|client|file:\/\//i);
});

test('invalid lookalike errors are ignored and monitoring throws are contained', async () => {
  const reporting = await loadTsModule(
    'src/lib/nativePreflightReporting.ts',
  );
  let captures = 0;
  assert.equal(
    reporting.presentNativePreflightTimeout(
      {
        code: 'NATIVE_PREFLIGHT_TIMEOUT',
        operation: 'file:///private/patient.aac',
        mode: 'durable',
        fileCount: 1,
      },
      () => {
        captures += 1;
      },
    ),
    null,
  );
  assert.equal(captures, 0);

  const valid = {
    code: 'NATIVE_PREFLIGHT_TIMEOUT',
    operation: 'source_metadata',
    mode: 'standard',
    fileCount: 1,
  };
  assert.doesNotThrow(() =>
    reporting.presentNativePreflightTimeout(valid, () => {
      throw new Error('monitoring SDK failed');
    }),
  );
});

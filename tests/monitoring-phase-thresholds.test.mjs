import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

async function loadMonitoringHarness() {
  let now = 0;
  const breadcrumbs = [];
  const messages = [];
  const sentry = {
    init() {},
    setTag() {},
    addBreadcrumb(value) {
      breadcrumbs.push(value);
    },
    captureMessage(message, context) {
      messages.push({ message, context });
    },
    breadcrumbsIntegration: () => ({ name: 'Breadcrumbs' }),
  };
  const monitoring = await loadTsModule(
    'src/lib/monitoring.ts',
    {
      '@sentry/react-native': sentry,
      'react-native': {
        DeviceEventEmitter: { addListener() {} },
        Platform: { OS: 'android' },
      },
      'expo-constants': {
        __esModule: true,
        default: { expoConfig: { version: 'test' } },
      },
      '../config': { SENTRY_DSN: 'https://public@example.invalid/1' },
      './rateLimitMonitoring': {
        shouldEmit: () => ({ emit: true, suppressedPriorWindow: 0 }),
      },
      'expo-application': {
        applicationId: 'com.captivet.test',
        nativeApplicationVersion: '0.0.0',
        nativeBuildVersion: '0',
      },
    },
    {
      performance: { now: () => now },
    },
  );
  monitoring.initMonitoring();
  return {
    monitoring,
    breadcrumbs,
    messages,
    setNow(value) {
      now = value;
    },
  };
}

test('measurePhase uses the default five-second warning and always breadcrumbs', async () => {
  const harness = await loadMonitoringHarness();
  harness.monitoring.measurePhase('default_phase', undefined, () => {
    harness.setNow(5_000);
  });
  assert.equal(harness.breadcrumbs.length, 1);
  assert.equal(harness.breadcrumbs[0].message, 'phase_complete');
  assert.equal(harness.breadcrumbs[0].data.outcome, 'success');
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].context.extra.warning_threshold_ms, 5_000);
});

test('measurePhase honors a ten-second threshold without an early duplicate warning', async () => {
  const harness = await loadMonitoringHarness();
  harness.monitoring.measurePhase(
    'ten_second_phase',
    undefined,
    () => {
      harness.setNow(9_999);
    },
    { warningThresholdMs: 10_000 },
  );
  assert.equal(harness.breadcrumbs.length, 1);
  assert.equal(harness.messages.length, 0);

  harness.setNow(20_000);
  harness.monitoring.measurePhase(
    'ten_second_phase',
    undefined,
    () => {
      harness.setNow(30_000);
    },
    { warningThresholdMs: 10_000 },
  );
  assert.equal(harness.breadcrumbs.length, 2);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].context.extra.warning_threshold_ms, 10_000);
});

test('measurePhase null threshold remains breadcrumb-only for success and error', async () => {
  const harness = await loadMonitoringHarness();
  harness.monitoring.measurePhase(
    'breadcrumb_only_success',
    undefined,
    () => {
      harness.setNow(20_000);
    },
    { warningThresholdMs: null },
  );
  assert.throws(() =>
    harness.monitoring.measurePhase(
      'breadcrumb_only_error',
      undefined,
      () => {
        harness.setNow(40_000);
        throw new Error('synthetic');
      },
      { warningThresholdMs: null },
    ),
  );
  assert.equal(harness.messages.length, 0);
  assert.deepEqual(
    harness.breadcrumbs.map((entry) => entry.data.outcome),
    ['success', 'error'],
  );
});

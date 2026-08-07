import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('dedupeMergedBreadcrumbs collapses the Android native/JS duplicate of each breadcrumb', async () => {
  const harness = await loadMonitoringHarness();
  const { dedupeMergedBreadcrumbs } = harness.monitoring;

  // Shape observed in production Android events: the DeviceContext integration
  // concatenates the native scope's mirrored copies onto the JS breadcrumbs and
  // sorts by timestamp, so each entry appears twice a few milliseconds apart
  // with an identical payload (same request_id, same latency).
  const merged = [
    { timestamp: 100.0, category: 'network', message: 'GET /api/recordings', data: { request_id: 'abc', latency_ms: 15375, status: 200 } },
    { timestamp: 100.054, category: 'network', message: 'GET /api/recordings', data: { status: 200, request_id: 'abc', latency_ms: 15375 } },
    { timestamp: 101.0, category: 'performance', message: 'phase_complete', data: { phase: 'fetchUser', duration_ms: 16735 } },
    { timestamp: 101.002, category: 'performance', message: 'phase_complete', data: { duration_ms: 16735, phase: 'fetchUser' } },
  ];

  const deduped = dedupeMergedBreadcrumbs(merged);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].data.request_id, 'abc');
  assert.equal(deduped[1].data.phase, 'fetchUser');
  // The FIRST copy is the one kept, so ordering and timestamps stay truthful.
  assert.equal(deduped[0].timestamp, 100.0);
  assert.equal(deduped[1].timestamp, 101.0);
});

test('dedupeMergedBreadcrumbs keeps genuine repeats and distinct payloads', async () => {
  const harness = await loadMonitoringHarness();
  const { dedupeMergedBreadcrumbs } = harness.monitoring;

  // Same endpoint, different request ids -> two real requests, both kept.
  const distinctPayloads = dedupeMergedBreadcrumbs([
    { timestamp: 10, category: 'network', message: 'GET /api/recordings', data: { request_id: 'one' } },
    { timestamp: 10.01, category: 'network', message: 'GET /api/recordings', data: { request_id: 'two' } },
  ]);
  assert.equal(distinctPayloads.length, 2);

  // Byte-identical but well outside the merge window -> a genuine repeat.
  const spacedRepeat = dedupeMergedBreadcrumbs([
    { timestamp: 10, category: 'record', message: 'record_started', data: { slot: '1' } },
    { timestamp: 40, category: 'record', message: 'record_started', data: { slot: '1' } },
  ]);
  assert.equal(spacedRepeat.length, 2);

  // Degenerate inputs pass straight through.
  assert.equal(dedupeMergedBreadcrumbs(undefined), undefined);
  assert.deepEqual(dedupeMergedBreadcrumbs([]), []);
});

test('beforeSend runs the breadcrumb dedupe last, after the native merge', async () => {
  const source = await readFile(
    new URL('../src/lib/monitoring.ts', import.meta.url),
    'utf8',
  );
  const beforeSend = source.slice(source.indexOf('beforeSend(event)'));
  const dedupeAt = beforeSend.indexOf('dedupeMergedBreadcrumbs(event.breadcrumbs)');
  const returnAt = beforeSend.indexOf('return event;');
  assert.ok(dedupeAt > 0 && dedupeAt < returnAt, 'dedupe must run before the event is returned');
});

/**
 * Guards the OS-process-kill detector.
 *
 * An Android LMK / battery-optimizer / app-sleep kill raises no JS exception and
 * no native signal, so Sentry records nothing — production had ZERO unhandled
 * errors across 90 days while users were losing audio. The launch-time capture
 * pointer is the only evidence such a kill happened, and on the expo fallback
 * (MediaRecorder writes the MP4 moov atom only on stop()) it is also the only
 * evidence the lost recording ever existed.
 *
 * These fences exist because every piece of this was built once before and left
 * unwired: wasRecordingAtLastExit() shipped with zero callers and
 * durable_process_recovered was declared and never emitted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function makeSecureStoreMock() {
  const store = new Map();
  return {
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    async getItemAsync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
    __store: store,
  };
}

async function loadActiveStore() {
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': makeSecureStoreMock(),
  });
  return mod.durableActiveStore;
}

// ---------------------------------------------------------------- activeStore

test('setActive records the capture backend', async () => {
  const s = await loadActiveStore();
  s.setUserId('user1');
  await s.setActive('rec1', 'slot-1', '2026-09-04T10:00:00.000Z', 'expo');
  await s.setActive('rec2', 'slot-2', '2026-09-04T10:01:00.000Z');
  const list = await s.list();
  assert.equal(list.find((e) => e.recordingId === 'rec1').backend, 'expo');
  assert.equal(list.find((e) => e.recordingId === 'rec2').backend, 'durable');
});

test('capturesAtLastExit splits durable from expo', async () => {
  const s = await loadActiveStore();
  s.setUserId('user1');
  await s.setActive('rec1', 'slot-1', '2026-09-04T10:00:00.000Z', 'expo');
  await s.setActive('rec2', 'slot-2', '2026-09-04T10:00:00.000Z', 'expo');
  await s.setActive('rec3', 'slot-3', '2026-09-04T10:00:00.000Z', 'durable');
  const counts = await s.capturesAtLastExit();
  assert.equal(counts.durable, 1);
  assert.equal(counts.expo, 2);
});

test('an entry persisted before the backend field counts as durable, not expo', async () => {
  // Back-compat: pre-upgrade installs have entries with no `backend` key. They
  // were all durable. Reading them as expo would overstate unrecoverable loss.
  const secure = makeSecureStoreMock();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': secure,
  });
  const s = mod.durableActiveStore;
  s.setUserId('user1');
  await s.setActive('seed', 'slot-seed', '2026-09-04T10:00:00.000Z', 'durable');
  // Rewrite the persisted payload as a legacy entry (no `backend`).
  for (const [k, v] of secure.__store) {
    if (typeof v === 'string' && v.includes('seed')) {
      secure.__store.set(k, v.replace(/,"backend":"durable"/, ''));
    }
  }
  const list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].backend, undefined, 'fixture must actually drop the field');
  const counts = await s.capturesAtLastExit();
  assert.equal(counts.durable, 1);
  assert.equal(counts.expo, 0);
});

test('capturesAtLastExit reports zero rather than throwing when storage fails', async () => {
  // A Keystore failure must not manufacture a false kill report.
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync() { throw new Error('keystore unavailable'); },
      async setItemAsync() { throw new Error('keystore unavailable'); },
      async deleteItemAsync() { throw new Error('keystore unavailable'); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('user1');
  const counts = await s.capturesAtLastExit();
  assert.equal(counts.durable, 0);
  assert.equal(counts.expo, 0);
});

// ------------------------------------------------------------ durableRecovery

test('the kill probe is actually wired into the launch scan', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /async function reportPriorProcessKill/);
  // Must run on BOTH early returns: the expo fallback leaves no manifest at all,
  // which is precisely the unrecoverable case.
  const calls = src.match(/await reportPriorProcessKill\(/g) ?? [];
  assert.ok(calls.length >= 3, `expected >=3 call sites, found ${calls.length}`);
  assert.match(src, /trackEvent\(\{\s*name: 'process_killed_mid_capture'/);
  assert.match(src, /captureMessage\('process_killed_mid_capture'/);
});

test('the probe only counts pointers older than this process', () => {
  // The scan re-runs on sign-in. Without this guard, recording and then signing
  // in inside one session would report the LIVE capture as a kill.
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /const PROCESS_START_ISO = new Date\(\)\.toISOString\(\)/);
  assert.match(src, /e\.startedAt < PROCESS_START_ISO/);
  assert.match(src, /let killSignalReported = false/);
});

test('reported pointers are cleared so the same kill is not re-reported forever', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  const probe = src.slice(src.indexOf('async function reportPriorProcessKill'));
  assert.match(probe.slice(0, probe.indexOf('\n}\n')), /durableActiveStore\.clearActive\(e\.recordingId\)/);
});

test('the kill report carries counts only — no ids, slots or paths', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  const start = src.indexOf('async function reportPriorProcessKill');
  const probe = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(probe, /recordingId:|slotId:|slot_id|recording_id|uri/i);
});

// -------------------------------------------------------------------- record

test('the expo fallback writes and clears the capture pointer', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  // COMMITTED before the mic opens — unlike the durable branch, which may
  // overlap native start because a manifest can rebuild the recording anyway.
  // An expo .m4a killed before stop() has no moov atom, so this pointer is the
  // only evidence the capture existed.
  assert.match(
    src,
    /await racePreStartPointerWrite\(\s*durableActiveStore\.setActive\(slotId, slotId, new Date\(\)\.toISOString\(\), 'expo'\)/,
  );
  // Cleared on a clean capture, else every launch reports a phantom kill.
  assert.match(src, /durableActiveStore\.clearActive\(slotId\)\.catch/);
  assert.match(src, /durableActiveStore\.clearActive\(boundSlotId\)\.catch/);
});

// ---------------------------------------------------------------- monitoring

test('the Sentry config no longer claims Android ANR coverage', () => {
  // enableAppHangTracking and enableWatchdogTerminationTracking are iOS-only.
  // The old comment asserted Android coverage that does not exist, which is why
  // nobody looked for a separate kill detector.
  const src = read('src/lib/monitoring.ts');
  assert.doesNotMatch(
    src,
    /Android ANR detection is enabled through the native\s*\/\/\s*SDK's default integrations/,
  );
  assert.match(src, /iOS ONLY/);
  assert.match(src, /process_killed_mid_capture/);
});

test('process_killed_mid_capture is declared in the analytics union', () => {
  const src = read('src/lib/analytics.ts');
  assert.match(src, /name: 'process_killed_mid_capture'/);
  assert.match(src, /durable_count: number; expo_count: number; recovered_count: number/);
});

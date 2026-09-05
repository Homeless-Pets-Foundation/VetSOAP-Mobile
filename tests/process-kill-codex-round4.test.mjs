/**
 * Codex review round 4 on PR #204.
 *
 * Three of the four are about the detector or its prompt being WRONG rather than
 * absent: attributing one vet's lost recording to another, claiming an exemption
 * that was never granted, and interrupting a live capture with the very dialog
 * that sends the app to system settings. The fourth is a rule-24 hang I
 * introduced with the serialized sweep queue.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

// ---- F1: kill reporting stays scoped to the scanned user ------------------

test('kill reporting dedupes per USER, not per process', async () => {
  // Shared clinic tablet: vet A signs in and their kill is reported; vet B then
  // signs in. A process-global flag silently suppressed B for the rest of the
  // session — on exactly the fleet this detector exists for.
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /const uncleanExitReportedUsers = new Set<string>\(\)/);
  assert.match(src, /uncleanExitReportedUsers\.has\(userId\)/);
  assert.match(src, /uncleanExitReportedUsers\.add\(userId\)/);
  assert.doesNotMatch(src, /let killSignalReported = false/);
  // The read-back used for the prompt copy is user-scoped too, or vet B is told
  // "Android stopped Captivet during your last recording" about vet A's kill.
  assert.match(src, /export function priorUncleanExitDetected\(userId: string \| null \| undefined\)/);
  assert.match(src, /uncleanExitReportedUsers\.has\(userId\)/);
  assert.match(
    read('app/(app)/(tabs)/record.tsx'),
    /maybePromptBatteryOptimization\(\s*priorUncleanExitDetected\(promptUserId\),/,
  );
});

test('the probe re-verifies scope after its await and before every clear', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  const start = src.indexOf('async function reportPriorUncleanExit');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const listAwait = body.indexOf('await durableActiveStore.list()');
  const recheck = body.indexOf('durableActiveStore.getUserId() !== userId');
  assert.ok(listAwait > 0 && recheck > listAwait, 'must re-verify AFTER the read');
  // And again inside the destructive loop — a sign-out mid-loop must not delete
  // the next user's pointers.
  const loop = body.slice(body.indexOf('for (const e of stale) {'));
  assert.match(loop, /durableActiveStore\.getUserId\(\) !== userId/);
  assert.match(loop, /isCancelled\(\)/);
});

test('activeStore exposes its current scope for that re-verification', async () => {
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  assert.equal(s.getUserId(), null);
  s.setUserId('userA');
  assert.equal(s.getUserId(), 'userA');
  s.setUserId('userB');
  assert.equal(s.getUserId(), 'userB');
});

// ---- F2: the serialized queue must always advance -------------------------

test('each serialized sweep is bounded so a hung Keystore cannot strand the queue', () => {
  const src = read(RECORD);
  const idx = src.indexOf('startupSweepTail = startupSweepTail');
  const chain = src.slice(idx, idx + 1500);
  assert.match(chain, /withPromiseTimeout\(/);
  assert.match(chain, /STARTUP_SWEEP_TIMEOUT_MS/);
  const bound = /const STARTUP_SWEEP_TIMEOUT_MS = ([\d_]+);/.exec(src);
  assert.ok(bound, 'no per-job ceiling');
  // Generous (these legitimately walk every draft over the Keystore) but finite.
  assert.ok(Number(bound[1].replace(/_/g, '')) <= 120_000);
});

// ---- F3: never report an exemption we did not observe ---------------------

test('opening Settings is not recorded as an exemption grant', () => {
  const src = read('src/lib/batteryOptimization.ts');
  // `opened` only means Android accepted the intent; the user can press Back
  // immediately and nothing reads the exemption state back.
  assert.match(src, /trackEvent\(\{ name: 'battery_opt_settings_opened', props: \{ opened \} \}\)/);
  assert.doesNotMatch(src, /name: 'durable_battery_opt_exemption'/);
  assert.match(read('src/lib/analytics.ts'), /name: 'battery_opt_settings_opened'; props: \{ opened: boolean \}/);
});

// ---- F4: never interrupt a live capture -----------------------------------

test('the battery prompt defers while a recorder is active', () => {
  const src = read('src/lib/batteryOptimization.ts');
  assert.match(src, /recordingActivity\.isActive\(\)/);
  assert.match(src, /name: 'battery_opt_prompt_deferred'/);
});

test('the deferral check runs BEFORE the one-shot marker is written', () => {
  // Otherwise a prompt skipped for a live capture would still burn the single
  // chance to ask, and the vet would never see it.
  const src = read('src/lib/batteryOptimization.ts');
  const guard = src.indexOf('recordingActivity.isActive()');
  const read_ = src.indexOf('getRawItem(PROMPTED_KEY');
  const mark = src.indexOf('setRawItem(PROMPTED_KEY');
  assert.ok(guard > 0 && read_ > guard, 'deferral must precede the marker read');
  assert.ok(mark > guard, 'deferral must precede the marker write');
});

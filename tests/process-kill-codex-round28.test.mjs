/**
 * Codex review round 28 on PR #204 — two P2s, both about reporting an
 * interruption that never happened, or reporting one twice.
 *
 * F1: the launch probe emitted the telemetry and marked the user reported, then
 * pruned. A transient read failure in the prune left the stale pointer behind,
 * so the NEXT process — whose reported-user set starts empty — counted the same
 * interruption again, inflating the very metric these changes are judged by.
 *
 * F2: the expo pointer was published before recorder.start(), which first awaits
 * the Android 13+ POST_NOTIFICATIONS preflight and can sit on a system dialog.
 * An exit while that dialog was up left a pointer for a capture that never
 * opened the microphone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('a failed prune reports no removal, so the caller does not count it', async () => {
  const store = new Map();
  let failReads = false;
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failReads) throw new Error('keystore exploded');
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'slot-a', '2026-09-04T09:00:00.000Z', 'expo');

  failReads = true;
  assert.equal(
    await s.pruneStartedBefore('u1', '2026-09-04T12:00:00.000Z'),
    false,
    'an unreadable store must not report a successful prune',
  );
  failReads = false;
  // ...and the pointer is still there, so a later launch can still report it.
  assert.equal((await s.list()).length, 1);
});

test('a successful prune reports true, including when nothing was stale', async () => {
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
  s.setUserId('u1');
  assert.equal(await s.pruneStartedBefore('u1', '2026-09-04T12:00:00.000Z'), true, 'empty store');

  await s.setActive('dr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'slot-a', '2026-09-04T09:00:00.000Z', 'expo');
  assert.equal(await s.pruneStartedBefore('u1', '2026-09-04T12:00:00.000Z'), true, 'stale removed');
  assert.deepEqual(await s.list(), []);
});

test('the probe prunes before it emits, and emits only on confirmed removal', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  const start = src.indexOf('async function reportPriorUncleanExit(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const prune = body.indexOf('.pruneStartedBefore(userId, PROCESS_START_ISO)');
  const gate = body.indexOf('if (!pruned) return;');
  const emit = body.indexOf("name: 'capture_ended_without_cleanup'");
  const mark = body.indexOf('uncleanExitReportedUsers.add(userId);');
  assert.ok(prune > 0 && gate > prune, 'the emit must be gated on the prune result');
  assert.ok(emit > gate && mark > gate, 'neither the event nor the mark may precede the gate');
});

test('the notification preflight runs before the expo pointer is published', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  const preflight = src.indexOf('await recorder.ensureRecordingNotificationPermission();');
  const publish = src.indexOf("durableActiveStore.setActive(slotId, slotId, new Date().toISOString(), 'expo')");
  assert.ok(preflight > 0, 'preflight anchor');
  assert.ok(publish > preflight, 'the dialog must be dealt with before the pointer exists');
  // And the scope gate still sits between them, per the round-25 rule.
  const between = src.slice(preflight, publish);
  assert.match(between, /if \(scopeUnchanged\(\)\) \{/);
});

test('the preflight is exposed and idempotent, not a second request', () => {
  const hook = read('src/hooks/useAudioRecorder.ts');
  assert.match(hook, /ensureRecordingNotificationPermission: \(\) => Promise<void>;/);
  // One-shot per process, so calling it early makes the in-start call a no-op.
  assert.match(hook, /if \(androidNotificationPermissionChecked\) return;/);
  const ret = hook.slice(hook.indexOf('return useMemo<UseAudioRecorderReturn>('));
  assert.equal(
    (ret.match(/ensureRecordingNotificationPermission,/g) ?? []).length,
    2,
    'must appear in the object and its deps',
  );
});

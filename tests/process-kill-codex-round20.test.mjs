/**
 * Codex review round 20 on PR #204 (P1): freezeOnBlur defeated the
 * recorder/player concurrency guard.
 *
 * The record-perf work put freezeOnBlur on every non-record tab. But the
 * Recordings tab hosts RecordingAudioPlayer, whose entire safety contract is a
 * recordingActivity subscription: when the recorder takes the audio session the
 * state update renders an inert branch, which UNMOUNTS ActiveAudioPlayer and
 * releases the native player.
 *
 * A frozen screen cannot render that update. So: play a recording, switch to
 * Record, hit Start — playback keeps running with allowsRecording already
 * flipped off under a live recorder. That is the rule-6 failure class the guard
 * exists to prevent, on the one path where it can corrupt a clinical recording.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function tabScreen(name) {
  const layout = read('app/(app)/(tabs)/_layout.tsx');
  const start = layout.indexOf(`name="${name}"`);
  assert.ok(start > 0, `Tabs.Screen ${name} not found`);
  const end = layout.indexOf('<Tabs.Screen', start + 1);
  return layout.slice(start, end === -1 ? undefined : end);
}

test('the tab hosting the audio player is never frozen', () => {
  assert.doesNotMatch(tabScreen('recordings'), /freezeOnBlur/);
});

test('the perf win is kept on the tabs that host no player', () => {
  // The fix is scoped: only the player-hosting tab loses the optimization.
  assert.match(tabScreen('index'), /freezeOnBlur: true/);
  assert.match(tabScreen('patient'), /freezeOnBlur: true/);
});

test('the player still releases itself when the recorder takes the session', () => {
  // The half that only works if the screen can re-render.
  const src = read('src/components/RecordingAudioPlayer.tsx');
  assert.match(src, /return recordingActivity\.subscribe\(setRecordingActive\);/);
  assert.match(src, /if \(recordingActive\) \{/);
});

test('the reason is recorded at the tab, where the option would be re-added', () => {
  const screen = tabScreen('recordings');
  assert.match(screen, /RecordingAudioPlayer/);
  assert.match(screen, /rule-6/);
});

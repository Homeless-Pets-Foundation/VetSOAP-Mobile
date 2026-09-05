/**
 * Codex review round 12 on PR #204 (P2): don't attribute every unclean exit to
 * Android.
 *
 * The launch probe fires on `startedAt < PROCESS_START_ISO`, which proves only
 * that the previous process ended without clearing its capture pointer. A
 * reboot, a swipe from Recents, a force-stop and a native crash all leave the
 * identical pointer. The event name asserted an OS kill and the prompt copy told
 * the vet "Android stopped Captivet during your last recording" — false whenever
 * they had simply rebooted, and it sent them into an unrelated setting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/**
 * Scope to BATTERY_OPTIMIZATION_COPY. A bare indexOf('  body:') over the whole
 * catalog lands on the first copy object in the file, hundreds of lines away.
 */
function batteryBlock() {
  const src = read('src/constants/strings.ts');
  const start = src.indexOf('export const BATTERY_OPTIMIZATION_COPY');
  assert.ok(start > 0, 'battery copy block');
  const end = src.indexOf('} as const;', start);
  assert.ok(end > start, 'battery copy block end');
  return src.slice(start, end);
}

test('the after-exit prompt reports the observation, never a cause', () => {
  const block = batteryBlock();
  const body = block.slice(block.indexOf('bodyAfterUncleanExit:'), block.indexOf('confirm:'));
  assert.ok(body.length > 0, 'anchor');
  assert.doesNotMatch(
    body,
    /Android stopped Captivet during your last recording/,
    'must not assert Android as the cause of an exit it cannot attribute',
  );
  // Conditional, not causal.
  assert.match(body, /That can happen when Android stops Captivet/);
  // The honesty guarantees from the original copy survive the rewrite.
  assert.match(body, /less likely/);
  assert.doesNotMatch(body, /\bprevents\b/);
  assert.match(body, /reduces the risk, it does not remove it/);
});

test('the generic prompt still carries the no-guarantee line', () => {
  const block = batteryBlock();
  const body = block.slice(block.indexOf('  body:'), block.indexOf('bodyAfterUncleanExit:'));
  assert.ok(body.length > 0, 'anchor');
  assert.match(body, /reduces the risk, it does not remove it/);
  assert.doesNotMatch(body, /\bprevents\b/);
});

test('the event is named for the evidence, not the suspected cause', () => {
  const analytics = read('src/lib/analytics.ts');
  assert.match(analytics, /name: 'capture_ended_without_cleanup';/);
  const recovery = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(recovery, /name: 'capture_ended_without_cleanup',/);
  assert.match(recovery, /captureMessage\('capture_ended_without_cleanup'/);
});

test('no identifier or string still claims a kill was proven', () => {
  // A rename that stops halfway is worse than none: the old name in one call
  // site keeps the false claim alive in dashboards and in the next reader's head.
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        'grep', '-nI',
        '-e', 'process_killed_mid_capture',
        '-e', 'priorProcessKillDetected',
        '--', 'src', 'app', 'tests',
        // Exclude THIS file: it names the old identifiers literally, so once it
        // is tracked the search matches its own argv and the fence fails on a
        // clean tree. It passed before the commit only because git grep skips
        // untracked files.
        ':(exclude)tests/process-kill-codex-round12.test.mjs',
      ],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
    );
  } catch {
    out = ''; // git grep exits 1 when nothing matches — the passing case.
  }
  assert.equal(out.trim(), '', `stale kill-asserting identifiers remain:\n${out}`);
});

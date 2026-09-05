/**
 * Codex review round 18 on PR #204 (P1): the sibling of round 17, through the
 * START path.
 *
 * Round 14 gated the durable POINTER WRITE on the initiating user, but the
 * native start ran regardless. The engine is a process singleton, so a capture
 * begun for a user who has since signed out holds the microphone under the
 * DEPARTED user's directory and rejects the next user's start with BUSY.
 *
 * Round 17's teardown cannot rescue this one: activeDurableRecordingId is
 * populated only once native start RESOLVES, so a start still in flight is
 * invisible there. Hence two gates — before invoking native start, and again
 * after it resolves, since sign-out can land inside the call itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function startHandler() {
  const src = read('app/(app)/(tabs)/record.tsx');
  const start = src.indexOf('const startRecording = useCallback');
  const idx = start > 0 ? start : src.indexOf('const handleStart = useCallback');
  assert.ok(idx > 0, 'start handler anchor');
  const end = src.indexOf('const handleStop = useCallback(', idx);
  assert.ok(end > idx, 'start handler end anchor');
  return src.slice(idx, end);
}

test('the native durable start is aborted for a departed user', () => {
  const fn = startHandler();
  const fresh = fn.slice(fn.indexOf('const freshDurable ='));
  const guard = fresh.indexOf('if (!scopeUnchanged()) {');
  const nativeStart = fresh.indexOf('recorder.start({ userId: user.id, slotId, recordingId })');
  assert.ok(guard > 0, 'pre-start scope guard missing');
  assert.ok(nativeStart > guard, 'the guard must precede the native start');
});

test('the native durable resume is aborted for a departed user', () => {
  const fn = startHandler();
  const resume = fn.slice(fn.indexOf('const existingDurable ='), fn.indexOf('const freshDurable ='));
  const guard = resume.indexOf('if (!scopeUnchanged()) {');
  const nativeResume = resume.indexOf('recorder.resumeDurable(');
  assert.ok(guard > 0, 'pre-resume scope guard missing');
  assert.ok(nativeResume > guard, 'the guard must precede the native resume');
});

test('a sign-out DURING the native call finalizes rather than leaks the singleton', () => {
  const fn = startHandler();
  // Both branches re-check after the await and stop the recorder. Without this
  // the window inside the native call itself stays open.
  // Round 19 inserted the confirmed-finalize call ahead of the stop, so this
  // matches on the pair rather than a fixed character window.
  const finalize = fn.match(/await finalizeDepartedUserCapture\(/g);
  const stops = fn.match(/await recorder\.stop\(\)\.catch\(\(\) => \{\}\);/g);
  assert.equal(finalize?.length, 2, 'both durable branches must finalize on late scope loss');
  assert.equal(stops?.length, 2, 'and both must settle the recorder itself');
  for (const branch of ['recordingId,', 'existingDurable.recordingId,']) {
    assert.ok(fn.includes(branch), `finalize must name ${branch}`);
  }
});

test('the late-scope-loss path finalizes, never discards', () => {
  const fn = startHandler();
  // Rule 8: the manifest is how the departed user recovers this audio. A
  // discard here would destroy un-uploaded recording.
  const idx = fn.indexOf('await recorder.stop().catch(() => {});');
  const window = fn.slice(Math.max(0, idx - 600), idx + 200);
  assert.doesNotMatch(window, /durableRecorder\.discard\(/, 'must not discard a departed user\'s audio');
});

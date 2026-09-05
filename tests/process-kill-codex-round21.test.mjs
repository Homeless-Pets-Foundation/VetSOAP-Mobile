/**
 * Codex review round 21 on PR #204 (P2): the FOURTH exit of one bug.
 *
 * Rounds 14, 17, 18 and 19 were all "work initiated by user A completes after A
 * is gone", each patched where it surfaced. Round 21 found it again in the
 * failed-start cleanup, so this round generalises instead: one helper that takes
 * the INITIATING user, applied to every pointer clear downstream of an await.
 *
 * AuthProvider rebinds durableActiveStore to null before the state change that
 * unmounts the screen, so an ambient clear silently no-ops across a sign-out and
 * strands the pointer — a phantom "recording interrupted" report for A, and on a
 * shared tablet for whoever signs in next.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function slice(from, to) {
  const src = read('app/(app)/(tabs)/record.tsx');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `anchors ${from} .. ${to}`);
  return src.slice(a, b);
}

test('the shared helper prefers the initiating user and never skips the clear', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /const clearCapturePointer = useCallback\(/);
  const fn = slice('const clearCapturePointer = useCallback(', 'const startRecordingForSlot');
  assert.match(fn, /durableActiveStore\.clearActiveForUser\(initiatorId, id\)/);
  // Ambient is the fallback when no initiator is known — strictly better than
  // not clearing at all.
  assert.match(fn, /durableActiveStore\.clearActive\(id\)/);
});

test('the helper is declared BEFORE its first use', () => {
  // Not style: these are useCallback dependency arrays, which evaluate at the
  // useCallback call. Declared after the start handler, adding it to that dep
  // array is a TDZ throw on every render of the Record screen.
  const src = read('app/(app)/(tabs)/record.tsx');
  const decl = src.indexOf('const clearCapturePointer = useCallback(');
  const firstUse = src.indexOf('const startRecordingForSlot = useCallback(');
  assert.ok(decl > 0 && firstUse > decl, 'helper must precede the handlers that depend on it');
});

test('no failed-start cleanup clears by ambient scope', () => {
  const fn = slice('const startRecordingForSlot = useCallback(', 'const handleStop = useCallback(');
  assert.doesNotMatch(fn, /durableActiveStore\.clearActive\(/, 'start path must route through the helper');
  for (const id of ['freshDurableRecordingId', 'expoPointerSlotId', 'resumeDurableRecordingId']) {
    assert.match(
      fn,
      new RegExp(`clearCapturePointer\\(initiatingUserId, ${id}\\)`),
      `${id} cleanup must name the initiating user`,
    );
  }
});

test('the finish path clears for the user who finished', () => {
  const fn = slice('const handleStop = useCallback(', 'const handleContinueRecording = useCallback(');
  assert.match(fn, /const finishUserId = user\?\.id \?\? null;/);
  assert.doesNotMatch(fn, /durableActiveStore\.clearActive\(/);
  // The round-16 pre-autosave pair, the finally pair, and the durable finish
  // clear — every one of them downstream of an await.
  assert.equal((fn.match(/clearCapturePointer\(finishUserId, /g) ?? []).length, 5);
});

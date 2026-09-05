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
  assert.match(src, /async function clearCapturePointer\(initiatorId: string \| null, id: string \| null\)/);
  const fn = slice('async function clearCapturePointer(', 'async function withDurableOpWatchdog');
  assert.match(fn, /durableActiveStore\.clearActiveForUser\(initiatorId, id\)/);
  // Ambient is the fallback when no initiator is known — strictly better than
  // not clearing at all.
  assert.match(fn, /durableActiveStore\.clearActive\(id\)/);
});

test('the helper is a module function, not a hook', () => {
  // As a useCallback it had to precede every handler listing it as a dependency,
  // because dep arrays evaluate at the useCallback call — declared after, it is
  // a TDZ throw on every render of the Record screen. A hoisted function
  // declaration removes that hazard entirely, and it needs no component state.
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.doesNotMatch(src, /const clearCapturePointer = useCallback\(/);
  assert.match(src, /^async function clearCapturePointer\(/m);
  // ...and therefore is not a dependency of anything.
  assert.doesNotMatch(src, /, clearCapturePointer\]/);
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

test('record.tsx clears pointers ONLY through the helper', () => {
  // The fence that ends this bug family (rounds 14/17/18/19/21/23). Every
  // ambient clear is a latent sign-out bug, so the file is allowed exactly one
  // call — the fallback inside the helper itself.
  const src = read('app/(app)/(tabs)/record.tsx');
  const calls = src.match(/durableActiveStore\.clearActive\(/g) ?? [];
  assert.equal(calls.length, 1, 'only the helper may call clearActive directly');
  const helper = src.slice(
    src.indexOf('async function clearCapturePointer('),
    src.indexOf('async function withDurableOpWatchdog'),
  );
  assert.match(helper, /durableActiveStore\.clearActive\(id\)/, 'and that one is the fallback');
});

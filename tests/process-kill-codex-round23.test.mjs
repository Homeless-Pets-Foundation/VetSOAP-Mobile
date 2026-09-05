/**
 * Codex review round 23 on PR #204 — two P2s.
 *
 * F1 was the FIFTH exit of the scope family: the discard and active-slot Remove
 * paths still cleared by ambient scope, so a sign-out while recorder.stop() was
 * pending left user A's pointer behind (or targeted user B's store) and gave A a
 * phantom interruption warning for a recording they deliberately discarded. The
 * fix is the fence in round21's suite — record.tsx now clears only through
 * clearCapturePointer.
 *
 * F2: the battery prompt could land over an in-flight start. A tap sets
 * startInFlightRef synchronously, but recordingActivity only flips when the
 * recorder BINDS, after floor hydration — so both of the prompt's own
 * recordingActivity checks read false in between, and "Open Settings" would
 * background the app exactly as capture began.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the discard path clears in the initiating user scope', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /void clearCapturePointer\(user\?\.id \?\? null, discardedSlotId\);/);
  assert.match(src, /void clearCapturePointer\(user\?\.id \?\? null, discardedDurableId\);/);
});

test('the active-slot Remove path does too', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /void clearCapturePointer\(user\?\.id \?\? null, removedDurableId\);/);
});

test('the battery prompt defers while a start is in flight', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(
    src,
    /!isExpired\(\) &&\s*\n\s*!startInFlightRef\.current &&\s*\n\s*durableActiveStore\.getUserId\(\) === promptUserId/,
  );
});

test('startInFlightRef is the synchronous signal, set before any await', () => {
  // The whole point: recordingActivity cannot cover this window because it only
  // flips when the recorder binds, which is after floor hydration.
  const src = read('app/(app)/(tabs)/record.tsx');
  const idx = src.indexOf('if (startInFlightRef.current) return;');
  assert.ok(idx > 0, 'guard anchor');
  const set = src.indexOf('startInFlightRef.current = true;', idx);
  const firstAwait = src.indexOf('await ', idx);
  assert.ok(set > idx && set < firstAwait, 'must be set before the first await');
});

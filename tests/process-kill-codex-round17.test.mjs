/**
 * Codex review round 17 on PR #204 (P1): a live durable capture survived
 * sign-out.
 *
 * The teardown cleared the capture pointers but never stopped the native
 * recorder. The Android engine is a process SINGLETON: detach() only flushes
 * and drops the event sink (DurableRecorderEngine.detach), deliberately leaving
 * a running capture alive, and start() throws BUSY while `running`. So on a
 * shared clinic tablet the microphone stayed open, kept appending under the
 * departed user's directory, and the next vet could not record at all — while
 * the pointer that identified the abandoned capture had already been erased.
 *
 * expo-audio auto-releases on unmount; the durable recorder has no such path.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function teardown() {
  const src = read('app/(app)/(tabs)/record.tsx');
  const start = src.indexOf('const liveCaptureRef = useRef<{');
  assert.ok(start > 0, 'liveCaptureRef anchor');
  const end = src.indexOf('const handlePause = useCallback(', start);
  assert.ok(end > start, 'teardown end anchor');
  return src.slice(start, end);
}

test('the teardown finalizes a live durable capture', () => {
  const fn = teardown();
  assert.match(fn, /durableRecorder\.stop\(\{ userId, recordingId: durableId \}\)/);
});

test('the finalize happens BEFORE the breadcrumb is cleared', () => {
  const fn = teardown();
  const stop = fn.indexOf('durableRecorder.stop(');
  const clear = fn.indexOf('clearActiveForUser(userId, durableId)');
  assert.ok(stop > 0 && clear > 0, 'anchors');
  assert.ok(stop < clear, 'stop must precede the pointer clear');
});

test('a failed finalize KEEPS the pointers rather than erasing the evidence', () => {
  const fn = teardown();
  // The catch must bail out before any clear. A live mic with no record of who
  // owns it is far worse than one spurious interruption report.
  const catchIdx = fn.indexOf('} catch {', fn.indexOf('durableRecorder.stop('));
  assert.ok(catchIdx > 0, 'catch anchor');
  const afterCatch = fn.slice(catchIdx, fn.indexOf('}', fn.indexOf('return;', catchIdx)));
  assert.match(afterCatch, /return;/);
  assert.doesNotMatch(afterCatch, /clearActiveForUser/);
});

test('the native stop is bounded, since an unmount cleanup cannot await', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /const DURABLE_TEARDOWN_STOP_TIMEOUT_MS = [\d_]+;/);
  const fn = teardown();
  assert.match(fn, /withPromiseTimeout\(\s*\n\s*durableRecorder\.stop\(/);
});

test('detach really does leave a running capture alive (the premise)', () => {
  const kt = read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  const detach = kt.slice(kt.indexOf('fun detach() {'), kt.indexOf('fun detach() {') + 200);
  assert.doesNotMatch(detach, /stopCapture|running = false/, 'detach must not be assumed to stop');
  // ...and that is why an unstopped capture blocks the next user.
  assert.match(kt, /if \(running \|\| tearingDown\.get\(\)\) \{[\s\S]{0,120}DurableErrors\.BUSY/);
});

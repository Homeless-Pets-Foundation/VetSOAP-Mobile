/**
 * Codex review round 2 on PR #204.
 *
 * Both findings are the same failure as round 1's discard case, but on paths a
 * user hits when everything WORKS — which is worse. A pointer that outlives a
 * successful recording makes the launch scan report a kill that never happened,
 * telling a vet Android truncated audio that saved perfectly.
 *
 * Following the convention in record-start-feedback.test.mjs: behavioural where
 * the code is pure, scope- and order-aware fences where it lives inside a React
 * component (record.tsx is .tsx, which tests/helpers/loadTs.mjs cannot execute).
 * The fences below assert POSITION — inside `finally`, inside the fallback
 * branch — not merely that a string appears somewhere in a 7k-line file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const RECORD = 'app/(app)/(tabs)/record.tsx';

function handleStopBody(src) {
  const start = src.indexOf('const handleStop = useCallback(');
  const end = src.indexOf('const handleContinueRecording = useCallback(');
  assert.ok(start > 0 && end > start, 'handleStop not found');
  return src.slice(start, end);
}

// ---- R2-F1 (P1): manual Finish is the NORMAL exit and must clear ----------

test('handleStop clears the capture pointer in finally, covering every exit', () => {
  const fn = handleStopBody(read(RECORD));
  const finallyIdx = fn.lastIndexOf('} finally {');
  assert.ok(finallyIdx > 0, 'handleStop has no finally');
  const finallyBlock = fn.slice(finallyIdx);

  // `finally` is the only placement that covers the success path, BOTH
  // "could not be captured/linked" early returns, and the catch.
  // Round 21: cleared for the user who FINISHED, not the ambient scope — this
  // finally runs after autoSaveDraft, which is seconds of work.
  assert.match(finallyBlock, /clearCapturePointer\(finishUserId, targetSlotId\)/);
  assert.match(finallyBlock, /clearCapturePointer\(finishUserId, durableIdAtFinish\)/);
});

test('handleStop captures the durable id before stop() can clear it', () => {
  const fn = handleStopBody(read(RECORD));
  const capture = fn.indexOf('const durableIdAtFinish = recorder.activeDurableRecordingId');
  const firstStop = fn.indexOf('recorder.stop()');
  assert.ok(capture > 0, 'durable id is not captured');
  assert.ok(firstStop > 0 && capture < firstStop, 'must be captured before stop()');
});

test('the manual-finish early return in the stopped effect still precedes cleanup', () => {
  // This is WHY the finally is needed: the effect bails for the finishing slot
  // before reaching its own clearActive. If this guard is ever removed, the
  // finally becomes redundant rather than wrong — but while it exists, removing
  // the finally silently reintroduces a false kill on every recording.
  const src = read(RECORD);
  const guard = src.indexOf('if (manualFinishSlotIdRef.current && manualFinishSlotIdRef.current === session.recorderBoundToSlotId)');
  const effectCleanup = src.indexOf('void clearCapturePointer(user?.id ?? null, slotId);');
  assert.ok(guard > 0);
  assert.ok(effectCleanup > guard, 'guard must still precede the effect cleanup for this fence to mean anything');
});

// ---- R2-F2 (P2): durable start silently falls back to expo ----------------

test('the hook exposes the backend it actually selected, read from a ref', () => {
  const hook = read('src/hooks/useAudioRecorder.ts');
  // Must be a ref read, not React state: record.tsx needs the answer in the same
  // tick it awaits start(), and setActiveDurableRecordingId is not visible then.
  assert.match(hook, /const getSelectedBackend = useCallback\(\(\) => backendRef\.current, \[\]\)/);
  assert.match(hook, /getSelectedBackend: \(\) => 'expo' \| 'durable';/);
  // And it must be in the memoized return AND its dep array, or callers get a
  // stale closure.
  const ret = hook.slice(hook.indexOf('return useMemo<UseAudioRecorderReturn>('));
  assert.equal((ret.match(/getSelectedBackend,/g) ?? []).length, 2, 'must appear in the object and the deps');
});

test('a durable start failure really does fall through to expo without throwing', () => {
  // The premise of the finding: start() resolves successfully after fallback, so
  // the caller cannot detect it from the return value.
  const hook = read('src/hooks/useAudioRecorder.ts');
  const catchIdx = hook.indexOf('} catch (durableError) {');
  assert.ok(catchIdx > 0);
  const block = hook.slice(catchIdx, catchIdx + 600);
  assert.match(block, /backendRef\.current = 'expo'/);
  assert.doesNotMatch(block, /throw /, 'a rethrow here would make the outer catch handle it instead');
  assert.match(block, /fall through to expo-audio path below/);
});

test('record.tsx re-keys the pointer when durable start fell back to expo', () => {
  const src = read(RECORD);
  const idx = src.indexOf("if (recorder.getSelectedBackend() === 'expo' && scopeUnchanged()) {");
  assert.ok(idx > 0, 'no fallback re-key branch (must also verify user scope)');
  const branch = src.slice(idx, idx + 900);
  // The durable-keyed pointer must go, or it outlives the recording.
  assert.match(branch, /clearCapturePointer\(initiatingUserId, recordingId\)/);
  // freshDurableRecordingId must be dropped too, or the catch would later clear
  // an id that no longer describes anything.
  assert.match(branch, /freshDurableRecordingId = null/);
  // And an expo-keyed pointer must replace it, so the capture stays covered.
  assert.match(branch, /expoPointerSlotId = slotId/);
  assert.match(branch, /setActive\(slotId, slotId, new Date\(\)\.toISOString\(\), 'expo'\)/);
});

test('the re-key happens after start resolves, not before', () => {
  // getSelectedBackend is only meaningful once start() has picked a backend.
  const src = read(RECORD);
  const startAwait = src.indexOf("recorder.start({ userId: user.id, slotId, recordingId })");
  const rekey = src.indexOf("if (recorder.getSelectedBackend() === 'expo' && scopeUnchanged()) {");
  assert.ok(startAwait > 0 && rekey > startAwait, 're-key must follow the start await');
});

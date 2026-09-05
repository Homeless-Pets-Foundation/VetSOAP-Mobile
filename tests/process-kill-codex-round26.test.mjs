/**
 * Codex review round 26 on PR #204 (P2), again caused by the previous round's
 * fix.
 *
 * Round 25 added a scope recheck after the awaited pointer write, which
 * correctly refuses to start the native recorder for a departed user — but
 * returned without clearing the pointer that write may already have PUBLISHED.
 * Nothing else could remove it: both the catch cleanup and the unmount teardown
 * key off a durable id that native start never got to attach. So an attempt that
 * never opened the microphone was reported as an interrupted capture on that
 * user's next launch.
 *
 * The generalised fence is the second test: EVERY scope-abort that follows a
 * pointer write must clear before it returns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function startHandler() {
  const src = read('app/(app)/(tabs)/record.tsx');
  const a = src.indexOf('const startRecordingForSlot = useCallback(');
  const b = src.indexOf('const handleStop = useCallback(', a);
  assert.ok(a > 0 && b > a, 'anchors');
  return src.slice(a, b);
}

test('both post-write aborts clear the pointer they may have published', () => {
  const fn = startHandler();
  assert.match(fn, /await clearCapturePointer\(initiatingUserId, recordingId\);\s*\n\s*unbindRecorder\(\);/);
  assert.match(
    fn,
    /await clearCapturePointer\(initiatingUserId, existingDurable\.recordingId\);\s*\n\s*unbindRecorder\(\);/,
  );
});

test('no scope-abort after a pointer write returns without clearing', () => {
  // The general form. Walk every `if (!scopeUnchanged())` block that appears
  // after a pointer write and require a clear inside it — a bare early return
  // there always strands a breadcrumb for a capture that never began.
  const fn = startHandler();
  // Per BRANCH: a gate before that branch's own write has nothing published yet
  // to clear, so scanning the whole handler from the first write would flag the
  // fresh branch's legitimate pre-write gate.
  const branches = {
    resume: fn.slice(fn.indexOf('const existingDurable ='), fn.indexOf('const freshDurable =')),
    fresh: fn.slice(fn.indexOf('const freshDurable =')),
  };
  for (const [name, branch] of Object.entries(branches)) {
    const write = branch.indexOf('await racePreStartPointerWrite(');
    assert.ok(write > 0, `${name}: pointer write anchor`);
    const blocks = [...branch.slice(write).matchAll(/if \(!scopeUnchanged\(\)\) \{([\s\S]*?)\n(\s*)\}/g)];
    assert.ok(blocks.length >= 2, `${name}: expected the post-write aborts`);
    for (const [, body] of blocks) {
      assert.match(
        body,
        /clearCapturePointer|finalizeDepartedUserCapture/,
        `${name}: a scope abort after the pointer write must clear or finalize:\n${body}`,
      );
    }
  }
});

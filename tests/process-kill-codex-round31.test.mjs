/**
 * Codex review round 31 on PR #204 — a P1 in the expo start path, and a P2 that
 * is the sharpest finding of the review: a regression test of mine that did not
 * test what it claimed.
 *
 * F1: the expo branch gained two awaits (the notification preflight and the
 * bounded pointer write) but no post-await abort, so a sign-out during either
 * still reached recorder.start() — opening the microphone after logout — and a
 * scope change during the write left the pointer published with no cleanup. Both
 * durable branches had been fixed in rounds 18/25/26; this one had not.
 *
 * F2 (fixed in round24's file): writeChunkedValueVersioned awaits the `_ptr`
 * read first, so the call yielded before the mock reached setItemAsync and the
 * very next line cleared the hang selector. The chunk was never gated, the test
 * ran only sequential completed writes, and it passed with the in-flight
 * reservation REMOVED. It now synchronises on the mock entering the gate, and
 * carries the shouldCommit guard activeStore always passes so the abandoned
 * write cannot publish. Verified by deleting the reservation: the test fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function expoBranch() {
  const src = read('app/(app)/(tabs)/record.tsx');
  const a = src.indexOf('await recorder.ensureRecordingNotificationPermission();');
  const b = src.indexOf('await recorder.start();', a);
  assert.ok(a > 0 && b > a, 'expo branch anchors');
  return src.slice(a, b);
}

test('the expo start aborts after the preflight await', () => {
  const branch = expoBranch();
  const preflightGate = branch.indexOf('if (!scopeUnchanged()) {');
  const write = branch.indexOf('await racePreStartPointerWrite(');
  assert.ok(preflightGate > 0, 'no abort after the preflight');
  assert.ok(write > preflightGate, 'the abort must precede the pointer write');
});

test('the expo start aborts after the pointer write, clearing what it published', () => {
  const branch = expoBranch();
  const write = branch.indexOf('await racePreStartPointerWrite(');
  const after = branch.slice(write);
  assert.match(after, /if \(!scopeUnchanged\(\)\) \{/, 'no abort after the write');
  assert.match(after, /await clearCapturePointer\(initiatingUserId, slotId\);/);
  assert.match(after, /expoPointerSlotId = null;/);
});

test('the microphone is never opened after an abort', () => {
  // Every abort in the branch must return before reaching start().
  const branch = expoBranch();
  const blocks = [...branch.matchAll(/if \(!scopeUnchanged\(\)\) \{([\s\S]*?)\n(\s*)\}/g)];
  assert.equal(blocks.length, 2, 'both awaits must be followed by an abort');
  for (const [, body] of blocks) {
    assert.match(body, /unbindRecorder\(\);/, `abort must release the binding:\n${body}`);
    assert.match(body, /return;/, `abort must return, not fall through to start():\n${body}`);
  }
});

test('the ring-reservation test synchronises on the mock reaching its gate', () => {
  // The defect: the writer awaits the `_ptr` read before any setItemAsync, so
  // clearing the selector on the next line left the chunk ungated.
  const src = read('tests/process-kill-codex-round24.test.mjs');
  const call = src.indexOf("mod.writeChunkedValueVersioned(PREFIX, JSON.stringify(['stale'])");
  const sync = src.indexOf('await atGate;', call);
  const clear = src.indexOf('hangGen = null;', call);
  assert.ok(call > 0 && sync > call, 'must wait for the mock to block');
  assert.ok(clear > sync, 'the selector may only be cleared once the gate is engaged');
  // And the abandoned write must be unable to publish, as in the real caller.
  assert.match(src, /shouldCommit: \(\) => !abandoned,/);
  assert.match(src, /assert\.equal\(await hung, false, 'an abandoned write must not publish'\);/);
});

/**
 * Codex review round 19 on PR #204 — one P1 and two P2s, two of them fallout
 * from the round-17/18 scope-loss fixes.
 *
 * P1: the teardown's fire-and-forget async IIFE had no terminal .catch, so any
 * throw outside its narrow inner guards would be a Hermes unhandled rejection
 * during sign-out — a release crash (rule 4).
 *
 * P2a: the late scope-loss branches finalized the recorder but never cleared the
 * pointer, so a capture deliberately finalized during sign-out was reported as
 * an unclean exit on the next launch.
 *
 * P2b: the battery prompt was declared ABOVE the startup sweeps. Serial jobs
 * chain onto startupSweepTail in effect-registration order, so it became the
 * HEAD of the chain — firing before the screen settled, and letting the eviction
 * pass raise its own Alert over the open one-shot prompt.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the teardown IIFE has a terminal catch at its boundary', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  const idx = src.indexOf('const liveCaptureRef = useRef<{');
  const block = src.slice(idx, src.indexOf('const handlePause = useCallback(', idx));
  assert.ok(block.length > 0, 'anchor');
  assert.match(block, /\}\)\(\)\.catch\(\(\) => \{\}\);/, 'rule 4: no bare fire-and-forget');
  assert.doesNotMatch(block, /\}\)\(\);\s*\n\s*\/\/ Terminal/, 'must not be the uncaught form');
});

test('a confirmed finalize is required before the pointer is cleared', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  // recorder.stop() swallows native failures by contract (rule 6), so it cannot
  // be the success signal — clearing on it would erase the breadcrumb exactly
  // when finalization failed and the singleton may still hold the mic.
  assert.match(src, /async function finalizeDepartedUserCapture\(/);
  assert.match(src, /if \(!isDurable\) return true;/);
  const uses = src.match(/if \(confirmed && initiatingUserId\) \{/g);
  assert.equal(uses?.length, 2, 'both durable scope-loss branches must gate the clear');
  const clears = src.match(/clearActiveForUser\(initiatingUserId, (recordingId|existingDurable\.recordingId)\)/g);
  assert.equal(clears?.length, 2, 'cleared by EXPLICIT user — ambient scope is null here');
});

test('the battery prompt registers after every startup sweep', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  const battery = src.indexOf("'battery_opt_prompt'");
  const sweeps = [
    "scheduleNonUrgentWork('record_pending_draft_scan'",
    "scheduleNonUrgentWork('orphan_cleanup'",
    "scheduleNonUrgentWork('thirty_day_eviction'",
  ].map((s) => src.indexOf(s));
  assert.ok(battery > 0 && sweeps.every((i) => i > 0), 'anchors');
  for (const sweep of sweeps) {
    assert.ok(battery > sweep, 'the prompt must be declared below every serial sweep');
  }
});

test('the ordering requirement is written down where it can be violated', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  // Effect order is invisible at the call site; without this note the next
  // reordering silently reopens the bug.
  assert.match(src, /DECLARATION ORDER IS LOAD-BEARING/);
});

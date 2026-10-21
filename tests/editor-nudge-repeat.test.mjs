// Audio editor: holding a nudge button must keep moving the trim handle.
// The long-press repeat calls nudgeHandleFor from a setInterval created at
// press time; while nudgeHandleFor computed from trimStart/trimEnd STATE, that
// closure saw the press-time values forever — the handle moved one step and
// stopped while the haptic fired at 10 Hz. It must read (and advance) the
// live refs, and must not depend on the state values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../app/(app)/audio-editor.tsx', import.meta.url), 'utf8');
const start = src.indexOf('const nudgeHandleFor = useCallback(');
const end = src.indexOf('const nudgeHandle = useCallback(', start);
const body = start >= 0 && end > start ? src.slice(start, end) : '';

test('nudgeHandleFor exists where the repeat path calls it', () => {
  assert.ok(body, 'nudgeHandleFor block found');
  assert.match(src, /setInterval\(\(\) => nudgeHandle\(deltaSec\), 100\)/);
});

test('nudge math reads the live refs, not press-time state', () => {
  assert.match(body, /const start = trimStartStateRef\.current;/);
  assert.match(body, /const end = trimEndStateRef\.current;/);
  assert.doesNotMatch(body, /\btrimStart \+ deltaSec|\btrimEnd \+ deltaSec/);
});

test('each step advances the ref so ticks accumulate before a re-render', () => {
  assert.match(body, /trimStartStateRef\.current = next;\s*setTrimStart\(next\);/);
  assert.match(body, /trimEndStateRef\.current = next;\s*setTrimEnd\(next\);/);
});

test('the callback no longer depends on trim state (a stale closure is harmless)', () => {
  const deps = body.match(/\[([^\]]*)\]\s*\);\s*$/);
  assert.ok(deps, 'dependency array found');
  assert.doesNotMatch(deps[1], /\btrimStart\b|\btrimEnd\b/);
});

test('no haptic when the handle is already at its limit', () => {
  assert.match(body, /if \(next === start\) return;/);
  assert.match(body, /if \(next === end\) return;/);
});

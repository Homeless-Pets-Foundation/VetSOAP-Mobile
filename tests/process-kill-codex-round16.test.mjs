/**
 * Codex review round 16 on PR #204 (P2): the capture pointer outlived a clean
 * finish.
 *
 * handleStop cleared it in its `finally`, but `autoSaveDraft` runs first — it
 * copies the audio, writes chunked SecureStore metadata and creates a server
 * draft, which is seconds of work on a loaded SM-T220. A process death inside
 * that window left a pointer for a recording that had already ended cleanly, so
 * the next launch reported capture_ended_without_cleanup and nagged the vet
 * about battery settings for a recording that saved perfectly.
 *
 * Same class as round 12: the detector must not manufacture evidence.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function stopHandler() {
  const src = read('app/(app)/(tabs)/record.tsx');
  const start = src.indexOf('const handleStop = useCallback(');
  assert.ok(start > 0, 'handleStop anchor');
  const end = src.indexOf('const handleContinueRecording = useCallback(', start);
  assert.ok(end > start, 'handleStop end anchor');
  return src.slice(start, end);
}

test('the pointer is cleared before the slow autosave, not only after it', () => {
  const fn = stopHandler();
  const clear = fn.indexOf('await durableActiveStore.clearActive(targetSlotId)');
  const autosave = fn.indexOf('await autoSaveDraftRef.current(persistedSlot)');
  assert.ok(clear > 0, 'the early clear must exist');
  assert.ok(autosave > 0, 'autosave anchor');
  assert.ok(clear < autosave, 'the clear must land BEFORE autoSaveDraft starts');
});

test('the early clear is awaited, so it cannot race the autosave', () => {
  const fn = stopHandler();
  // Fire-and-forget would reintroduce the window: the point is that the pointer
  // is gone before the seconds-long work begins.
  assert.match(fn, /await durableActiveStore\.clearActive\(targetSlotId\)\.catch\(\(\) => \{\}\);/);
  assert.match(fn, /await durableActiveStore\.clearActive\(durableIdAtFinish\)\.catch\(\(\) => \{\}\);/);
});

test('the finally still clears both keys for the early-return and catch paths', () => {
  const fn = stopHandler();
  const fin = fn.slice(fn.indexOf('} finally {'));
  assert.ok(fin.length > 0, 'finally anchor');
  // A second clear is a no-op; dropping it would strand the pointer on the
  // "could not be captured/linked" early returns and on the catch.
  assert.match(fin, /durableActiveStore\.clearActive\(targetSlotId\)/);
  assert.match(fin, /durableActiveStore\.clearActive\(durableIdAtFinish\)/);
});

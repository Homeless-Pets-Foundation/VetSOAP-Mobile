// Codex round-9 regressions (PR #143): offline-error precedence on Home, and
// iOS-gated screen-reader announcements (Android live regions already cover
// these, so unconditional announces double-speak under TalkBack).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('Home shows the error card only when no cached recordings exist', async () => {
  const src = await read('app/(app)/(tabs)/index.tsx');
  // A persisted list hydrated offline keeps isError=true after the background
  // refetch fails; the error card must not hide the usable cache.
  assert.match(src, /isError && recordings\.length === 0 \?/);
});

test('recorder + interruption announcements are iOS-gated (Android live regions cover them)', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Central helper mirrors the Toast/CopiedToast iOS gating.
  assert.match(src, /function announceForIOS\(message: string\): void \{\s*\n\s*if \(Platform\.OS === 'ios'\) AccessibilityInfo\.announceForAccessibility\(message\);/);
  // Recorder-transition + interruption announcements route through it…
  assert.match(src, /announceForIOS\('Recording started'\)|announceForIOS\(prev === 'paused' \? 'Recording resumed' : 'Recording started'\)/);
  assert.match(src, /announceForIOS\(RECORDER_TRANSITION_COPY\.interruptedPaused\)/);
  assert.match(src, /announceForIOS\(RECORDER_TRANSITION_COPY\.interruptedSaved\)/);
  // …and the recorder-transition effect no longer calls the unconditional API
  // directly (only the iOS-gated helper wraps it).
  const effectStart = src.indexOf('const prevRecorderStateRef = useRef(recorder.state);');
  const effectEnd = src.indexOf('}, [recorder.state]);', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  assert.doesNotMatch(
    src.slice(effectStart, effectEnd),
    /AccessibilityInfo\.announceForAccessibility/
  );
});

test('auto-pause relies on the Toast host for its announcement, not a direct call', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // The Toast component already announces (iOS) + carries a live region
  // (Android); an explicit call beside setPauseToast double-speaks.
  const idx = src.indexOf('const message = RECORDER_TRANSITION_COPY.autoPaused(patientLabel);');
  assert.ok(idx >= 0, 'auto-pause message assembly must exist');
  const window = src.slice(idx, idx + 260);
  assert.match(window, /setPauseToast\(message\)/);
  assert.doesNotMatch(window, /announceForAccessibility\(message\)/);
});

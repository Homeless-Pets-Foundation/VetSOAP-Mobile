# Audio Editor — Pro-Feel Performance & Functionality Upgrades

## Context

The "Edit Recording" screen (`app/(app)/audio-editor.tsx`) already has a strong performance foundation from recent commits (f6359f5, d82d620, afd26c5): SVG-path waveform memoized to 150 peaks, Reanimated worklets driving trim handles on the UI thread, a 100 ms polled `currentTimeSV` shared value driving the playhead with zero React re-renders, FFmpeg AAC stream-copy trims (~23 ms accuracy, near-instant), and disk-cached peaks (`src/lib/waveformCache.ts`). So the low-hanging **pure-perf** wins are mostly already in. What remains — and what will make the screen feel like Descript / Ferrite / TwistedWave rather than a minimal clip-trimmer — is:

- a handful of perceptual-smoothness fixes (jitter in preview-stop, discrete 10 Hz playhead stepping, static 150-peak density), and
- **functionality** that pro editors have and this screen doesn't yet: scrub, nudge, loop, auto-trim silence, split, undo, and pinch-zoom.

**User-confirmed scope:** land all items below in one pass. Scrub-to-seek releases audio (no audible scrub). Auto-trim silence defaults to **-30 dBFS** (conservative).

## Current strengths (do not regress)

- `src/components/WaveformEditor.tsx:60-67` — playhead driven entirely by Reanimated `useDerivedValue` → `useAnimatedStyle`, never by React state.
- `src/components/TrimOverlay.tsx:52-121` — pan + tap gestures both run on UI thread as worklets; `.activeOffsetX([-8,8])` + `.failOffsetY([-15,15])` keeps Android back-swipe from hijacking the left handle.
- `src/components/StaticWaveform.tsx:18-102` — two-path SVG (active / dimmed), `React.memo`, single GPU draw call per region.
- `src/hooks/useAudioPlayback.ts:39-66` — manual `player.addListener('playbackStatusUpdate')` replaces `useAudioPlayerStatus`, so only four discrete state values (isLoaded/isPlaying/isBuffering/duration) ever trigger re-renders.
- `src/lib/ffmpeg.ts:60-109` — trim = `-ss … -to … -c:a copy` stream-copy; no re-encoding.
- `src/lib/waveformCache.ts:25-50` — peaks persisted keyed on `(uri, size)`; repeat opens are free.

## Execution order

Sequenced to minimise merge conflicts: foundational refactors first, additive features after, zoom last because it touches every waveform math path.

### Step 1 — Perceptual smoothness (no new UI)

**1a. Replace preview-stop `setInterval` with `useAnimatedReaction`**
File: `app/(app)/audio-editor.tsx:258-273`
The existing preview uses `setInterval(100ms)` + a `trimEnd - 0.15s` tolerance, which audibly over/undershoots. Introduce `isPreviewModeSV: SharedValue<boolean>` alongside the React state and swap the effect for:
```ts
useAnimatedReaction(
  () => isPreviewModeSV.value && currentTimeSV.value >= trimEndSV.value,
  (shouldStop, prev) => { if (shouldStop && !prev) runOnJS(stopPreview)(); }
);
```
Stop lands within one frame of the shared-value crossing. Keep the React `isPreviewMode` state for UI conditional rendering; just mirror it into the SV.

**1b. 60 Hz interpolated playhead during playback**
File: `src/hooks/useAudioPlayback.ts` (extend) — consumed by `src/components/WaveformEditor.tsx:60-63` without changes
`expo-audio`'s 100 ms status interval makes the playhead *step* ten times per second. Add two refs — `lastStatusTimeRef` (media seconds) and `lastStatusWallClockRef` (`performance.now()`) — updated every `playbackStatusUpdate`. Then `useFrameCallback` writes, while `isPlaying`:
```ts
currentTimeSV.value = Math.min(
  durationRef.current,
  lastStatusTimeRef.current + (performance.now() - lastStatusWallClockRef.current) / 1000
);
```
Cancel frame callback when paused (freezes the SV on last known time). 60 Hz visual slide, native clock untouched. `currentTimeRef` still reflects real status ticks so seek/skip math is unchanged.

**1c. Adaptive peak count**
File: `app/(app)/audio-editor.tsx:181`
Replace the hard-coded `150` with `Math.min(400, Math.max(150, Math.floor(containerWidth / 3)))`. Requires lifting `containerWidth` out of `WaveformEditor` (or passing a `peakDensity` prop down). Disk cache auto-invalidates because `waveformCache.ts` keys on `(uri, size)`; bumping density bumps filesize, gets a fresh key. Tablet-class detail, same FFmpeg seek cost.

**1d. Prefetch adjacent-segment peaks on idle**
File: `app/(app)/audio-editor.tsx:171-194`
After peaks for `selectedIndex` resolve, `InteractionManager.runAfterInteractions(() => { extract(selectedIndex - 1); extract(selectedIndex + 1); })`. Guard against indices out of range and against already-loading/-loaded. Segment switching becomes instant.

### Step 2 — Scrub + live feedback

**2a. Live floating time readout on handle drag**
File: `src/components/TrimOverlay.tsx` — new sibling `HandleTimeBadge`
While `activeHandle.value !== 0`, render a small pill (`MM:SS.mmm`) positioned by a `useAnimatedStyle` bound to the active handle's shared value (left-align for start, right-align for end, centered above the handle, `opacity` toggled by `activeHandle.value !== 0 ? 1 : 0`). Rendered as an absolutely-positioned `Animated.Text`. The text itself needs a JS-thread update — use `useAnimatedReaction` on the active handle's SV to `runOnJS(setBadgeText)` throttled (only when the displayed millisecond actually changes). Keep font monospace-tabular so it doesn't reflow.

**2b. Drag the playhead to scrub — seek on release**
Files: `src/components/WaveformEditor.tsx`, `src/components/TrimOverlay.tsx`
Add a third `Gesture.Pan()` in `TrimOverlay` that activates **only** when the touch starts outside a ~15 dp zone of either trim handle (compose via `Gesture.Exclusive(handlePan, playheadPan, tap)` with an `onStart` guard). Behaviour:
- On start: `runOnJS(pauseForScrub)()` — records `wasPlaying` so we can restore on release.
- On update: set `currentTimeSV.value = clamp(x / cw * duration, 0, duration)`. No `seekTo` call. Audio is paused.
- On end: `runOnJS(commitScrub)(currentTimeSV.value)` which calls `seekTo(...)` and, if `wasPlaying`, resumes.
Playhead visibly follows the finger because step 1b's frame-callback is paused (we overwrite the SV directly). Clean, glitch-free, works on weak hardware because there's one `seekTo` per gesture instead of 10 per second.

**2c. Loop playback within trim region**
File: `app/(app)/audio-editor.tsx:248-273`
Convert Preview Trim from one-shot to looping. Reuse 1a's reaction — but instead of calling `stopPreview`, call `runOnJS(loopPreview)()` which does `seekTo(trimStart); play();`. While `isPreviewMode`, the "Preview Trim" button becomes "Stop Preview" (existing button, swap label + `handlePreview` becomes `togglePreview`). Matches Ableton's loop-region play.

### Step 3 — Precision + auto actions

**3a. Nudge buttons**
File: `app/(app)/audio-editor.tsx` — new row under the waveform, above playback controls
Four icon buttons: `⟪ −1s   ⟨ −100ms   100ms ⟩   1s ⟫`. Acts on "last-touched handle" tracked in a `lastActiveHandleRef` that `TrimOverlay` sets via a new `onHandleActivate` prop when pan/tap lands on a handle. Long-press repeats at 100 ms cadence (`setInterval` cleared on `onPressOut`). Each press fires `Haptics.selectionAsync().catch(() => {})` (rule 9) and writes directly to `trimStartSV`/`trimEndSV`, then `emitTrimChange` to sync React state.

**3b. Auto-trim silence — conservative -30 dBFS**
File: new `src/lib/silenceDetect.ts` (pure JS, no native) + button in `audio-editor.tsx`
```ts
// peaks are 0..1 linear amplitude; -30 dBFS ≈ 10^(-30/20) ≈ 0.0316
const THRESHOLD_LINEAR = 0.0316;
export function detectSilenceBounds(peaks: number[], duration: number) {
  const n = peaks.length;
  let first = 0, last = n - 1;
  while (first < n && peaks[first] < THRESHOLD_LINEAR) first++;
  while (last > first && peaks[last] < THRESHOLD_LINEAR) last--;
  if (first >= last) return null; // all silence; don't trim
  return {
    start: (first / n) * duration,
    end: ((last + 1) / n) * duration,
  };
}
```
UI: a "Trim Silence" button near Reset. On tap, computes bounds from cached `currentPeaks` and sets `trimStartSV`/`trimEndSV` + React state. User then sees the handles snap, reviews visually, hits Apply Trim to commit via FFmpeg. Unit-testable without native.

### Step 4 — Destructive ops with safety net

**4a. Split at playhead**
Files: `src/lib/ffmpeg.ts` (reuse `trimAudio`), `app/(app)/audio-editor.tsx`
New UI button "Split at Playhead" (disabled if playhead is within 0.5 s of either segment edge). On tap:
1. `setIsTrimming(true)`.
2. Two back-to-back `trimAudio` calls: `[0, playhead]` → `audioTempFiles.getTrimOutputPath(i, 'a')`, `[playhead, duration]` → `getTrimOutputPath(i, 'b')`. Extend `audioTempFiles` with a suffix param.
3. Replace `segments[i]` with the two new segments in-place via functional updater.
4. Invalidate peaks for both new indices; reload source for `selectedIndex` (stay on the first half); set `hasChanges = true`; push to history stack (4b).
5. `setIsTrimming(false)`; success haptic.
Enables the "cut out the middle" workflow (split → split → long-press delete middle segment).

**4b. Single-level undo / redo**
File: `app/(app)/audio-editor.tsx`
Add `historyRef: { past: Snapshot[]; future: Snapshot[] }` where `Snapshot = { segments, selectedIndex, trimStart, trimEnd }`. Push a snapshot **before** each destructive op (Apply Trim, delete segment, split, auto-trim-silence). Cap `past` at 20 entries (room for ambitious sessions without unbounded growth). New header buttons: ↶ Undo / ↷ Redo (disabled when empty). On undo, restore snapshot and push current state to `future`. Audio files referenced by past snapshots are kept alive by the existing temp-file cleanup logic since `savedResultRef` and `audioTempFiles.cleanupAll()` only run on unmount.

### Step 5 — Pinch-zoom waveform

File: `src/components/WaveformEditor.tsx`, `src/components/StaticWaveform.tsx`, `src/components/TrimOverlay.tsx`

Introduce two new shared values at `WaveformEditor` level:
- `zoomSV: SharedValue<number>` — 1 (no zoom) to 10 (10× zoom).
- `panSV: SharedValue<number>` — left edge position in **seconds** (0 ≤ panSV ≤ duration - duration/zoom).

Change the coordinate transforms in `TrimOverlay` (`onStart`, `onUpdate`, `onEnd` worklets) from `touchSec = (event.x / cw) * dur` to:
```ts
const visibleDur = durationSV.value / zoomSV.value;
const touchSec = panSV.value + (event.x / cw) * visibleDur;
```
Same transform applied to `leftDimStyle`, `rightDimStyle`, `leftHandleStyle`, `rightHandleStyle`, `topBarStyle`, `bottomBarStyle`, and `WaveformEditor`'s `playheadX`.

For the **waveform visuals**, don't re-extract peaks on zoom — extract once at `400 * 10 = 4000` density when the segment loads and render a windowed subarray per zoom/pan (slice peaks to `[first, last]` indices in `StaticWaveform`). Downside: extraction takes longer. Mitigate by extracting at `400` initially, then — if the user actually pinches — spawning a background re-extract at higher density and swapping in when ready. Meanwhile, upscale with SVG `preserveAspectRatio` stretch so initial zoom is usable, just blocky.

Add `Gesture.Pinch()` composed with existing pan + tap via `Gesture.Simultaneous(pinch, Gesture.Exclusive(handlePan, playheadPan, tap))`. Pinch's `onUpdate` writes `zoomSV.value = clamp(pinchScale * startZoom, 1, 10)` and adjusts `panSV.value` to keep the pinch focal point fixed. Add a two-finger pan (`Gesture.Pan().minPointers(2).maxPointers(2)`) for horizontal scrolling while zoomed.

Also add a "Reset Zoom" tap gesture (double-tap empty area when `zoomSV > 1`).

## Critical files

- `app/(app)/audio-editor.tsx` — screen state, history, auto-trim, split, nudge, preview loop (steps 1a, 1c, 1d, 2c, 3a, 3b, 4a, 4b)
- `src/components/WaveformEditor.tsx` — waveform + playhead composition (steps 1b consumption, 2b, 5)
- `src/components/TrimOverlay.tsx` — gestures + handle badge + nudge activation hook (steps 2a, 2b, 3a wiring, 5)
- `src/components/StaticWaveform.tsx` — SVG render windowing (step 5)
- `src/hooks/useAudioPlayback.ts` — frame-callback playhead + scrub helpers (steps 1b, 2b)
- `src/lib/ffmpeg.ts` — trim / concat primitives (step 4a reuses `trimAudio`)
- `src/lib/audioTempFiles.ts` — suffix-aware temp path (step 4a)
- `src/lib/silenceDetect.ts` (new) — pure JS (step 3b)

## Reusing existing infra

- Peak cache (`src/lib/waveformCache.ts`) — handles 1c and 5's higher peak counts for free; `(uri, size)` keying auto-invalidates.
- `audioTempFiles` (`src/lib/audioTempFiles.ts`) — 4a split outputs use the same cleanup guarantees as trim.
- `useAnimatedReaction` + `currentTimeSV` — 1a and 2c both reuse this single pattern.
- Haptics in `TrimOverlay.tsx:27-29` — reuse in 3a nudge presses. Always `.catch(() => {})` (rule 9).
- `Gesture.Exclusive` / `Gesture.Simultaneous` composition — already working in the codebase, extend without refactor.

## Verification

Test on a physical device — Pixel 10 Pro XL (serial `57171FDCQ007B1`, per `devices_testing.md`). Emulator OK for edit-only flows; upload requires physical device because emulator mic is always silent.

**Unit (new `silenceDetect.test.ts`):**
- Given `peaks = [0.01, 0.01, 0.5, 0.8, 0.5, 0.01]`, `duration = 6` → expect `{ start: 2, end: 5 }`.
- Given all-silent `peaks` → expect `null`.
- Given no silence (all > 0.0316) → expect `{ start: 0, end: duration }`.

**Manual smoke (after each step):**
1. 1a — record 30 s, trim to middle 10 s, hit Preview → playback stops within < 50 ms of the visible trim-end handle (prior: ~150 ms overshoot).
2. 1b — during playback, playhead slides continuously; visually confirm 60 Hz (no 10 Hz stepping) on device.
3. 1c — on Pixel 10 Pro XL, waveform looks markedly denser than current 150-peak build; on Galaxy A7 Lite (narrower), still renders cleanly.
4. 1d — switch between three segments; the second and third segments load without showing the loading spinner after the first has loaded.
5. 2a — drag a trim handle; floating badge tracks it with millisecond precision; disappears on release.
6. 2b — tap-drag inside the trim region but > 15 dp from either handle; playhead follows finger; audio pauses; on release, audio seeks to the new position and (if previously playing) resumes. Near a handle, the pan still grabs the handle, not the playhead.
7. 2c — enter preview; audio loops indefinitely; "Stop Preview" button ends it cleanly.
8. 3a — drag left handle, tap "+100 ms" → start advances by exactly 0.1 s; long-press repeats; then drag right handle, nudge buttons now target right handle.
9. 3b — record a clip with 8 s silence → 20 s speech → 5 s silence; tap "Trim Silence" → handles snap within ~0.5 s of speech boundaries; review and Apply.
10. 4a — play to middle, tap "Split at Playhead" → segment count doubles; each plays independently; Apply Trim on segment 1 doesn't touch segment 2.
11. 4b — Apply Trim → Undo → original segment + handle positions restored; Redo → trim reapplied. Split → Undo restores single segment. Cap check: after 20+ ops, oldest snapshot dropped without crash.
12. 5 — pinch to 3×; left edge remains around focal point; two-finger pan scrolls; drop a trim handle at zoom 3× with sub-second precision; zoom back (double-tap) → handle lands at the same absolute time. On weak hardware (Galaxy A7 Lite), pinch doesn't drop frames below ~45 fps.

**Regression checks after all steps:**
- Android back-gesture guard (`px-7` + `activeOffsetX`) still prevents accidental left-handle drag when swiping from the screen edge.
- Record → edit → submit on a physical device: FFmpeg stream-copy path unchanged, submission of trimmed audio continues to work.
- `handleSignOut` still clears editor state (`audioEditorBridge.clear()` — existing).
- `savedResultRef` behaviour: after Done, temp files from intermediate history snapshots don't leak — check `audioTempFiles.cleanupAll()` runs on unmount.
- No console.error spam on emulator (weak mic → silence detect shouldn't throw).

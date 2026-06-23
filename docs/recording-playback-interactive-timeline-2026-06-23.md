# Recording Playback — Interactive Timeline + Play/Pause (2026-06-23)

## Goal
On the completed-recording detail screen (`app/(app)/(tabs)/recordings/[id].tsx` →
`RecordingAudioPlayer`), add an interactive timeline whose playhead the user can
drag with a finger to seek anywhere, plus a play/pause button.

## What shipped
All in `src/components/RecordingAudioPlayer.tsx` (feature only, +207/−27):

- New `SeekBar` component replacing the old static progress bar.
  - Tap anywhere on the track **or** drag the thumb to scrub (single `Gesture.Pan`
    with `minDistance(0)` so a tap also seeks).
  - Fill + 16pt thumb driven on the UI thread via Reanimated worklets (60 Hz, zero JS).
  - 44pt tall transparent hit area wraps the 6pt visible track (easy grab target).
  - mm:ss label follows the finger while scrubbing, gated to ~1 update/sec.
  - `accessibilityRole="adjustable"`, label "Playback position".
- Scrub behavior wired in `ActiveAudioPlayer`:
  - `onScrubStart` pauses if playing (live playback can't race the drag).
  - Seek lands **once on release**, not per drag sample.
  - `onScrubEnd` resumes only if it was playing.
  - `handleScrub` also sets `displayTime` so a paused-track scrub label doesn't snap back.
- Play/pause button was already present and correct; now shares one `playback`
  instance + `isPlaying`/`currentTimeSV` with the SeekBar, so they stay in sync.

## Bug found by live testing (not by tsc/audit)
First build: the thumb/fill stayed frozen at 0% during playback.
Cause: the ratio was computed in a **nested** worklet (`fillRatio`) called inside
`useAnimatedStyle`. Reanimated only tracks shared-value reads in the *direct*
worklet body, so the style never recomputed.
Fix: inlined the SV reads (`durationSV`/`scrubbingSV`/`scrubProgressSV`/`currentTimeSV`)
directly into each `useAnimatedStyle` body. Playhead then tracked live.

## Verification
- Local debug build (`./gradlew :app:assembleDebug`, dev-launcher → loads JS from Metro),
  installed on emulator, signed in, opened a Completed recording.
- Confirmed live on real playing audio:
  - Play/pause toggles correctly.
  - Drag to 50% → time 3:34/7:05 (exact); drag to 90% → 6:23 (bidirectional).
  - Thumb advances with playback (3:34 → 3:58).
- `tsc --noEmit` 0 errors, `eslint` clean.

## Test notes (env)
- Installed app on the emulator was a non-debuggable release APK (v1.13.3) that
  ignores Metro — source edits never appear on it. Must build a debug/dev-client APK
  to run branch JS. Debug build loads JS from Metro live (HMR), so no rebuild per edit.
- To exercise playback past the server author/admin gate, a temporary shim pointed
  `getPlaybackUrl` at a public mp3; **reverted** after testing.
- Device 20/20 limit: revoked the emulator's stale `sdk_gphone` registration to sign in.
- See also memory: [[local-gradle-apk-build]].

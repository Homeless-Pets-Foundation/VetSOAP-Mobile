# Durable Verification + Player Seek Fix Plan

## Summary

Fix the remaining verification gaps with three small changes: make the durable verifier runnable from Railway when WSL cannot reach the public DB proxy, make durable phone test runs harder to mismatch, and make skip-ahead update the paused player UI after native load.

## Key Changes

- **Connect verifier**
  - Add `pnpm durable:verify:railway` that runs the same durable checks through `railway ssh --service api --environment production`, using the API container's internal `DATABASE_URL`.
  - Keep `pnpm durable:verify` as direct-DB mode; when direct mode gets Railway `ECONNREFUSED`, print a sanitized hint to retry `durable:verify:railway`.
  - Add optional `--run-id` and `--print-test-card` support so a tester gets one exact run card:
    - submit patient prefix: `Durable Test <run-id> Submit`
    - submit phrase: `durable pixel submit july third`
    - recovery patient prefix: `Durable Test <run-id> Recovery`
    - recovery phrase: `durable recovery pixel july third`
    - created-after timestamp in UTC
  - Do not loosen phrase matching to make old bad rows pass. Bad/missing phrases should still fail.

- **Mobile audio player**
  - In `RecordingAudioPlayer`, update `handleSeek(deltaSeconds)` to compute a clamped target, call `setDisplayTime(target)`, update `currentTimeSV.value` and `currentTimeRef.current`, then call `playback.seekTo(target)`.
  - Keep seek buttons disabled until `phase === 'ready' && duration > 0`.
  - This fixes the paused-loaded case where skip is enabled but the visible label/bar do not move.

- **Phone verification flow**
  - Use the generated test card for fresh phone rows. Do not reuse old `Durable Test 2026-07-03 ...` rows.
  - Run verifier with the generated `--run-id` and `--created-after`, preferably through `pnpm durable:verify:railway`.

## Test Plan

- **Connect**
  - Add helper tests for:
    - `--run-id` deriving prefixes/phrases.
    - test-card output omits DB URL and transcript text.
    - Railway SSH command builder uses `api`/`production` defaults and does not include secrets in argv.
    - direct DB `ECONNREFUSED` returns sanitized retry guidance.
  - Run:

    ```bash
    pnpm --filter @captivet/services test -- verify-durable-recordings
    pnpm durable:verify:railway -- --run-id "<generated-run-id>" --created-after "<UTC timestamp>"
    ```

- **Mobile**
  - Extend `tests/audio-player-duration.test.mjs` to assert `handleSeek` updates `setDisplayTime`, `currentTimeSV.value`, clamps by `duration`, and still gates `canSeek`.
  - Run:

    ```bash
    node --test tests/audio-player-duration.test.mjs
    npm run typecheck
    npm test
    npm run lint
    ```

  - Install APK on phone and verify:
    - detail screen shows total duration before playback.
    - pre-load skip/scrub stays inert.
    - after playback loads, scrub works.
    - after playback loads and is paused, skip-ahead visibly advances the label/bar.

## Assumptions

- Skip-ahead while loaded but paused is expected behavior and should be fixed now.
- Production DB verification should remain read-only and must not print transcript text or DB URLs.
- Railway SSH is the reliable path from WSL when `DATABASE_PUBLIC_URL` refuses TCP.
- Existing durable rows with missing phrases should remain failures; the fix is fresh correctly-labeled test data plus a less error-prone verifier workflow.

## Audit Status — 2026-07-03

- Fixed mobile paused skip-ahead: `handleSeek` now clamps the target, updates the visible label, updates the Reanimated shared value/ref, then calls native `seekTo`.
- Fixed Connect verifier workflow:
  - `pnpm durable:verify -- --print-test-card` prints exact run card values without DB URLs or transcript text.
  - `--run-id` derives the submit/recovery patient prefixes and phrases.
  - `pnpm durable:verify:railway` runs a read-only verifier inside Railway `api` via SSH, using the container's internal `DATABASE_URL`.
  - Direct-mode database connection failures now print a sanitized `durable:verify:railway` retry hint.
- Updated the phone-connected plan to use generated run cards and the last known USB ADB serial (`57171FDCQ007B1`) instead of stale `Durable Test 2026-07-03 ...` rows / stale wireless serial.
- Current prod evidence still does **not** pass for old rows, as intended:
  - `pnpm durable:verify -- --run-id 2026-07-03 --created-after 2026-07-03T00:00:00.000Z`
  - `pnpm durable:verify:railway -- --run-id 2026-07-03 --created-after 2026-07-03T00:00:00.000Z`
  - Both fail with submit row missing and recovery phrase missing.
- Fresh phone attempt `2026-07-03-232137Z` found one more concrete gate:
  - submit row `29013cea-967c-4705-b449-6416284ed094` reached prod, but failed because the audio file was not `.aac` and the transcript did not contain the expected phrase.
  - recovery row was not found; the crash-recovery prompt did not appear after force-stop/relaunch.
  - Conclusion: matching `versionName=1.13.7` / `versionCode=81` was insufficient proof that the forced-durable APK was installed.
- Exact forced-durable APK `captivet-durable-test-1.13.7-vc81.apk` was downloaded locally (`sha256 7de77b41973ac60cdb6b134945146ae413b4cbb42657735edb3eb98e3abdbd15`), but ADB disconnected before install. Remaining external gate: reconnect the Pixel, install that exact APK, prove the installed `base.apk` hash matches, create fresh phone recordings using a new generated test card, then verify that generated `RUN_ID`/`CREATED_AFTER`.
- Re-audit after the disconnect:
  - `pnpm durable:verify -- --run-id 2026-07-03-232137Z --created-after 2026-07-03T23:21:37.653Z` and `pnpm durable:verify:railway -- --run-id 2026-07-03-232137Z --created-after 2026-07-03T23:21:37.653Z` both reached prod and failed the same three data checks above. The WSL direct public-DB `ECONNREFUSED` condition is not reproducing in the current environment; the sanitized fallback remains for when it does.
  - `adb kill-server && adb start-server && adb devices -l` still lists no devices.
  - Windows `Get-PnpDevice -PresentOnly` has no Android/ADB/Pixel device, so the current phone gate is physical/debugging connectivity, not a WSL ADB binary mismatch.

## Audit Status — 2026-07-04

- Per owner direction, stopped using expo.dev/EAS artifacts for the phone pass and built locally through Gradle:

  ```bash
  cd /home/philgood/Projects/VetSOAP-Mobile/android
  APP_VARIANT=production EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease
  ```

- Added `EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true` support in `src/lib/durableFlag.ts`. This was needed because the current prod API response did not include `x-durable-capture-enabled`, so a stock client kept creating legacy `.m4a` rows even when the app version matched.
- Installed local APK on the Pixel via Windows ADB and proved the installed base APK hash matched the locally built artifact:
  - artifact: `/home/philgood/Projects/VetSOAP-Mobile/android/app/build/outputs/apk/release/app-release.apk`
  - sha256: `ea6ff2d16c46414906a264ecdab904539bdfaaf2f0b580bb08de800440c5aba5`
  - installed pulled base APK sha256: `ea6ff2d16c46414906a264ecdab904539bdfaaf2f0b580bb08de800440c5aba5`
- Fixed one durable/native race found during local Gradle phone testing:
  - `useAudioRecorder` now exposes the durable recording ID from the ref immediately after native start.
  - `record.tsx` skips legacy `captivet-audio-focus` monitoring while a durable recording ID is active.
  - This removed the immediate 1.3s self-interrupt after starting a durable recording.
- Fresh phone run card:
  - run id: `2026-07-04-030510Z`
  - created-after UTC: `2026-07-04T03:05:10.996Z`
  - submit patient prefix: `Durable Test 2026-07-04-030510Z Submit`
  - recovery patient prefix: `Durable Test 2026-07-04-030510Z Recovery`
- First submit attempt uploaded a valid ADTS `.aac` but failed transcription due to quiet external test audio:
  - recording id: `54779980-8472-4d1c-9d42-22c1dcf3fe1c`
  - file size: `663539`
  - parsed locally as 1697 ADTS frames, 16000 Hz mono, about `108.61s`, no trailing bytes.
- After increasing Windows TTS volume and repeating the phrases, the production Railway verifier passed end-to-end:

  ```bash
  cd /home/philgood/Projects/VetSOAP-Connect
  RAILWAY_CALLER=skill:use-railway@1.3.0 RAILWAY_AGENT_SESSION=railway-skill-20260703-durable-audit \
    pnpm durable:verify:railway -- --run-id "2026-07-04-030510Z" --created-after "2026-07-04T03:05:10.996Z"
  ```

  Output:

  ```text
  Durable recording verification passed.
  submit: 1730bf84-a552-442f-96f9-d65bafe89a7f
  recovery: d2d9968d-4652-45d6-bddf-eef9eac124d6
  ```

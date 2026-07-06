# Durable Recorder Phone-Connected Test Plan

Goal: Verify Claude's durable-recorder work end-to-end on connected Pixel 10 Pro XL.

Architecture: Use connected phone directly via ADB. First confirm/install forced-durable test APK, then run real-mic durable submit + crash recovery, then confirm prod row completes transcript/SOAP.

Tech stack: Expo SDK 55, React Native 0.83.6, Android ADB wireless debugging, Trigger.dev jobs, prod API/DB.

## Current Phone State

- Device: `Pixel 10 Pro XL`
- Last known ADB serial: `57171FDCQ007B1` (USB; wireless serial `100.77.93.50:38399` is stale)
- Android SDK: `37`
- Battery: `100%`, USB powered
- Free `/data`: `202G`
- Installed package: `com.captivet.mobile`
- Installed local Gradle app: `versionName=1.13.7`, `versionCode=1`
- Mic permission: granted
- Owner direction changed this pass: do not use expo.dev/EAS artifacts. Build and install locally through Gradle.
- Installed local APK path: `/home/philgood/Projects/VetSOAP-Mobile/android/app/build/outputs/apk/release/app-release.apk`
- Installed/local APK sha256: `ea6ff2d16c46414906a264ecdab904539bdfaaf2f0b580bb08de800440c5aba5`
- Installed base APK was pulled back from the phone and matched the same sha256.
- Final production verifier passed for run id `2026-07-04-030510Z`:
  - submit: `1730bf84-a552-442f-96f9-d65bafe89a7f`
  - recovery: `d2d9968d-4652-45d6-bddf-eef9eac124d6`

## Task 1: Verify Repos And Automated Checks

- [ ] Mobile repo:

```bash
cd /home/philgood/Projects/VetSOAP-Mobile
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor 373e2572fb611b601c6338824b129f3399751c3d HEAD
npm install --legacy-peer-deps
npm run typecheck
npm run lint
npm test
npx expo-doctor
```

Expected: all exit `0`.

- [ ] Connect repo:

```bash
cd /home/philgood/Projects/VetSOAP-Connect
git switch main
git pull --ff-only origin main
git merge-base --is-ancestor 1d4a7fdf8ef7e0d96d02056be3d67f0ac49c9dc7 HEAD
pnpm install --frozen-lockfile
pnpm --filter @captivet/jobs test -- audio-format
pnpm --filter @captivet/jobs typecheck
```

Expected: all exit `0`.

## Task 2: Build And Install Forced-Durable APK Locally

- [ ] Confirm target phone:

```bash
ADB="/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe"
SERIAL="57171FDCQ007B1"

"$ADB" -s "$SERIAL" devices -l
"$ADB" -s "$SERIAL" shell getprop ro.product.model
"$ADB" -s "$SERIAL" shell dumpsys package com.captivet.mobile | rg 'versionName|versionCode'
```

Expected: `Pixel 10 Pro XL`. If no device is listed, reconnect USB / re-enable debugging before continuing.

- [ ] Build local APK through Gradle:

```bash
cd /home/philgood/Projects/VetSOAP-Mobile/android
APP_VARIANT=production EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease
```

- [ ] Install test APK:

```bash
APK="/home/philgood/Projects/VetSOAP-Mobile/android/app/build/outputs/apk/release/app-release.apk"
"$ADB" -s "$SERIAL" install -r "$APK"
```

Expected: install succeeds.

- [ ] Prove the installed package is the exact local Gradle APK, not just a matching version/build:

```bash
EXPECTED_APK_SHA="$(sha256sum "$APK" | awk '{print $1}')"
INSTALLED_APK_PATH="$("$ADB" -s "$SERIAL" shell pm path com.captivet.mobile | tr -d '\r' | sed -n 's/^package://p' | head -n 1)"
"$ADB" -s "$SERIAL" pull "$INSTALLED_APK_PATH" /tmp/captivet-durable-test/installed-base.apk
echo "$EXPECTED_APK_SHA  $APK" | sha256sum -c -
echo "$EXPECTED_APK_SHA  /tmp/captivet-durable-test/installed-base.apk" | sha256sum -c -
```

Expected: both `sha256sum -c` commands print `OK`.

Do not accept a matching `versionName`/`versionCode` as proof of this install. The verifier must later see `.aac` audio for the generated run.

- [ ] Launch:

```bash
"$ADB" -s "$SERIAL" shell am start -n com.captivet.mobile/.MainActivity
```

Expected: app opens without native crash.

## Task 3: Real-Mic Durable Submit

- [ ] Generate one test card and keep its `RUN_ID`/`CREATED_AFTER` for both phone rows:

```bash
cd /home/philgood/Projects/VetSOAP-Connect
pnpm durable:verify -- --print-test-card
```

Expected: output includes exact submit/recovery patient prefixes, exact spoken phrases, and a `created-after UTC` timestamp. Do not reuse old `Durable Test 2026-07-03 ...` rows.

- [ ] Sign in as `empoweredpets@gmail.com`.
- [ ] Start appointment.
- [ ] Use the generated submit patient prefix.
- [ ] Record 60-90 seconds real speech, including the generated submit phrase.
- [ ] Tap `Finish`.

Expected durable v1 behavior:

- Submit card visible.
- `Edit Recording` shows `Editing Not Available`.
- `Continue Recording` blocked or unavailable for durable slot.

- [ ] Tap `Save for Later`.
- [ ] Tap `Resume Session`.
- [ ] Open Settings > Sign Out.
- [ ] Confirm sign-out warning counts at least `1` unsent recording.
- [ ] Cancel sign-out.
- [ ] Return to Record and submit.
- [ ] Wait for detail screen status `completed`.

Acceptance:

- Transcript contains unique phrase or close ASR equivalent.
- SOAP note renders.
- No duplicate `Not Submitted` card remains.

## Task 4: Crash-Recovery Durable Submit

- [ ] Start another appointment.
- [ ] Use the generated recovery patient prefix from Task 3.
- [ ] Record 30-60 seconds real speech, including the generated recovery phrase.
- [ ] Kill app while recording:

```bash
"$ADB" -s "$SERIAL" shell am force-stop com.captivet.mobile
"$ADB" -s "$SERIAL" shell am start -n com.captivet.mobile/.MainActivity
```

Expected:

- Home or Record shows `Captivet recovered an unsaved recording`.

- [ ] Tap recovery banner.
- [ ] Tap `Review & Submit`.
- [ ] Fill missing patient/client/species/appointment fields.
- [ ] Submit.
- [ ] Wait for `completed`.

Acceptance:

- Recovered audio submits.
- Transcript contains unique phrase or close ASR equivalent.
- SOAP note renders.
- Recovery card disappears after submit.

## Task 5: Prod Row Confirmation

Run the verifier with the generated `RUN_ID` and `CREATED_AFTER` from Task 3. Prefer Railway SSH because WSL may not reach Railway's public Postgres proxy:

```bash
cd /home/philgood/Projects/VetSOAP-Connect

pnpm durable:verify:railway -- --run-id "$RUN_ID" --created-after "$CREATED_AFTER"
```

Expected:

- Submit and recovery rows pass completed/audio/transcript/SOAP/phrase checks.
- Output prints recording IDs only, not DB URLs or transcript text.

## Task 6: Device Log Check

```bash
"$ADB" -s "$SERIAL" logcat -d | rg -i \
  'FATAL EXCEPTION|DurableRecorder|INVALID_AUDIO|LicenseClient|PairIP|durable_recorder_op_watchdog'
```

Expected:

- No `FATAL EXCEPTION`.
- No `INVALID_AUDIO`.
- No PairIP/licensing fatal path.
- Any durable watchdog line gets investigated before pass.

## Acceptance Criteria

- Forced-durable APK installed on connected Pixel.
- Real durable recording submits and completes.
- Crash-killed durable recording recovers, submits, and completes.
- Transcript and SOAP exist for both test rows.
- No duplicate rows/cards caused by durable draft/stash/resume.
- Mobile and Connect regression checks pass.
- iOS typecheck gate can remain existing CI evidence unless code changed during test.

## Assumptions

- Connected phone serial may be USB or wireless; trust `adb devices -l` over this document if it changes.
- Installing test APK may require uninstalling Play build, which deletes local app data; do that only after confirming no valuable local recordings remain.
- Do not delete prod test rows unless owner asks.

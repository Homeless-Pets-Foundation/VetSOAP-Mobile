# React Native / Expo SDK Upgrade — Plan

**Status: UNEXECUTED AND UNVALIDATED.** Nothing in this document has been run. It is a route map written after Dependabot PR #184 was closed for attempting the jump blind. Treat every step as a hypothesis until it is performed on a branch.

Written 2026-08-28 against `main` at SDK 55 / RN 0.83.10.

## Why #184 was closed

Dependabot proposed `react-native` 0.83.10 → **0.87.0** inside a 36-package group. It failed `Typecheck` with 15 errors. Those errors were symptoms; three things were wrong underneath:

1. **RN 0.87 is out of band for Expo SDK 55.** `CLAUDE.md` already states the rule: "Dependabot bumps past SDK compat → `npx expo install --fix`". That command would have reverted 0.87.
2. **`react-native-worklets` 0.7.4 → 0.12.1**, paired with `react-native-reanimated` 4.2.1 → 4.6.0.
3. **`expo-audio` 55.0.16 → 55.0.17 invalidates `patches/expo-audio+55.0.16.patch`.** The patch is filename-pinned to `55.0.16` and its hunks are derived from that exact Kotlin.

That third point generalises: **any** `expo-audio` bump puts the patch out of date, including a patch-level one inside SDK 55. `package-lock.json` currently pins `expo-audio` at `55.0.16` while `package.json` carries `~55.0.16`, so a lock refresh — a Dependabot bump, or an unpinned `npm install` — is all it takes to land `55.0.18` under a patch written for `55.0.16`.

**What patch-package actually does on a mismatch** (v8.0.1, verified in `node_modules/patch-package/dist/applyPatches.js`): patches are selected by package path, never by version, so a version mismatch never causes a skip.

- **Hunks still apply** → the patch **is** applied to the newer source and postinstall prints only a *version mismatch warning* (exit 0). This is the dangerous outcome: our Kotlin edits land on upstream code they were not derived from, and nothing fails.
- **Hunks no longer apply** → a patch-application error is printed. It exits non-zero only when `shouldExitWithError` — set by `CI`, `NODE_ENV=production`/`test`, or `--error-on-fail`. So EAS and our self-hosted CI hard-fail, but a plain local `npm install` prints the error and **still exits 0**, leaving `node_modules` unpatched.

Neither branch is a safe auto-disarm. Any `expo-audio` move requires regenerating the patch and re-validating it on a real Android build.

## Published versions (verified 2026-08-28 via `npm view`)

| Package | Installed | Latest in SDK 55 | Notes |
|---|---|---|---|
| `expo` | `~55.0.28` | `55.0.30` | SDK 56 → `56.0.21`, SDK 57 → `57.0.18` |
| `expo-audio` | `~55.0.16` | `55.0.18` | patch pinned to `55.0.16`; 56.x line is `56.0.13` |
| `react-native` | `0.83.10` | — | 0.84.1 / 0.85.3 / 0.86.3 / 0.87.1 published |
| `react-native-reanimated` | `4.2.1` | — | #184 proposed 4.6.0 |
| `react-native-worklets` | `0.7.4` | — | #184 proposed 0.12.1 |

**The SDK → RN mapping is not resolvable statically.** `expo`'s `peerDependencies.react-native` is `*` for every SDK major, so it tells you nothing. The only authority is installing the target `expo` on a branch, then running `npx expo install --fix` and reading what it picks. Do not copy a version number out of this table into `package.json`.

## Decide the target first

Two genuinely different projects, and they should not be conflated:

**Option A — stay on SDK 55, take the safe patches.** `expo` → `55.0.30`, the `expo-*` patch-level bumps, and the JS-only packages (Supabase, TanStack). **`@sentry/react-native` is NOT one of them** — it ships native Android and iOS code, so it drags in the production build gates and the crash-reporting check like any other native bump; it is grouped with the JS libraries in every changelog, which is exactly how it gets waved through. RN stays at `0.83.10`. Small and low risk, and it recovers most of what #184 offered — *unless* it moves `expo-audio`, which forces a patch regeneration and drags the native validation of §6 into Option A with it (see Sequencing).

**Option B — move to SDK 56 or 57.** A real migration. Everything below applies.

Option A is the recommended starting point, and it is worth doing regardless — it is a prerequisite for B and independently useful.

## Migration surface (Option B)

Ordered by what blocks what.

### 1. Resolve the target versions

`npx expo install --fix` aligns every other dependency against the **currently installed** `expo`; it does not select or install a new SDK. Starting from an SDK 55 checkout and running only `--fix` re-pins you to SDK 55. Install the target `expo` first, then align:

```bash
# 1. move the SDK itself — ONE major at a time
npx expo install expo@^56
# 2. only now align everything else to the installed SDK
npx expo install --fix
npx expo-doctor
```

**One major per branch, even when 57 is the destination.** Expo's own guidance is incremental, and 55 → 57 in a single alignment fuses two sets of native, config, and API migrations before either intermediate state has been validated — so a regression cannot be attributed to the step that caused it. Complete and validate 55 → 56 (including §6 on hardware) before starting 56 → 57.

`expo-doctor` runs before every EAS build anyway (`.claude/hooks/pre-eas-build.sh`). Its output defines the RN version — record it, and stop if it disagrees with the intended SDK. Confirm `node_modules/expo/package.json` really reports the target major before trusting anything `--fix` picked.

### 2. Regenerate both patches

| Patch | Fences | What it does |
|---|---|---|
| `patches/expo-audio+55.0.16.patch` | `tests/legacy-android-recorder-latency.test.mjs` | Parallelizes foreground-service binding with `mediaRecorder.prepare()` via `coroutineScope { async { … } }`; reorders binder assignment so the parallel `await` cannot race a null binder; enables constant-bitrate seeking for durable ADTS AAC |
| `patches/ffmpeg-kit-react-native+6.0.2.patch` | — | Overrides the AAR from `6.0-2` → `6.0-3` in the package's `gradle.properties` |

Both are filename-pinned to exact versions, but that pin is bookkeeping, not a guard: renaming a patch file without re-deriving its diff makes patch-package apply the old hunks to the new source whenever they still apply, warning but succeeding (see the patch-package behaviour above). Re-derive the diff; never just rename.

The `expo-audio` patch also requires `"expo": { "autolinking": { "android": { "buildFromSource": ["expo-audio"] } } }` in `package.json`, so the patched Kotlin compiles from source rather than a prebuilt AAR. Verify that survives.

**Check upstream first.** These patches exist because upstream lacked the fixes; a newer `expo-audio` may already carry them, in which case the patch should be dropped rather than forward-ported. Read the upstream changelog before re-deriving a diff.

### 3. Rebuild the two local native modules

Both ship committed platform source and are not covered by `expo prebuild`:

- `modules/captivet-audio-focus/` — Android Kotlin `AudioManager` focus listener; iOS is a deliberate no-op stub
- `modules/captivet-durable-recorder/` — native PCM→AAC-LC capture appending ADTS frames; the whole "never lose a recording" guarantee

Expo Modules API changes between SDK majors are the main risk — and that is exactly the surface CI does **not** cover, on either platform:

- **iOS.** `npm run ci:swift` typechecks four engine/IO files (`AdtsWriter`, `DurablePaths`, `DurableManifest`, `DurableRecorderEngine`) against `ci/durable-expo-stubs.swift`. It deliberately **excludes** `modules/captivet-durable-recorder/ios/CaptivetDurableRecorderModule.swift` — the Expo Modules entry point (`Module`/`ModuleDefinition`/`AsyncFunction`), which imports the full `ExpoModulesCore` and cannot be `swiftc -typecheck`'d without a pod install. The module file is the most exposed to an SDK-major API change and can stop compiling while `ci:swift` stays green.
- **Android.** No Kotlin gate at all.

So both platforms need a real build: `npx expo prebuild --platform ios` + `pod install` + `xcodebuild` on the Mac mini, and a production Gradle build for Android.

**Run the iOS validation with the production Google variables set.** `app.config.ts` includes the `@react-native-google-signin/google-signin` plugin *and* `plugins/with-ios-modular-headers.js` only when `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` is present. A bare local prebuild therefore never pulls in GoogleSignIn → AppCheckCore → GoogleUtilities/RecaptchaInterop — the exact pod graph that needed the modular-headers workaround in PR #90, and the one most likely to break again on an SDK major. Export the production Google environment before prebuilding, or use a production-parity `eas build --local --platform ios`. A green build without those variables has not tested the shipping pod graph.

### 4. FFmpeg

- **Android:** self-hosted Maven at `homeless-pets-foundation.github.io/ffmpeg-kit-maven`, currently `6.0-3` (16KB page size), wired via `extraMavenRepos` in `app.config.ts`.
- **iOS:** `plugins/with-ffmpeg-ios-pod-source.js` injects a `:podspec =>` URL because the trunk podspec 404s. Rebuilding the xcframework needs an Apple Silicon Mac.

Gradle or CocoaPods changes across an SDK major can break either. Neither is exercised by CI — both need a real build.

**Verify 16 KB page alignment in the ARTIFACT, not just that it built.** `app.config.ts` sets `useLegacyPackaging: false` specifically for 16 KB memory-page alignment (Android 15+), and the self-hosted FFmpeg AAR is a custom 16 KB build for the same reason. An SDK major replaces the AGP/NDK packaging stack, and losing either property produces an APK that builds, installs, and passes every check on an ordinary 4 KB-page device while failing to load on 16 KB-page hardware — and Play can reject it. After building, inspect the artifact — with complete operands, or the commands just fail and the check gets skipped while looking done:

```bash
# ZIP: .so entries uncompressed and 16 KB-page aligned. -P is the page size in
# KiB; the trailing 4 is zipalign's own alignment argument, and both are
# required in check mode.
zipalign -c -P 16 -v 4 android/app/build/outputs/apk/release/app-release.apk

# ELF: every LOAD segment aligned to 0x4000 (16 KB), not 0x1000.
#
# Every step below that CANNOT run has to fail loudly. A check of this shape
# has three ways to report success while inspecting nothing at all -- a missing
# llvm-readelf, an extract that produced no .so, and a readelf output the awk
# no longer matches -- and each one leaves `bad=0` and exits 0. Guard all three
# explicitly; the release gate is worthless otherwise.
set -o pipefail   # without this, a failing llvm-readelf is masked by sort's exit 0
# llvm-readelf specifically, and do NOT substitute GNU readelf: it wraps each
# program header onto TWO lines, so `$NF` on the LOAD line is an ADDRESS, not
# the alignment. Measured on an ordinary 4 KB library that reports align 0x1000,
# GNU readelf yields 0x14000 for the same segment -- which passes this gate.
command -v llvm-readelf >/dev/null 2>&1 || { echo "FAIL: llvm-readelf not installed"; exit 1; }

APK=android/app/build/outputs/apk/release/app-release.apk
rm -rf /tmp/apk-libs
unzip -o -q "$APK" 'lib/*/*.so' -d /tmp/apk-libs || { echo "FAIL: could not extract libs from $APK"; exit 1; }
mapfile -t sos < <(find /tmp/apk-libs -type f -name '*.so')   # every packaged ABI, not just arm64
# Zero libraries is a FAILURE, not a pass: an unmatched glob would otherwise
# skip the whole loop and report a clean 16 KB artifact.
[ "${#sos[@]}" -gt 0 ] || { echo "FAIL: no packaged .so found in $APK"; exit 1; }

bad=0
for so in "${sos[@]}"; do
  aligns=$(llvm-readelf -l "$so" | awk '$1 == "LOAD" {print $NF}' | sort -u) \
    || { echo "FAIL: llvm-readelf could not read $so"; bad=1; continue; }
  # No parsed LOAD row is also a failure: a readelf format change that stops
  # matching would silently approve every library in the APK.
  [ -n "$aligns" ] || { echo "FAIL: no LOAD segment parsed from $so"; bad=1; continue; }
  for align in $aligns; do
    n=$((align))
    # A segment alignment is always a power of two. Anything else means the
    # column being read is not the alignment at all (see the readelf note
    # above) -- fail rather than compare a misparsed number against 16384.
    if [ "$n" -le 0 ] || [ $(( n & (n - 1) )) -ne 0 ]; then
      echo "FAIL: $so parsed a non-power-of-two LOAD align ($align) -- wrong column?"; bad=1; continue
    fi
    # Must be >= 0x4000. Printing the value is not a gate: a 0x1000 library
    # would sail through with sort's exit status and fail only on real 16 KB
    # hardware, or at Play review.
    if [ "$n" -lt 16384 ]; then
      echo "FAIL 16 KB alignment: $so has LOAD align $align"; bad=1
    fi
  done
done
[ "$bad" -eq 0 ] || exit 1
echo "OK: ${#sos[@]} libraries inspected, every LOAD segment >= 16 KB aligned"
```

**Both commands above inspect the APK, which is NOT what Play distributes.** The `production` profile builds an **AAB**; Play regenerates per-ABI split APKs from it, and the packaging that produces those splits is exactly what an AGP or NDK migration changes. A locally assembled APK can therefore pass both gates while the artifact users install is 4 KB-aligned. Build the bundle too and inspect what comes out of it:

```bash
# Subshell: `cd android` in the current shell would make every repo-relative
# path below resolve under android/android/ and bundletool would find nothing.
(cd android && APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:bundleRelease)
AAB=android/app/build/outputs/bundle/release/app-release.aab
[ -f "$AAB" ] || { echo "FAIL: no bundle at $AAB"; exit 1; }

# Generate the SPLIT set Play distributes -- bundletool's DEFAULT mode. Do NOT
# pass --mode=universal: that emits one fat APK carrying every ABI, which no
# device ever installs, so a split-packaging alignment regression passes a gate
# that never looked at a split.
rm -rf /tmp/app.apks /tmp/apks
bundletool build-apks --bundle="$AAB" --output=/tmp/app.apks
unzip -o -q /tmp/app.apks -d /tmp/apks
mapfile -t splits < <(find /tmp/apks/splits -type f -name '*.apk')
[ "${#splits[@]}" -gt 0 ] || { echo "FAIL: no split APKs generated from $AAB"; exit 1; }
```

Re-run both the `zipalign -c -P 16 -v 4` check and the ELF loop against every APK in `${splits[@]}` — the per-ABI splits are where the `.so` entries live, so an inspection that skips them inspects nothing that matters. Approve 16 KB compatibility only once the BUNDLE-derived splits pass; the standalone APK passing is necessary, not sufficient.

Then run the recording and editor checks on a 16 KB-page device or emulator image.

**The oversized-split path is a second FFmpeg gate.** A legacy `.m4a` over 250 MB goes through `maybeSplitForUpload()` / `splitAudioBySize()` at Submit — a different FFmpeg command, plus output enumeration and FileSystem metadata reads — and waveform rendering and trimming can all work while that fails. A short upload then passes every listed gate while a long appointment is unuploadable. Submit an oversized fallback recording on both platforms and verify every generated part uploads.

**A build is not the FFmpeg gate; the editor is.** Nothing in §6 invokes `src/lib/ffmpeg.ts`, and `app/(app)/audio-editor.tsx` depends on that bridge for waveform peak extraction and trim/concat. A bridge signature or codec incompatibility compiles, links, and passes the playback-seeking check while making editing fail on device. Add to the hardware list: open a recording in the editor, confirm the waveform renders, apply a trim, and play back the result — on both platforms.

### 4b. Verify the GENERATED manifests, not just that they build

A green Gradle/Xcode build proves the projects compile, not that config-plugin output still carries our hardening. These live in `app.config.ts` and are produced by plugins, so an SDK-major plugin change can drop or alter them while both builds stay green:

- `expo-build-properties` → Android `usesCleartextTraffic: IS_DEV` (false in production) and `allowBackup: false`
- the `blockedPermissions` list (storage, location, camera, media)
- iOS background-audio mode and the microphone usage description
- the production iOS `NSAppTransportSecurity` dictionary — `NSAllowsArbitraryLoads: false` and `NSAllowsLocalNetworking: false`. The Android cleartext policy is asserted above; its iOS counterpart is just as plugin-generated and just as silently droppable.

After prebuild, read the generated `android/app/src/main/AndroidManifest.xml` and `ios/*/Info.plist` and assert each one is still present and still has the production value. Diff them against the previous SDK's generated output — that diff is the real review surface of an SDK upgrade.

**Assert the supported-OS floors in the same pass.** `app.config.ts` requests Android `minSdkVersion: 24` (required by ffmpeg-kit) and iOS `deploymentTarget: '15.1'`. An Expo/RN/`expo-build-properties` major can raise either, and every build you run will be on modern hardware, so the release silently stops installing on older clinic devices while all checks stay green. Read the effective `minSdkVersion` out of the generated Gradle config and `IPHONEOS_DEPLOYMENT_TARGET` out of the Xcode project, compare them to those two numbers, and either hold the floors or get the compatibility drop explicitly approved and communicated.

### 5. Expect the #184 typecheck errors

15 errors, already catalogued, in three families:

- `Module '"react-native"' has no exported member 'InteractionManager'` — `record.tsx`, `audio-editor.tsx`
- ScrollView/View ref retyping — `PatientTabStrip.tsx`, `recordings/[id].tsx`, `WaveformEditor.tsx`
- `TextInput` ref typing — `src/components/ui/Text.tsx`, `login.tsx`

`ui/Text.tsx` is the sensitive one: it is the single file allowed to import `Text`/`TextInput` from `react-native`, and `font-scaling-guard` fences that. Fix the types without weakening the guard.

**And do not take the guard's word for it on device.** This repo has already lived the failure it is meant to prevent: the guard stayed green while the declared 1.3× cap silently did nothing, because the monkey-patch it relied on never ran — OS text scaled to a measured 3.58×. An RN upgrade that changes `Text`/`TextInput` prop forwarding can reproduce exactly that. On the candidate, set the OS text size to maximum AND turn on Android "Bold text" (`settings put secure font_weight_adjustment 300`, force-stopping between), then walk login, the record screen, and the submit controls: the cap must bind, and no control may be pushed off-screen or have a word vanish (CLAUDE.md > UI Gotchas).

### 6. Device testing — not optional

`npm run ci` cannot validate this. Required on real hardware:

**Recording**

- **The first-run microphone prompt, on a clean install.** Every other check here runs on a device that already granted access to the released build, so they all sail past `PermissionGate` and never invoke the upgraded `requestRecordingPermissionsAsync()` bridge — and revoking access in system settings does not reproduce a first RUN either. A candidate that fails to present or process the native prompt leaves every NEW user unable to record while this whole suite passes. Reset permissions (or install clean) on both platforms and take the prompt through grant AND deny.
- Durable recording across process death, plus crash recovery
- **The post-confirm tombstone.** A successful durable upload does not test it: it is written AFTER the draft delete and the native purge, through the chunked SecureStore bridge. If that write is dropped, a later offline restart or re-sign-in meets stale draft metadata with no proof its row was already confirmed — and recovery either re-offers the recording or deletes the just-uploaded server row. Complete a durable upload, then confirm the tombstone exists and that an offline relaunch neither re-offers it nor deletes the row.
- **Process death BETWEEN the R2 PUT and the confirm.** The capture-time kill above and the upgrade-in-place case (which only reads a `pendingConfirm` the OLD binary wrote) both leave this untested: neither proves the CANDIDATE persists the post-PUT proof before it calls confirm. If the upgraded SecureStore, FileSystem, or durable bridge loses or delays that write, a kill or a dropped network after the PUT strands uploaded bytes in R2 with a recording that cannot resume safely — while every successful upload passes. Block or cut the network at the confirm request, kill the app, relaunch, and confirm the recording resumes to a confirm-only completion rather than re-uploading or dead-ending.
- **Resume → Continue on a recovered capture**, which is the only thing that exercises the native `resume()` entry point: `useAudioRecorder.resumeDurable()` reloads the manifest, reattaches ownership and timing state, and appends new ADTS frames to the existing `audio.aac`. Recovering and submitting as-is does not touch it, so this path can fail — or desynchronize the recovered duration — while process-death recovery and fresh recordings both pass. Kill a capture, recover it, continue recording, then verify the final duration and that BOTH halves are audible.
- **A timed capture through backgrounding AND screen lock, on both platforms — run TWICE, with durable capture forced on and forced off** (`EXPO_PUBLIC_FORCE_DURABLE_CAPTURE`, and with the server flag off). **The forced build is test-only and must never leave the bench:** that flag bypasses the server-driven safety gate permanently, so if the artifact were later shipped while ADTS acceptance is not deployed, uploads confirm and purge locally before server validation fails — stranding recordings in R2 (see `durableFlag.ts`'s cross-repo invariant). Point it at a backend that accepts ADTS, label it, delete it afterwards, and rebuild the releasable candidate WITHOUT the flag. `useAudioRecorder.start()` falls back to expo-audio whenever the flag is off or the native module is unavailable, and that fallback's own background-audio implementation is moving in this migration — so it can stop capturing under lock while the durable run and the iOS interruption test both pass. — start recording, background the app, lock the device, wait a measured interval, return, finish, and verify the resulting file's duration and audible content match the wall-clock time. This depends on the Android microphone foreground service plus its notification/wake-lock permissions and on iOS background audio / `AVAudioSession`, all of which move between SDK majors. A regression here loses audio during an ordinary appointment without crashing and without failing crash-recovery, so nothing else on this list catches it.
> **Which BACKEND is active decides what these interruption tests prove.** With durable capture on, `DurableRecorderEngine` owns its own `AudioManager` focus listener and `record.tsx` ignores `captivet-audio-focus`'s events entirely; with it off, expo-audio's `stop()`/`pause()`/`record()` cleanup is what runs. So each case below has to be run in the mode that actually reaches the code it names — a pass in the other mode says nothing.

- **Input route lost mid-capture on iOS** — unplug a wired mic or power off a Bluetooth one while recording. This is a SEPARATE native path from a call or alarm: `DurableRecorderEngine.handleRouteChange()` observes `AVAudioSession.routeChangeNotification` and treats `.oldDeviceUnavailable` as fatal, flushing the writer, persisting `route_change`, and notifying JS. If that observer or its bridge regresses during the native rebuild, the UI can sit in `recording` with no input and silently lose the rest of the appointment while every call/alarm test passes.
- **A native durable `start()` REJECTION with the flag on.** The flag-off run exercises expo-audio as the chosen backend; it does not exercise the exception path, where the module loads but `start()` fails (foreground-service promotion, audio-session setup) and `useAudioRecorder` must fall back to expo-audio mid-attempt. Both listed runs can pass while every affected production device simply cannot begin an appointment. Inject the failure with the flag on and confirm recording still starts.
- **iOS media-services reset.** `RecordingStatus.mediaServicesDidReset` takes its own branch ahead of the ordinary `hasError` flow, because the recorder handle is permanently invalid — nothing else on this list produces that signal. Induce a media-services reset mid-capture (or simulate the status) and confirm the partial audio is kept and the hook recovers rather than sticking.
- Audio focus interruption (call / alarm / other voice app) on **Android — in BOTH capture modes.** Flag OFF exercises `modules/captivet-audio-focus` feeding `triggerInterruption()`; flag ON exercises the durable engine's OWN focus listener, which `record.tsx` defers to. Passing the fallback case says nothing about whether the rebuilt durable module still hears a call, and a deaf durable listener silently loses the rest of the appointment.
- **The same interruption on iOS**, where that module is a deliberate no-op and recovery depends entirely on expo-audio surfacing the `AVAudioSession` interruption as `hasError` — an SDK-sensitive path that neither the process-death test nor the background/lock test triggers. **The two capture modes have different contracts, so assert them separately:**
  - *Durable capture:* `audio.aac` is already saved and marked interrupted natively, and v1 deliberately does NOT auto-resume-append. The correct behaviour is a silent finalize into a submittable durable draft, with the interruption notice shown — `interruptionPendingResume` is never armed and the iOS engine emits no gain event. Verify the draft exists, carries the full pre-interruption audio, and submits.
  - *expo-audio fallback:* the partial segment is committed via `CONTINUE_RECORDING`, `interruptionPendingResume` is armed, and the AppState `'active'` handler resumes. Verify the resume happens and the segments concatenate.
  - Requiring "resumes on gain" of the durable path would reject correct behaviour, or worse, invite an unsafe auto-resume.
- Recorder start latency — the `expo-audio` patch exists to keep it low; `measurePhase` warns above `NATIVE_RECORDER_PHASE_WARNING_MS` (1000 ms)
- Playback seeking on durable ADTS AAC files
- **Playback of a PROCESSED SERVER recording, including a multipart one, on both platforms.** The durable check above plays a LOCAL file; every recording a clinician actually opens from the Recordings list takes a different path — `RecordingAudioPlayer.startLoadingAudio()` calls `/audio/playback`, then hands the returned REMOTE segment URL to `expo-audio` via `player.replace({ uri })`, and a multipart recording additionally switches between ordered segment URLs mid-playback (`loadSegment`, plus the one-shot URL refresh when a presigned link has expired). None of that is reachable from a local ADTS file. A candidate can pass the durable check while every stored appointment in the practice is unplayable. Play and seek a processed single-segment recording and a processed MULTIPART recording, and confirm the segment switch and the load/seek watchdogs still bound a stalled remote load rather than hanging on the spinner.
- **Microphone permission revoked mid-capture**, on both platforms, **with durable capture forced OFF** — the durable backend's pause/resume/stop branches return before touching expo-audio, so with the flag on this never reaches the `recorder.stop()` / `pause()` / `record()` cleanup the rule is about. Start recording, revoke access in system settings, return to the app. `useAudioRecorder` is required to survive this (CLAUDE.md rule 6) — `stop()` swallows and cleans up, `pause()`/`resume()` clean up and rethrow — and no other check on this list produces a native op failing under the recorder. Verify the partial audio is retained, the hook is not left stuck in `recording`, then re-grant access and start a fresh recording in the same session.
- **Multi-patient recorder ownership, with at least two slots.** Every other check here uses one patient, but this migration moves the scrolling/ref APIs and Reanimated/worklets that the pageable patient cards are built on, and the single-recorder handoff is timing-dependent (`recorderBoundToSlotId`, the `pendingStartSlotRef` queue, auto-pause on swipe-away). The Node tests only read that control flow as source. A regression here attaches one patient's exam audio to another patient's slot — a clinical-correctness failure, not a UX one. Start capture on patient A, switch to B while the pause/stop is still in flight, record B, and confirm each segment and each upload lands only on its intended slot.

**Offline → online, without restarting the flow** — an SDK bump rebuilds `@react-native-community/netinfo` against the new RN. Every other check here runs online, and an offline Finish stays `pendingSync` until `usePendingDraftSync` sees reachability, so a bridge that stops emitting usable events compiles, passes every fresh-online submit, and leaves drafts permanently unsynced. Finish a recording in airplane mode, re-enable the network WITHOUT restarting the app or the workflow, and confirm the existing draft SYNCS — `usePendingDraftSync` creates the server row with `isDraft: true` and clears `pendingSync`, and that is all it should do. The card must still read **Not Submitted**, and the upload and promotion must still require the vet's own Submit. "Submits on its own" would be the wrong gate to write down: it fails correct behaviour and invites an automatic clinical submission nobody reviewed.

**Then fail the anchor write, which the healthy reconnect never reaches.** The interesting boundary is not the network — it is the moment AFTER the server row exists, when `updateServerDraftId()` persists `serverDraftId` and clears `pendingSync` through the upgraded SecureStore bridge. If that write throws or reports success while reading back wrong, the outcome is decided entirely by which of its five results the caller sees: `'persist_failed'` must leave the local draft pending and the server row ALONE, because the row is real and the next sync re-anchors it through the deterministic `durable-${recordingId}` idempotency key. Only proven absence (`'no_local_meta'`) may delete a server row — a bridge that starts collapsing "unreadable" into "absent" turns this recovery into the client deleting a clinical recording it just created. Inject a failure into that first anchor write, then reconnect (and separately, relaunch) and confirm: EXACTLY ONE server row exists, the local draft is still resumable and submittable, and submitting promotes that same row rather than creating a second.

**Upload wake-lock past the screen timeout** — `acquireKeepAwakeLease()` deliberately swallows native activation failures, and `expo-keep-awake` moves transitively with Expo. A short emulator upload passes with the screen on, while a clinic-sized upload dies once the normal Android screen timeout lets Doze reap the socket. Run an upload longer than the device's configured screen/idle timeout on **both** platforms — `acquireKeepAwakeLease()` is the same cross-platform bridge and swallows activation failures either way, so an iOS-only regression lets an iPad suspend an in-flight clinic-sized upload while an Android-only check stays green. Confirm the screen stays awake, the upload completes, and normal timeout behaviour returns afterwards.

**Auth, storage and device identity** — the Node tests mock every one of these bridges, and compiling proves nothing about them. An SDK major moves `expo-secure-store`, `expo-crypto`, `expo-local-authentication`, and the social-auth modules underneath:

- Cold-start session restoration after a real app kill (SecureStore round-trip, including the read-back verification in `src/auth/supabase.ts`)
- **The same cold start with `/auth/me` UNREACHABLE.** `userProfileCache` exists so a vet keeps access to on-device drafts through an API outage, and it is what configures the user-scoped stores at startup; the offline→online case above begins inside an already-running session and never proves this. Kill the app, block the API, launch: the last-known-good profile must restore, the drafts and saved sessions must be there, and the stores must be scoped (not empty).
- **Refresh-token ROTATION and involuntary `SIGNED_OUT` recovery**, which a cold start with an already-valid session never touches. Rules 16 and 17 exist because the old refresh token is invalidated server-side the moment rotation succeeds: if the rotated one is not persisted (or is persisted unverified), the next refresh fails and the user is logged out despite everything having worked. Force an expiry so a rotation actually happens, kill the app, and confirm the ROTATED session restores; then induce one transient refresh failure and confirm `onAuthStateChange` recovers via `refreshSession()` instead of clearing the session. **Rotating against a HEALTHY store is not enough** — on ordinary hardware the first write succeeds, so it reaches neither of the adapter's two recovery paths in `src/auth/supabase.ts`: the `readback_mismatch` branch (the write reports success but reads back missing or different) and the throw branch (1.5 s wait, then one retry). A Supabase or SecureStore migration can break either while this rotation-and-relaunch check stays green, and the users it logs out are the ones whose Keystore is already marginal. Inject a first-write failure and, separately, a read-back mismatch; in each case rotate the token, kill the app, and confirm the RETRIED write is what restores the rotated session.
- **Foreground resume with an EXPIRED token.** The rotation check above can be completed with the app active, which never reaches `AuthProvider`'s AppState-resume handler — the one that must read the CURRENT persisted session rather than a render-time closure before deciding to refresh (rule 18). Background the app until the access token expires, return, and confirm it refreshes before issuing requests instead of firing an expired token and driving an avoidable sign-out.
- **Sign out of a GOOGLE session specifically, then switch accounts.** `signOutNativeGoogle()` calls `GoogleSignin.hasPreviousSignIn()` and `GoogleSignin.signOut()` in the upgraded native package, and the password sign-out test returns early there because it has no previous Google session — so nothing else exercises it. If that native cleanup regresses on a shared tablet, user B is silently handed back A's Google identity. Sign in as A with Google, sign out, then sign in as B and confirm the account chooser appears and B's own profile loads.
- **Sign out, then sign in again without restarting the app.** This is a different failure from an ordinary password sign-in: GoTrue's auto-refresh timer leaves a stale `AbortController` after `signOut()`, so the first `signInWithPassword()` rejects instantly with `AuthRetryableFetchError` (rule 22). A Supabase bump can regress the single-retry workaround while every fresh sign-in passes, leaving an iOS user who signs out unable to get back in.
- Device registration: confirm `X-Device-Id` is present on requests and that `getDeviceId()` still returns a stable UUID (Rule 21 — Hermes has no `globalThis.crypto` on iOS)
- **Automatic re-registration after a 428.** Registration succeeding on sign-in does not exercise `ApiClient`'s `DEVICE_REGISTRATION_REQUIRED` path, which has to invoke `onDeviceRegistrationRequired`, register, and REPLAY the original request exactly once. If that callback or the replay regresses, every `/api/*` call sticks on 428 while sign-in and the header check both pass. Delete the active device-session row server-side after signing in, make a request, and confirm it self-heals with no user-visible failure.
- **Server-driven revocation.** Registration succeeding proves nothing about it: `DEVICE_REVOKED` has to be recognised in `ApiClient` BEFORE the token refresh path and then drive an async sign-out and cache clear, and upgraded fetch/auth behaviour can break that callback while sign-in and the UUID check still pass — leaving a revoked shared tablet sitting on an authenticated UI full of cached PHI. Revoke the candidate from another admin session, make any request, and verify it signs out immediately and the query cache is gone.
- Device TYPE, not just the id (Rule 23): `registerDevice()` reads `Device.deviceType` on Android and `Platform.isPad` on iOS, and an unavailable or renamed Android enum silently falls back to `android_tablet`. Register a representative phone and tablet on each platform and confirm the server and the Devices screen show `ios_phone` / `ios_tablet` / `android_phone` / `android_tablet` correctly — a mislabelled device is what an admin revokes by
- Biometric unlock through `AppLockGuard`, including a cancelled prompt — **at cold start AND on background resume**. The resume path is the one at risk: it depends on RN's `AppState` ordering to lock synchronously before the current screen renders, so an upgraded runtime that delivers the event late briefly exposes whatever PHI-bearing screen was open. A cold-start-only check passes right through that. Background from a recording or SOAP screen for longer than the 30-second threshold, return, and confirm nothing flashes before the prompt, that cancelling leaves the app locked, and that unlocking returns to the same screen. **Then background again and inject a bridge call that never settles** (a stalled Keystore or local-authentication prompt after an OS update — a hang, not a cancellation, which the check above cannot produce). **This gap is now closed — verify the fix, not the absence.** Both biometric paths are bounded (CLAUDE.md rule 24, `src/lib/appLockPolicy.ts`): the availability probe fails OPEN at 7 s and the prompt fails CLOSED at 60 s, with 12 s coarse watchdogs behind each. Use `armAppLockHang('resume:prompt')` — a `__DEV__`-only one-shot injector — to produce a real hang, because cancelling a prompt cannot. Expected: the app STAYS LOCKED, the spinner clears, the lock screen shows the sensor hint, **Unlock retries and Sign Out both work**, and `applock_resume_watchdog_fired` reaches Sentry. Then arm the cold-start prompt and confirm the app does NOT unlock itself behind a live prompt. A candidate that instead strands the user with a dead Unlock button, or that auto-unlocks a PHI screen on the timer, is a release blocker either way.
- Email/password sign-in, plus Google on **both** platforms and Apple on iOS. iOS Google is a real path — `socialAuth.ts` requires both Google client IDs and `app.config.ts` installs the iOS URL-scheme plugin — and it is the one most exposed here, since the migration moves the GoogleSignIn pods and the AppCheckCore graph behind `with-ios-modular-headers.js`. A green pod build and a working Apple login say nothing about the iOS OAuth redirect or the ID-token exchange.
- **A never-before-seen social account.** An existing-account Google or Apple login skips the bootstrap entirely: `/auth/me` returns 404, Apple's profile metadata has to be awaited, and `/auth/register` creates the application profile BEFORE device registration. A Supabase or native-auth migration can break that ordering while every provider login above passes — and the symptom is a brand-new authorized user being signed straight back out.
- **First-time MFA ENROLLMENT, not just a challenge**: enrollment and enrollment-verification are distinct routes, and the QR renders through `react-native-qrcode-svg` on the upgraded native SVG renderer. Force a fresh enrolment (including a setup approval code where the org requires one), scan the TOTP QR, verify, then sign out and come back through the ordinary challenge. Every account newly required to enrol depends on this path, and the challenge-only check says nothing about it.
- **An enforced-MFA account end to end**: sign in, land on `MFA_REQUIRED`, complete the challenge, and confirm the profile loads.
- **MFA step-up from an ALREADY-AUTHENTICATED request**: a separate `ApiClient` path recognises a protected endpoint's `403 MFA_REQUIRED` and invokes `setOnMfaRequired`. It can regress while sign-in-time MFA and enrolment both pass, leaving stale sessions denied over and over with no reachable challenge. Age an AAL2 session past the policy window, hit a protected endpoint, and confirm the challenge appears and the request succeeds afterwards. The MFA path derives its access and refresh tokens from the Supabase session and only finishes after verification, so an ordinary sign-in can pass while every enforced-MFA user is locked out.

**Gates that fail OPEN** — three checks deliberately allow the operation when their native bridge returns nothing, which is right for resilience and means an SDK incompatibility disables them silently, with CI and both builds green:

- **Minimum app version** (`src/lib/minVersion.ts`, `expo-application`): `getRecordStartGate()` fails open when `getCurrentAppVersion()` is null. On the production candidate, confirm the native marketing version reads correctly, then confirm a floor above it blocks Start and Resume→Continue while leaving existing recordings submittable. **Do NOT raise the shared production floor to do this** — every released client, and the candidate itself, would go below-floor and stop recording for as long as the test runs. Use a staging backend, an account- or device-scoped override, or inject the response locally. This one is cross-repo — a below-floor client starting durable captures the coordinated server deploy no longer accepts is exactly what the floor exists to prevent.
- **Low disk** (`src/lib/freeSpace.ts`, `expo-file-system`): `checkPreRecordFreeSpace()` treats zero, a missing property, or a bridge failure as unknown and allows recording. Every other check here runs with ordinary free space. Fill the device to exercise the 250 MiB block and the 500 MiB warning, and confirm a normal-space device is still allowed. **That is only the JS pre-record gate.** The WHILE-RECORDING limits are native on purpose (a JS poll can be starved or backgrounded): both rebuilt engines poll storage during capture and must stop gracefully below 100 MiB and before the AAC crosses the 225/240 MB source caps. Start above the threshold and cross each limit mid-capture on both platforms — a regression in that loop passes the pre-record test while filling the filesystem or producing an unuploadable appointment.
- **SOAP PDF export** (`src/lib/share.ts`, `expo-print` + `expo-sharing`): `tests/soap-pdf.test.mjs` only confirms the modules are lazy-required, and compiling proves nothing about `printToFileAsync()` or `shareAsync()` at runtime. Both packages move with the `expo-*` patch bumps Option A advertises. Generate a SOAP PDF and share it on both platforms whenever either package changes.
- **Sensitive clipboard** (`src/lib/secureClipboard.ts`, `expo-clipboard`): `copyWithAutoClear()` / `clearClipboard()` hold MFA enrolment secrets, SOAP notes, transcripts, and client data, and the tests only confirm callers reference the helper. On a changed or unavailable bridge that content can outlive its 30-second timeout on a shared clinic tablet. Copy sensitive text and verify the timeout, backgrounding, and sign-out triggers each clear it, on both platforms.

**Cross-user isolation — the query cache AND every local recording store.** Two separate mechanisms, and the migration touches both:

- `queryClient.clear()` on sign-out is the PHI-isolation guarantee for server data, and `queryPersistence.ts` depends on the installed `persistQueryClient` tuple, its restore timing, and throttled writes. `tests/query-persistence-guard.test.mjs` only reads source.
- Drafts, stashes, recovery intents, durable manifests and their audio are isolated by per-user SCOPING, not by wiping (rule 8), and every one of those stores is armed asynchronously from `AuthProvider.fetchUser()` via `setUserId`. SecureStore, FileSystem, and Supabase restoration timing all move in this migration, and the upgrade-in-place test below only ever exercises ONE user — so a store still holding user A's scope when user B signs in would go unnoticed, and on a shared clinic tablet that means B seeing, submitting, or deleting A's clinical audio.

Switch accounts on a real device WHILE a restore or a cleanup is still pending. **The two halves have OPPOSITE expectations, and conflating them destroys un-sent work:**

- *Query cache (server data):* none of A's queries may hydrate into B's session, and nothing of A's may remain in the persisted cache — `queryClient.clear()` is supposed to have wiped it. **Prove the positive half too**, or an implementation that never persists anything passes the isolation check trivially: seed A's recordings and detail queries, kill the app, relaunch OFFLINE as A, and confirm the allowlisted clinical lists come back from the persisted cache.
- *Local recordings:* A's drafts, stashes, recovery intents, manifests and audio must **remain on disk**, untouched and merely inaccessible under B's scope. Rule 8 preserves them across every logout deliberately; asserting they are gone would re-create the "Lela bug", where an involuntary logout destroyed an un-uploaded recording. What must be true is that B's Record tab, draft list, saved sessions, and recovery screen show none of A's work — not that the bytes were deleted.

Then sign back in as A and confirm every item is still there and still submittable.

**Run the switch once more with A as `support_staff`.** That role's sign-out additionally runs `preserveSupportStaffRecordings()`, copying drafts, stashes and durable audio into the owner/admin/vet recovery vault — a whole extra SecureStore/FileSystem transaction the ordinary switch cannot reach, since support staff cannot submit the work in the final step. A compatibility failure there either blocks the sign-out (`SignOutRecoveryMode` 'required') or lets it complete with nothing copied; verify the vault receives the work and that `recording-recovery` can restore it as an owner.

**Upgrade-in-place, with pre-existing work** — every check above creates its data under the new build, but real users install over SDK 55 with drafts, stashes, recovery intents, and durable manifests already on disk. The migration moves both `expo-secure-store` and `expo-file-system`, so a path, accessibility-class, or serialization change can make that work vanish while fresh recordings and crash recovery both pass:

**The two builds must share a signing identity, or step 2 cannot happen at all.** A store-installed SDK-55 app is signed by Play/App Store; the local `expo prebuild` + `assembleRelease` candidate is not, and Android refuses the replacement outright (iOS has the same constraint). Do not let that turn this gate into a clean install — a clean install tests nothing here. Either ship the candidate through an internal track (Play internal testing / TestFlight) so the identities match, or seed the "released" side with a build signed by the same test key as the candidate.

1. On the **released SDK-55 binary** (see the signing note above), seed one of each: an un-sent draft, a saved session (stash) that was **created from a server-backed draft** so its payload carries a real `serverDraftId` (rule 20 — a generic stash has none, and then this step proves nothing), a durable capture killed mid-recording, a draft with a `pendingConfirm`, and a `RECOVERY_INTENT` pointing at a known draft (background the app mid-recording to create one). Record that stash's server recording id. The intent matters on its own: if the SecureStore upgrade drops or corrupts only that record, every other item still reappears and submits from its normal list while startup silently stops offering or routing to the interrupted draft. Record the device UUID and its server device row now — see below.
2. Install the candidate build **over it, without clearing app data**.
3. Relaunch **offline** the first time, with `/auth/me` blocked. The offline cold-start check above builds its profile cache under the CANDIDATE; only this proves the candidate can read the one the RELEASED build wrote (`captivet_profile_cache` is stored separately from the Supabase session, so it can survive or fail independently). Sign in on the released build in step 1 so that cache exists. If it cannot be read, an offline clinician cannot configure the user-scoped stores and cannot reach any of the work this gate is otherwise about to verify.
4. Verify the vet is **still signed in** — do not reauthenticate to get past this step. The cold-start check above only ever restores a session the CANDIDATE wrote; if the SecureStore or Supabase persistence format changed, a candidate that cannot read the SDK-55 access/refresh pair logs every upgrading user out, and an offline clinician then cannot reach their own user-scoped local work at all. Signing in again would hide exactly that.
4. Verify every item reappears, still carries its metadata, and is still submittable. For the stash specifically, assert Resume → Submit **PROMOTES the recorded server id** rather than creating a new one: if the migration drops `serverDraftId` during SecureStore/FileSystem restoration the stash still restores and still submits successfully — it just leaves a duplicate clinical record behind, which is the one failure mode here that looks like success.
4. Verify the **biometric app-lock preference survived**. Enable it on the released build in step 1. `biometrics.isEnabled()` reads its own `captivet_biometric_enabled` SecureStore key and treats missing OR unreadable as disabled — after which `AppLockGuard` shows the authenticated screen with no prompt. The fresh-candidate biometric test passes happily after re-enabling the setting, so only this step can catch an upgrade silently switching off a security control every existing user had on.
5. Verify the **device UUID survived**. `getDeviceId()` silently mints a replacement when SecureStore cannot read the stored one, and every check above creates its state under the NEW build — so a candidate-only read looks perfectly stable while every updating tablet has silently re-registered as a new device, consuming another org device slot and orphaning the prior server row that revocation targets. Compare the UUID and the server device row to what step 1 recorded.

**Password-recovery deep link** — `app/_layout.tsx` parses the reset tokens out of a query string OR a fragment, calls `setSession()`, and routes on `PASSWORD_RECOVERY`; it moves with Expo Linking, Expo Router, AND Supabase, so both an Option A Supabase bump and an Option B alignment can break it while ordinary sign-in and the representative deep link both pass. Open a real emailed reset link on a cold start (`getInitialURL`) and again with the app already running (`addEventListener`), then change the password and sign in with the new one.

**Audio authorization for a NON-AUTHOR.** `canPlayAudio` gates whether `RecordingAudioPlayer` renders at all, and the guard test only reads source — it cannot see a player that briefly mounts against a cached `audioFileUrl` while the permission check resolves, which is the "permission flash" this rule exists for. Upgraded renderer or hydration timing is exactly what changes that. Open a cached recording as a low-privilege NON-author, online and after an offline relaunch, and confirm the forbidden-state card renders and no audio is reachable.

**Navigation** — an SDK major moves Expo Router, `react-native-screens`, and React Navigation together, and a routing regression compiles cleanly while leaving a list unreachable. This app has already been bitten once: the attention screen had to move inside the `(tabs)` group because `router.back()` follows the ROOT history and stranded the Recordings tab on a detail with its list gone. Walk every tab, open and exit a recording detail and the attention screen, exercise Android hardware back from each, and restore a representative deep link.

**Crash reporting** — if `@sentry/react-native` moved, a green build proves nothing about delivery. Confirm the EAS production build still uploads source maps (`sentry-cli` in the build log, `SENTRY_AUTH_TOKEN` present as a build-time secret), then send a test event and trigger a native crash against the resulting release and confirm both arrive symbolicated. Losing this is invisible until the next production incident.

**And confirm the scrubbing still runs.** Arrival is not safety: an upgraded SDK can stop invoking the configured `beforeSend` / `beforeBreadcrumb`, or change what it attaches by default, and then patient-shaped extras, request bodies, or `file://` paths start reaching Sentry — a PHI leak that no build or runtime check would notice. Send one event carrying a distinct synthetic sentinel in EVERY protected location (a PHI-shaped key, a breadcrumb, a message, a file path, request data) and read the ingested event: each sentinel must be absent or redacted. Use synthetic values only — never real patient data — and delete the event afterwards.

**PostHog has its own privacy switches, and nothing above tests them.** `posthog-react-native` moves in the same dependency group, and the app disables session replay, screen capture, and navigation autocapture deliberately (CLAUDE.md > Monitoring). A candidate can pass every Sentry check while PostHog starts capturing PHI-bearing screens or route activity. Send one synthetic explicit event and confirm the project receives it — and that no event of the AUTOCAPTURED classes arrives with it: no session replay, no screenshots, no `$screen`/`$pageview` route captures, no SDK lifecycle autocapture. "That and nothing else" would be the wrong gate: the app deliberately emits other allowlisted explicit events from `app/_layout.tsx` (`session_start`, `app_state_change`, `permissions_snapshot`), and identity calls emit their own system events. Written literally, that gate fails every correct launch and pressures whoever runs it into deleting useful monitoring to make it pass. Name the event CLASSES that must be absent, and leave the audited explicit catalog (the `AnalyticsEvent` union) alone.

Then check IDENTITY, not just content: `clearMonitoringUser()` has to reach the upgraded SDK's `Sentry.setUser(null)`, and a regression there leaves user A attached to anonymous events or to user B's — on a shared tablet, while every redaction assertion above still passes. Ingest one event after A signs out and one after B signs in, and confirm neither carries A's user id.

**Platforms** — run the whole list on Android hardware and on iOS via the Mac mini.

**The Android emulator can cover the upload path; the iOS simulator cannot.** The old blanket exclusion is out of date — `hasSilentAudioOnly()` no longer exists and nothing rejects a silent recording outright. `record.tsx` runs `checkSilentAudio()` and, when it trips, `confirmSilentUpload()` offers **Upload Anyway**; taking that override submits normally. So an emulator that produces any recording can exercise prepare → PUT → confirm, promotion, and idempotency, and those paths should be regression-tested there rather than deferred to hardware. What the emulator still cannot give you is real microphone audio, so silence-detection thresholds, latency, and audio quality remain device-only. The iOS *simulator* has no microphone capture at all, which is a capture limitation, not an upload-gate one.

## Sequencing

1. Option A on its own branch — take the SDK-55-safe bumps, get CI green.
   - **Three JS-only bumps still need runtime checks.** `@supabase/supabase-js` owns `SIGNED_OUT` semantics, refresh, and token rotation — the exact behaviour rules 16, 17 and 22 work around — and `tests/auth-*.test.mjs` assert source patterns against storage doubles, never a real GoTrue session; run the §6 auth checks INCLUDING the enforced-MFA one. The TanStack persistence packages own cross-user cache isolation on shared tablets; run the isolation check. `@sentry/react-native` is JS *and* native; run the crash-reporting check. Each applies regardless of what the rest of the bump set touches.
   - **Otherwise CI is a sufficient gate only for a JS-ONLY bump set.** Sentry, Supabase and TanStack move JS; `expo-*` packages generally do not. `expo-secure-store`, `expo-local-authentication`, `expo-file-system`, `expo-audio`, `expo-device`, `expo-crypto` and `@sentry/react-native` all ship native code, and none of it is compiled anywhere in `npm run ci` — so green CI says nothing about whether either generated native project still builds. **If the bump set touches ANY native package, require a production Android build and a production-parity iOS build (§3) before shipping**, plus the runtime checks in §6 for the subsystems that moved.
   - **If `expo-audio` moves specifically, its fence is weaker than it looks.** `tests/legacy-android-recorder-latency.test.mjs` is a *source-text* test: it regex-matches the patched Kotlin in `node_modules` and asserts statement ordering. A regenerated patch can satisfy it and still fail to compile, or compile and regress the behaviour it exists to protect. Add the recorder-start-latency, ADTS-seeking, and audio-focus-interruption checks from §6 on a physical Android device.
   - The Android production build needs a prebuild first (`android/` is not committed), and **the prebuild is where the production environment matters**: `expo prebuild` evaluates `app.config.ts` to generate the native project, so `APP_VARIANT` and the Google variables must be set on THAT command, not only on Gradle. Setting them for Gradle alone cannot regenerate a native project that was emitted without the conditional Google Sign-In plugin — the APK then builds green while the shipping plugin and pod/dependency graph go untested.

     ```bash
     # Load the FULL production environment for BOTH commands, not just the two
     # variables the plugins branch on: Gradle runs Metro, which inlines every
     # EXPO_PUBLIC_* at bundle time (CLAUDE.md > EAS Build Notes).
     #
     # `.env` is the established file here (`.env.production` does not exist and
     # is not gitignored as a pattern). Fail CLOSED: sourcing a missing file
     # leaves the shell running, and a silently unconfigured APK is exactly the
     # artifact this step is trying not to produce.
     test -f ./.env || { echo 'no ./.env — refusing to build'; exit 1; }
     set -a; . ./.env; set +a
     # NON-EMPTY IS NOT ENOUGH, so compare against the canonical values —
     # requireProductionR2BuildConfig() returns early for a local prebuild, so
     # nothing else will catch a stale or staging .env, and the auth and upload
     # gates would then "pass" against the wrong services or send test
     # recordings into an unintended bucket.
     R2_HOST=$(node -p "require('./contracts/r2-production-destination-v1.json').environments.production.virtualHost")
     [ "$EXPO_PUBLIC_API_URL" = "https://api.captivet.com" ] || { echo "API URL is not production"; exit 1; }
     [ "$EXPO_PUBLIC_SUPABASE_URL" = "https://shdzitupjltfyembqowp.supabase.co" ] || { echo "Supabase is not the shared project"; exit 1; }
     [ "$EXPO_PUBLIC_R2_BUCKET_HOSTNAME" = "$R2_HOST" ] || { echo "R2 host does not match the production contract"; exit 1; }
     #
     # EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is required too, not optional:
     # isGoogleSignInConfiguredForCurrentPlatform() disables Android Google
     # sign-in when it is empty, and .env.example ships it blank — so without
     # it the "production-parity" APK cannot run the Google auth check §6 asks
     # for. The iOS build additionally needs EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
     # and EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME — the latter is what gates the
     # Google plugin and with-ios-modular-headers.js into app.config.ts at all.
     for v in EXPO_PUBLIC_API_URL EXPO_PUBLIC_SUPABASE_URL \
              EXPO_PUBLIC_SUPABASE_ANON_KEY EXPO_PUBLIC_R2_BUCKET_HOSTNAME \
              EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID; do
       [ -n "${!v}" ] || { echo "$v is empty — refusing to build"; exit 1; }
     done
     APP_VARIANT=production npx expo prebuild --platform android --clean
     cd android && APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true \
       ./gradlew :app:assembleRelease
     ```

     Without the full set the APK embeds empty Supabase, R2, and Google configuration, so it cannot run the auth or upload checks §6 requires and the JS bundle it ships is not the one users get. The same rule applies to the iOS prebuild above. A production-parity `eas build --local` is the alternative on either platform, and is the safer choice if the environment is hard to reproduce by hand.
   - §6's device checks are scoped to Option B only because Option A is *usually* JS-only. Any native bump removes that exemption.
   - **§4b applies to Option A too** whenever the bump set touches `expo-build-properties` or any other config plugin. Those assertions are about plugin OUTPUT, not about the SDK version: a patch-level plugin change can stop emitting `usesCleartextTraffic=false`, `allowBackup=false`, or the blocked-permission list while both builds and every runtime check stay green. Diff the generated manifest and plist, and re-assert the OS floors.
2. Only then attempt Option B, on a separate branch, one concern at a time: resolve versions → patches → native modules → FFmpeg → typecheck → **bump the marketing version** → device test.
3. **The version bump belongs BEFORE the first candidate anyone installs, not after the testing.** `package.json` **and** `package-lock.json` (`app.config.ts` reads `MARKETING_VERSION` from `package.json` and carries no literal semver). It is listed inside step 2 rather than after it because §5's upgrade-in-place gate may require shipping the candidate through Play internal testing or TestFlight to match the released signing identity — that is a store upload, and an already-released or already-submitted version is rejected on arrival (`SUBMISSION_SERVICE_IOS_OLD_APP_VERSION`). Bumping afterwards is worse than inconvenient: the artifact that passed §4b and §6 is then not the artifact that ships. Pick the new version against what the stores already hold, not against the repo (see CLAUDE.md > EAS Build Notes, and the store-drift note — the store can be ahead).
4. **Finally, update the canonical guidance in the same migration.** `CLAUDE.md` is the single source of truth for this project and it hardcodes what Option B changes: the Expo SDK / RN / React versions in Architecture, the `expo-audio+55.0.16` and `ffmpeg-kit-react-native+6.0.2` patch filenames and their `buildFromSource` requirement, the FFmpeg AAR/podspec versions, and the build recipes above. Left stale, the next upgrade and every release build are driven by instructions describing the version this migration replaced. The patch filenames matter most: `patch-package` does NOT skip a patch whose target version no longer matches — it applies it anyway and only WARNS (`applyPatches.js`; it errors only when application also fails). So a patch authored against `expo-audio@55.0.16` that still applies cleanly to a later one lands silently on Kotlin it was never written for — which for these two patches means the parallelized recorder start and the ADTS seeking fix, native behaviour no typecheck and no Node test can see. Re-cut each patch against the new version and rename it, and re-check the `buildFromSource` autolinking entry that makes the patched Kotlin compile at all. Land those edits with the migration, not after it.

Do not let a dependency bot drive either step. #184 is what that looks like.

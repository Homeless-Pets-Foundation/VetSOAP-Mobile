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

**Option A — stay on SDK 55, take the safe patches.** `expo` → `55.0.30`, the `expo-*` patch-level bumps, and non-native packages (Sentry, Supabase, TanStack). RN stays at `0.83.10`. Small and low risk, and it recovers most of what #184 offered — *unless* it moves `expo-audio`, which forces a patch regeneration and drags the native validation of §6 into Option A with it (see Sequencing).

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
unzip -o -q app-release.apk 'lib/arm64-v8a/*.so' -d /tmp/apk-libs
for so in /tmp/apk-libs/lib/arm64-v8a/*.so; do
  echo "== $so"; llvm-readelf -l "$so" | awk '/LOAD/ {print $NF}' | sort -u
done
```

Then run the recording and editor checks on a 16 KB-page device or emulator image.

**A build is not the FFmpeg gate; the editor is.** Nothing in §6 invokes `src/lib/ffmpeg.ts`, and `app/(app)/audio-editor.tsx` depends on that bridge for waveform peak extraction and trim/concat. A bridge signature or codec incompatibility compiles, links, and passes the playback-seeking check while making editing fail on device. Add to the hardware list: open a recording in the editor, confirm the waveform renders, apply a trim, and play back the result — on both platforms.

### 4b. Verify the GENERATED manifests, not just that they build

A green Gradle/Xcode build proves the projects compile, not that config-plugin output still carries our hardening. These live in `app.config.ts` and are produced by plugins, so an SDK-major plugin change can drop or alter them while both builds stay green:

- `expo-build-properties` → Android `usesCleartextTraffic: IS_DEV` (false in production) and `allowBackup: false`
- the `blockedPermissions` list (storage, location, camera, media)
- iOS background-audio mode and the microphone usage description

After prebuild, read the generated `android/app/src/main/AndroidManifest.xml` and `ios/*/Info.plist` and assert each one is still present and still has the production value. Diff them against the previous SDK's generated output — that diff is the real review surface of an SDK upgrade.

**Assert the supported-OS floors in the same pass.** `app.config.ts` requests Android `minSdkVersion: 24` (required by ffmpeg-kit) and iOS `deploymentTarget: '15.1'`. An Expo/RN/`expo-build-properties` major can raise either, and every build you run will be on modern hardware, so the release silently stops installing on older clinic devices while all checks stay green. Read the effective `minSdkVersion` out of the generated Gradle config and `IPHONEOS_DEPLOYMENT_TARGET` out of the Xcode project, compare them to those two numbers, and either hold the floors or get the compatibility drop explicitly approved and communicated.

### 5. Expect the #184 typecheck errors

15 errors, already catalogued, in three families:

- `Module '"react-native"' has no exported member 'InteractionManager'` — `record.tsx`, `audio-editor.tsx`
- ScrollView/View ref retyping — `PatientTabStrip.tsx`, `recordings/[id].tsx`, `WaveformEditor.tsx`
- `TextInput` ref typing — `src/components/ui/Text.tsx`, `login.tsx`

`ui/Text.tsx` is the sensitive one: it is the single file allowed to import `Text`/`TextInput` from `react-native`, and `font-scaling-guard` fences that. Fix the types without weakening the guard.

### 6. Device testing — not optional

`npm run ci` cannot validate this. Required on real hardware:

**Recording**

- Durable recording across process death, plus crash recovery
- **A timed capture through backgrounding AND screen lock, on both platforms** — start recording, background the app, lock the device, wait a measured interval, return, finish, and verify the resulting file's duration and audible content match the wall-clock time. This depends on the Android microphone foreground service plus its notification/wake-lock permissions and on iOS background audio / `AVAudioSession`, all of which move between SDK majors. A regression here loses audio during an ordinary appointment without crashing and without failing crash-recovery, so nothing else on this list catches it.
- Audio focus interruption (call / alarm / other voice app) on **Android**, via `modules/captivet-audio-focus`
- **The same interruption on iOS**, where that module is a deliberate no-op and recovery depends entirely on expo-audio surfacing the `AVAudioSession` interruption as `hasError` — an SDK-sensitive path that neither the process-death test nor the background/lock test triggers. **The two capture modes have different contracts, so assert them separately:**
  - *Durable capture:* `audio.aac` is already saved and marked interrupted natively, and v1 deliberately does NOT auto-resume-append. The correct behaviour is a silent finalize into a submittable durable draft, with the interruption notice shown — `interruptionPendingResume` is never armed and the iOS engine emits no gain event. Verify the draft exists, carries the full pre-interruption audio, and submits.
  - *expo-audio fallback:* the partial segment is committed via `CONTINUE_RECORDING`, `interruptionPendingResume` is armed, and the AppState `'active'` handler resumes. Verify the resume happens and the segments concatenate.
  - Requiring "resumes on gain" of the durable path would reject correct behaviour, or worse, invite an unsafe auto-resume.
- Recorder start latency — the `expo-audio` patch exists to keep it low; `measurePhase` warns above `NATIVE_RECORDER_PHASE_WARNING_MS` (1000 ms)
- Playback seeking on durable ADTS AAC files
- **Microphone permission revoked mid-capture**, on both platforms: start recording, revoke access in system settings, return to the app. `useAudioRecorder` is required to survive this (CLAUDE.md rule 6) — `stop()` swallows and cleans up, `pause()`/`resume()` clean up and rethrow — and no other check on this list produces a native op failing under the recorder. Verify the partial audio is retained, the hook is not left stuck in `recording`, then re-grant access and start a fresh recording in the same session.
- **Multi-patient recorder ownership, with at least two slots.** Every other check here uses one patient, but this migration moves the scrolling/ref APIs and Reanimated/worklets that the pageable patient cards are built on, and the single-recorder handoff is timing-dependent (`recorderBoundToSlotId`, the `pendingStartSlotRef` queue, auto-pause on swipe-away). The Node tests only read that control flow as source. A regression here attaches one patient's exam audio to another patient's slot — a clinical-correctness failure, not a UX one. Start capture on patient A, switch to B while the pause/stop is still in flight, record B, and confirm each segment and each upload lands only on its intended slot.

**Offline → online, without restarting the flow** — an SDK bump rebuilds `@react-native-community/netinfo` against the new RN. Every other check here runs online, and an offline Finish stays `pendingSync` until `usePendingDraftSync` sees reachability, so a bridge that stops emitting usable events compiles, passes every fresh-online submit, and leaves drafts permanently unsynced. Finish a recording in airplane mode, re-enable the network WITHOUT restarting the app or the workflow, and confirm the existing draft syncs and submits on its own.

**Upload wake-lock past the screen timeout** — `acquireKeepAwakeLease()` deliberately swallows native activation failures, and `expo-keep-awake` moves transitively with Expo. A short emulator upload passes with the screen on, while a clinic-sized upload dies once the normal Android screen timeout lets Doze reap the socket. Run an Android upload longer than the device's configured screen timeout, confirm the screen stays awake and the upload completes, then confirm normal timeout behaviour returns afterwards.

**Auth, storage and device identity** — the Node tests mock every one of these bridges, and compiling proves nothing about them. An SDK major moves `expo-secure-store`, `expo-crypto`, `expo-local-authentication`, and the social-auth modules underneath:

- Cold-start session restoration after a real app kill (SecureStore round-trip, including the read-back verification in `src/auth/supabase.ts`)
- Device registration: confirm `X-Device-Id` is present on requests and that `getDeviceId()` still returns a stable UUID (Rule 21 — Hermes has no `globalThis.crypto` on iOS)
- Device TYPE, not just the id (Rule 23): `registerDevice()` reads `Device.deviceType` on Android and `Platform.isPad` on iOS, and an unavailable or renamed Android enum silently falls back to `android_tablet`. Register a representative phone and tablet on each platform and confirm the server and the Devices screen show `ios_phone` / `ios_tablet` / `android_phone` / `android_tablet` correctly — a mislabelled device is what an admin revokes by
- Biometric unlock through `AppLockGuard`, including a cancelled prompt — **at cold start AND on background resume**. The resume path is the one at risk: it depends on RN's `AppState` ordering to lock synchronously before the current screen renders, so an upgraded runtime that delivers the event late briefly exposes whatever PHI-bearing screen was open. A cold-start-only check passes right through that. Background from a recording or SOAP screen for longer than the 30-second threshold, return, and confirm nothing flashes before the prompt, that cancelling leaves the app locked, and that unlocking returns to the same screen.
- Email/password sign-in, plus Google on **both** platforms and Apple on iOS. iOS Google is a real path — `socialAuth.ts` requires both Google client IDs and `app.config.ts` installs the iOS URL-scheme plugin — and it is the one most exposed here, since the migration moves the GoogleSignIn pods and the AppCheckCore graph behind `with-ios-modular-headers.js`. A green pod build and a working Apple login say nothing about the iOS OAuth redirect or the ID-token exchange.
- **An enforced-MFA account end to end**: sign in, land on `MFA_REQUIRED`, complete the challenge, and confirm the profile loads. The MFA path derives its access and refresh tokens from the Supabase session and only finishes after verification, so an ordinary sign-in can pass while every enforced-MFA user is locked out.

**Gates that fail OPEN** — three checks deliberately allow the operation when their native bridge returns nothing, which is right for resilience and means an SDK incompatibility disables them silently, with CI and both builds green:

- **Minimum app version** (`src/lib/minVersion.ts`, `expo-application`): `getRecordStartGate()` fails open when `getCurrentAppVersion()` is null. On the production candidate, confirm the native marketing version reads correctly, then confirm a floor above it blocks Start and Resume→Continue while leaving existing recordings submittable. This one is cross-repo — a below-floor client starting durable captures the coordinated server deploy no longer accepts is exactly what the floor exists to prevent.
- **Low disk** (`src/lib/freeSpace.ts`, `expo-file-system`): `checkPreRecordFreeSpace()` treats zero, a missing property, or a bridge failure as unknown and allows recording. Every other check here runs with ordinary free space. Fill the device to exercise the 250 MiB block and the 500 MiB warning, and confirm a normal-space device is still allowed.
- **SOAP PDF export** (`src/lib/share.ts`, `expo-print` + `expo-sharing`): `tests/soap-pdf.test.mjs` only confirms the modules are lazy-required, and compiling proves nothing about `printToFileAsync()` or `shareAsync()` at runtime. Both packages move with the `expo-*` patch bumps Option A advertises. Generate a SOAP PDF and share it on both platforms whenever either package changes.
- **Sensitive clipboard** (`src/lib/secureClipboard.ts`, `expo-clipboard`): `copyWithAutoClear()` / `clearClipboard()` hold MFA enrolment secrets, SOAP notes, transcripts, and client data, and the tests only confirm callers reference the helper. On a changed or unavailable bridge that content can outlive its 30-second timeout on a shared clinic tablet. Copy sensitive text and verify the timeout, backgrounding, and sign-out triggers each clear it, on both platforms.

**Cross-user isolation — the query cache AND every local recording store.** Two separate mechanisms, and the migration touches both:

- `queryClient.clear()` on sign-out is the PHI-isolation guarantee for server data, and `queryPersistence.ts` depends on the installed `persistQueryClient` tuple, its restore timing, and throttled writes. `tests/query-persistence-guard.test.mjs` only reads source.
- Drafts, stashes, recovery intents, durable manifests and their audio are isolated by per-user SCOPING, not by wiping (rule 8), and every one of those stores is armed asynchronously from `AuthProvider.fetchUser()` via `setUserId`. SecureStore, FileSystem, and Supabase restoration timing all move in this migration, and the upgrade-in-place test below only ever exercises ONE user — so a store still holding user A's scope when user B signs in would go unnoticed, and on a shared clinic tablet that means B seeing, submitting, or deleting A's clinical audio.

Switch accounts on a real device WHILE a restore or a cleanup is still pending, and confirm: no outgoing-user query hydrates into the incoming session, nothing of theirs remains stored, and B's Record tab, draft list, saved sessions, and recovery screen show none of A's work — then sign back in as A and confirm A's work is all still there.

**Upgrade-in-place, with pre-existing work** — every check above creates its data under the new build, but real users install over SDK 55 with drafts, stashes, recovery intents, and durable manifests already on disk. The migration moves both `expo-secure-store` and `expo-file-system`, so a path, accessibility-class, or serialization change can make that work vanish while fresh recordings and crash recovery both pass:

**The two builds must share a signing identity, or step 2 cannot happen at all.** A store-installed SDK-55 app is signed by Play/App Store; the local `expo prebuild` + `assembleRelease` candidate is not, and Android refuses the replacement outright (iOS has the same constraint). Do not let that turn this gate into a clean install — a clean install tests nothing here. Either ship the candidate through an internal track (Play internal testing / TestFlight) so the identities match, or seed the "released" side with a build signed by the same test key as the candidate.

1. On the **released SDK-55 binary** (see the signing note above), seed one of each: an un-sent draft, a saved session (stash), a durable capture killed mid-recording, and a draft with a `pendingConfirm`. Record the device UUID and its server device row now — see below.
2. Install the candidate build **over it, without clearing app data**.
3. Verify every item reappears, still carries its metadata, and is still submittable.
4. Verify the **device UUID survived**. `getDeviceId()` silently mints a replacement when SecureStore cannot read the stored one, and every check above creates its state under the NEW build — so a candidate-only read looks perfectly stable while every updating tablet has silently re-registered as a new device, consuming another org device slot and orphaning the prior server row that revocation targets. Compare the UUID and the server device row to what step 1 recorded.

**Password-recovery deep link** — `app/_layout.tsx` parses the reset tokens out of a query string OR a fragment, calls `setSession()`, and routes on `PASSWORD_RECOVERY`; it moves with Expo Linking, Expo Router, AND Supabase, so both an Option A Supabase bump and an Option B alignment can break it while ordinary sign-in and the representative deep link both pass. Open a real emailed reset link on a cold start (`getInitialURL`) and again with the app already running (`addEventListener`), then change the password and sign in with the new one.

**Navigation** — an SDK major moves Expo Router, `react-native-screens`, and React Navigation together, and a routing regression compiles cleanly while leaving a list unreachable. This app has already been bitten once: the attention screen had to move inside the `(tabs)` group because `router.back()` follows the ROOT history and stranded the Recordings tab on a detail with its list gone. Walk every tab, open and exit a recording detail and the attention screen, exercise Android hardware back from each, and restore a representative deep link.

**Crash reporting** — if `@sentry/react-native` moved, a green build proves nothing about delivery. Confirm the EAS production build still uploads source maps (`sentry-cli` in the build log, `SENTRY_AUTH_TOKEN` present as a build-time secret), then send a test event and trigger a native crash against the resulting release and confirm both arrive symbolicated. Losing this is invisible until the next production incident.

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
     # NON-EMPTY IS NOT ENOUGH. A stale or staging .env passes this loop, and
     # `requireProductionR2BuildConfig()` returns early for a local prebuild
     # (it only enforces on an EAS production build), so nothing else catches
     # it — the auth and upload checks would then run against the wrong
     # services, or send test recordings into an unintended bucket. Compare the
     # values to the canonical ones first: the Supabase URL and project ref in
     # CLAUDE.md > Shared Infrastructure, the prod API host, and the R2 host in
     # contracts/r2-production-destination-v1.json.
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
2. Only then attempt Option B, on a separate branch, one concern at a time: resolve versions → patches → native modules → FFmpeg → typecheck → device test.
3. Bump the marketing version in `package.json` **and** `package-lock.json` before any store build (`app.config.ts` reads `MARKETING_VERSION` from `package.json` and carries no literal semver).

Do not let a dependency bot drive either step. #184 is what that looks like.

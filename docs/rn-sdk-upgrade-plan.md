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
# 1. move the SDK itself (pick one target; ^56 or ^57)
npx expo install expo@^56
# 2. only now align everything else to the installed SDK
npx expo install --fix
npx expo-doctor
```

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

### 4b. Verify the GENERATED manifests, not just that they build

A green Gradle/Xcode build proves the projects compile, not that config-plugin output still carries our hardening. These live in `app.config.ts` and are produced by plugins, so an SDK-major plugin change can drop or alter them while both builds stay green:

- `expo-build-properties` → Android `usesCleartextTraffic: IS_DEV` (false in production) and `allowBackup: false`
- the `blockedPermissions` list (storage, location, camera, media)
- iOS background-audio mode and the microphone usage description

After prebuild, read the generated `android/app/src/main/AndroidManifest.xml` and `ios/*/Info.plist` and assert each one is still present and still has the production value. Diff them against the previous SDK's generated output — that diff is the real review surface of an SDK upgrade.

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
- Audio focus interruption (call / alarm / other voice app) on Android
- Recorder start latency — the `expo-audio` patch exists to keep it low; `measurePhase` warns above `NATIVE_RECORDER_PHASE_WARNING_MS` (1000 ms)
- Playback seeking on durable ADTS AAC files

**Auth, storage and device identity** — the Node tests mock every one of these bridges, and compiling proves nothing about them. An SDK major moves `expo-secure-store`, `expo-crypto`, `expo-local-authentication`, and the social-auth modules underneath:

- Cold-start session restoration after a real app kill (SecureStore round-trip, including the read-back verification in `src/auth/supabase.ts`)
- Device registration: confirm `X-Device-Id` is present on requests and that `getDeviceId()` still returns a stable UUID (Rule 21 — Hermes has no `globalThis.crypto` on iOS)
- Biometric unlock through `AppLockGuard`, including a cancelled prompt
- Email/password sign-in plus Google (Android) and Apple (iOS) sign-in

**Upgrade-in-place, with pre-existing work** — every check above creates its data under the new build, but real users install over SDK 55 with drafts, stashes, recovery intents, and durable manifests already on disk. The migration moves both `expo-secure-store` and `expo-file-system`, so a path, accessibility-class, or serialization change can make that work vanish while fresh recordings and crash recovery both pass:

1. On the **released SDK-55 binary**, seed one of each: an un-sent draft, a saved session (stash), a durable capture killed mid-recording, and a draft with a `pendingConfirm`.
2. Install the candidate build **over it, without clearing app data**.
3. Verify every item reappears, still carries its metadata, and is still submittable.

**Platforms** — run the whole list on Android hardware and on iOS via the Mac mini.

**The Android emulator can cover the upload path; the iOS simulator cannot.** The old blanket exclusion is out of date — `hasSilentAudioOnly()` no longer exists and nothing rejects a silent recording outright. `record.tsx` runs `checkSilentAudio()` and, when it trips, `confirmSilentUpload()` offers **Upload Anyway**; taking that override submits normally. So an emulator that produces any recording can exercise prepare → PUT → confirm, promotion, and idempotency, and those paths should be regression-tested there rather than deferred to hardware. What the emulator still cannot give you is real microphone audio, so silence-detection thresholds, latency, and audio quality remain device-only. The iOS *simulator* has no microphone capture at all, which is a capture limitation, not an upload-gate one.

## Sequencing

1. Option A on its own branch — take the SDK-55-safe bumps, get CI green.
   - **CI is a sufficient gate only for a JS-ONLY bump set.** Sentry, Supabase and TanStack move JS; `expo-*` packages generally do not. `expo-secure-store`, `expo-local-authentication`, `expo-file-system`, `expo-audio`, `expo-device`, `expo-crypto` and `@sentry/react-native` all ship native code, and none of it is compiled anywhere in `npm run ci` — so green CI says nothing about whether either generated native project still builds. **If the bump set touches ANY native package, require a production Android build and a production-parity iOS build (§3) before shipping**, plus the runtime checks in §6 for the subsystems that moved.
   - **If `expo-audio` moves specifically, its fence is weaker than it looks.** `tests/legacy-android-recorder-latency.test.mjs` is a *source-text* test: it regex-matches the patched Kotlin in `node_modules` and asserts statement ordering. A regenerated patch can satisfy it and still fail to compile, or compile and regress the behaviour it exists to protect. Add the recorder-start-latency, ADTS-seeking, and audio-focus-interruption checks from §6 on a physical Android device.
   - The Android production build is `npx expo prebuild --platform android` first — `android/` is not committed — then `cd android && APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease`.
   - §6's device checks are scoped to Option B only because Option A is *usually* JS-only. Any native bump removes that exemption.
2. Only then attempt Option B, on a separate branch, one concern at a time: resolve versions → patches → native modules → FFmpeg → typecheck → device test.
3. Bump the marketing version in `package.json` **and** `package-lock.json` before any store build (`app.config.ts` reads `MARKETING_VERSION` from `package.json` and carries no literal semver).

Do not let a dependency bot drive either step. #184 is what that looks like.

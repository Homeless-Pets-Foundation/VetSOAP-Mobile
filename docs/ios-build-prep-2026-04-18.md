# iOS Build Prep — VetSOAP-Mobile (2026-04-18)

## Context

Android builds ship fine today; this pass closed every iOS infrastructure gap that could be wired from code, before the first `eas build --platform ios` attempt. The goal: maximize the odds the first iOS build succeeds, so any failure is a genuine unknown (ffmpeg-kit pod resolution, certificate setup) rather than something trivially avoidable.

**Scope:** code + config changes only. EAS secrets, Apple Developer Program enrollment, Supabase dashboard work, and the actual build trigger are out of scope — those require human credentials and are listed under "Prerequisites you'll handle" below.

---

## Assessment summary

The codebase was already well-wired for iOS before this pass: bundle ID, Info.plist usage strings (`NSMicrophoneUsageDescription`, `NSFaceIDUsageDescription`), `usesAppleSignIn`, background recording plugin flag, iOS deployment target 15.1, EAS iOS profiles for dev/preview/prod, lazy `require()` of Apple/Google/crypto modules (rule 23), platform branches all explicit (`Platform.OS === 'ios'` in `login.tsx`, `socialAuth.ts`, `useAudioRecorder.ts`). The Android-only ffmpeg-kit patch (`patches/ffmpeg-kit-react-native+6.0.2.patch`) only touches `android/gradle.properties` — harmless on iOS.

The one genuine unknown is ffmpeg-kit CocoaPods resolution post Arthenica sunset. That only reveals itself at `pod install` time during the EAS build. See "ffmpeg-kit iOS pod risk" below.

---

## Changes made

### 1. `app.config.ts` — iOS metadata gaps filled

- Added `ios.buildNumber: '1'` (EAS profile `autoIncrement: true` handles future bumps; explicit initial value for parity with Android `versionCode`).
- Added `ios.config.usesNonExemptEncryption: false` (app uses only standard TLS + Apple Sign-In nonce hashing; exempt under ITSAppUsesNonExemptEncryption). Avoids per-submission export-compliance prompt.
- Did not add `NSPhotoLibraryUsageDescription` or `NSContactsUsageDescription` — app doesn't use those APIs.

Lines: `app.config.ts:89,91–93`.

### 2. `.env.example` — Google OAuth vars documented

- Added entries for `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` with a one-line comment noting the values come from Google Cloud Console and that the iOS pair is required only for the iOS build.
- Web client ID was already consumed by `src/config.ts:73–74` but was undocumented in `.env.example`; included it here for completeness.

### 3. `src/auth/AuthProvider.tsx` — screen-capture prevention wired

- Imported `expo-constants` (for `extra.isProduction`) and `expo-screen-capture`.
- Added a dedicated mount-time `useEffect` that calls `ScreenCapture.preventScreenCaptureAsync()` only when `Constants.expoConfig?.extra?.isProduction === true`.
- Fire-and-forget with `.catch(() => {})` — a native failure cannot crash Hermes (rules 4 + 9). No cleanup on unmount; prevention is app-lifetime.
- iOS behavior: screenshots are watermarked/blanked; screen-recording is blocked. Android: screenshots blocked. PHI hardening on shared clinic tablets either way.

Lines: `src/auth/AuthProvider.tsx:5–6,388–396`.

### 4. `src/config.ts` — read-only confirmation

`GOOGLE_WEB_CLIENT_ID` and `GOOGLE_IOS_CLIENT_ID` exports already present at `src/config.ts:73–76`. `GOOGLE_IOS_URL_SCHEME` is consumed only inline in `app.config.ts:60–65` (Google Sign-In Expo plugin gating); no module export needed. No edits.

### 5. ffmpeg-kit iOS podspec — read-only forecast

Read `node_modules/ffmpeg-kit-react-native/ffmpeg-kit-react-native.podspec`. The `'min'` subspec (selected by the `@config-plugins/ffmpeg-kit-react-native` plugin via `package: 'min'`) declares `dependency 'ffmpeg-kit-ios-min', "6.0"`. This is the iOS-side mirror of the same arthenica artifact that was removed from Maven Central on the Android side (and that you already self-host at `homeless-pets-foundation.github.io/ffmpeg-kit-maven`). The CocoaPods trunk equivalent may be similarly unavailable.

**Did not pre-emptively patch.** Without verifying CocoaPods trunk state, a blind fix could mask whatever the build actually wants. See "ffmpeg-kit iOS pod risk" below for what to do if `pod install` fails.

### 6. `package.json` — sanity check

All native iOS-relevant deps are pinned to Expo SDK 55-compatible versions (`expo-audio ~55.0.13`, `expo-secure-store ~55.0.13`, `expo-local-authentication ~55.0.13`, `expo-apple-authentication ~55.0.13`, `expo-screen-capture ~55.0.13`, `@react-native-google-signin/google-signin ^16.1.2`, `ffmpeg-kit-react-native ^6.0.2`, `@config-plugins/ffmpeg-kit-react-native ^9.0.0`). `expo-doctor` 17/17 green.

---

## ffmpeg-kit iOS pod risk

`ffmpeg-kit-ios-min@6.0` is referenced from the npm package's podspec at line 26 of `node_modules/ffmpeg-kit-react-native/ffmpeg-kit-react-native.podspec`. If CocoaPods trunk no longer hosts it, `pod install` fails during the EAS build with `Unable to find a specification for "ffmpeg-kit-ios-min"`.

**Mitigation paths if that happens:**
1. **Self-host the iOS pod** — analogous to the existing self-hosted Maven repo for Android. Build `ffmpeg-kit-ios-min` from `arthenica/ffmpeg-kit` and publish to a private spec repo (or a podspec source URL). Add the source via the Podfile or `expo-build-properties` `ios.extraPods` if the property accepts a custom `:podspec` reference.
2. **Drop ffmpeg from iOS** — the upload path doesn't need it (each segment uploads independently to R2 at `src/api/recordings.ts:377–450`). Waveform extraction, audio editor trim, and the pre-upload silence check would degrade gracefully on iOS — gate those features behind `Platform.OS === 'android'` until a replacement transcoder is in place.

Don't act on either until the build actually fails with that exact error.

---

## Prerequisites (handled outside this codebase)

These must be in place before `eas build --platform ios` succeeds:

1. **Apple Developer Program enrollment** + Apple Team linked to the EAS account.
2. **EAS secrets pushed** — populate `.env` with the three Google OAuth values and run `eas secret:push --scope project --env-file .env --force` (per CLAUDE.md "Secrets sync"). The iOS pair (`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` + `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME`) comes from a new iOS OAuth client in Google Cloud Console with bundle ID `com.captivet.mobile`.
3. **Supabase Apple provider enabled** in the Supabase dashboard — Apple Sign-In flow will 400 without it (memory: `ios_build.md`).
4. **iOS bundle ID registered** at Apple Developer → Identifiers — `com.captivet.mobile`.
5. **Sign in with Apple capability** enabled on the app ID in Apple Developer portal.
6. **First build command:** `eas build --platform ios --profile development` (simulator, fastest signal) or `--profile preview` (internal distribution for TestFlight).

---

## Verification (this pass)

- `npx tsc --noEmit` — clean.
- `npx expo-doctor` — 17/17 checks passed.
- Android build path mentally green — every change is iOS-only or no-op on Android (`preventScreenCaptureAsync` is cross-platform, gated on `extra.isProduction` so dev builds are unaffected).
- Crash-rule audit on the AuthProvider edit: rule 1 (no module-load throw) ✓, rule 4 (`.catch()` on fire-and-forget) ✓, rule 6 (no async passed to AppState handler) — N/A, the new useEffect runs synchronously.

---

## What to expect from the first iOS build attempt

**Most likely success path:** simulator build completes, app installs, sign-in works (email immediately; Apple once Supabase provider is enabled), recording works, upload works. Waveform may or may not render depending on whether `ffmpeg-kit-ios-min` resolves.

**Most likely failure path:** `pod install` fails fetching the ffmpeg-kit binary framework. Iterate per "ffmpeg-kit iOS pod risk" above.

## Files of record

- `app.config.ts` — iOS block changes
- `.env.example` — Google OAuth vars documented
- `src/auth/AuthProvider.tsx` — screen-capture prevention
- `node_modules/ffmpeg-kit-react-native/ffmpeg-kit-react-native.podspec` — pod source-of-truth (not edited)

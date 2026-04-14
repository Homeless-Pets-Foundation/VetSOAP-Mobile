# iOS Implementation Guide

## Overview

EAS Build on expo.dev is how iOS builds are produced. The project is already wired for iOS in both `eas.json` and `app.config.ts`.

---

## What's Already Done

- `bundleIdentifier: 'com.captivet.mobile'` set in `app.config.ts`
- iOS deployment target: 15.1
- Face ID permission string, microphone permission string, and App Transport Security (HTTPS enforcement) all configured in `infoPlist`
- `supportsTablet: true`
- `usesAppleSignIn: true` with capability
- Background audio recording capability (`enableBackgroundRecording: true`)
- All three EAS build profiles have iOS entries:
  - `development` → simulator build
  - `preview` → internal distribution (TestFlight/Ad Hoc)
  - `production` → App Store
- Audio recording options already have a separate `ios` block (`IOSOutputFormat.MPEG4AAC`, `AudioQuality.MAX`) — `audioSource: 'voice_recognition'` is Android-only and does not affect iOS
- `AuthProvider.tsx` and `socialAuth.ts` have `Platform.OS` guards where needed

---

## Prerequisites Before Building

### 1. Apple Developer Account ($99/year)

EAS managed credentials auto-provision signing certificates and provisioning profiles, but requires an Apple account. Enrollment approval takes 1–2 business days if not already enrolled.

### 2. Google Sign-In iOS Secrets (2 new EAS secrets required)

Create an **iOS OAuth 2.0 client ID** in Google Cloud Console:
- Application type: **iOS**
- Bundle ID: `com.captivet.mobile`

Then add two EAS secrets:

| Secret | Value |
|---|---|
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | The iOS OAuth client ID |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Reversed client ID (e.g. `com.googleusercontent.apps.123456-abcdef`) |

Without these, Google Sign-In is gracefully disabled on iOS (no crash — shows an error message). The Google Sign-In plugin is only added to the build when `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` is present.

### 3. Supabase Apple Provider (required for Apple Sign-In)

`signInWithAppleNative()` in `src/auth/socialAuth.ts` is fully implemented. Supabase also needs the Apple provider configured in the dashboard:

- Team ID
- Service ID
- Private key

This is a one-time Supabase dashboard setting.

---

## Known Gotchas

### FFmpeg Build Time

The `patches/ffmpeg-kit-react-native+6.0.2.patch` only modifies `android/gradle.properties` and is harmless on iOS. On iOS, ffmpeg-kit uses CocoaPods and the initial compile is heavy. Expect EAS builds to take **25–40 minutes** (vs. ~10–15 min for Android) on the first build or after cache invalidation.

### Background Audio App Store Review

The background audio entitlement is correctly added via `enableBackgroundRecording: true`. Apple requires a clear justification in App Store review. State something like: "Records veterinary appointments in the background while the screen is off." This is a legitimate use case but must be described in submission notes.

### No ADB for iOS Testing

The existing testing workflow (ADB, Android emulator in WSL2) is Android-only. For iOS you need either:
- A **Mac with Xcode** to run the simulator build (`development` profile has `"simulator": true`)
- A **physical iPhone or iPad** enrolled in your Developer account for `preview` builds

---

## Triggering an iOS Build

```bash
# Simulator build — quickest, no Apple account credentials needed for this profile
eas build --platform ios --profile development

# Real device testing (TestFlight / Ad Hoc)
eas build --platform ios --profile preview

# App Store production build
eas build --platform ios --profile production
```

Before building, push any new secrets to EAS:

```bash
eas secret:push --scope project --env-file .env --force
```

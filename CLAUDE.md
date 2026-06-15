# Captivet Mobile — Project Guidelines

## Architecture

- **Framework:** Expo SDK 55, RN 0.83.6, React 19
- **Routing:** expo-router (file-based, `app/`)
- **State:** React Query = server; Context = auth; useReducer = multi-patient session
- **Styling:** NativeWind v4 (Tailwind via `global.css`)
- **Auth:** Supabase + `expo-secure-store` token persist
- **Build:** EAS managed (no `android/`/`ios/` committed)

## Shared Infrastructure

Mobile, web (Captivet Connect), prod API — **all** auth vs same Supabase project. Wrong project → silent auth fail. `.env` + EAS secrets must match.

| Service | Value |
|---|---|
| Supabase ref | `shdzitupjltfyembqowp` |
| Supabase URL | `https://shdzitupjltfyembqowp.supabase.co` |
| Prod API | `https://api.captivet.com` |

## Critical Crash Prevention Rules

From prod crash audits. Break → Android APK crashes.

1. **Never throw at module load.** `src/config.ts` exports `CONFIG_MISSING` (no throw); `src/auth/supabase.ts` uses placeholder client if config missing. New module-level init on env/external state must degrade gracefully, never `throw` at top level.

2. **Never pass async fn to void callback.** RN callbacks (`onPress`, `onValueChange`, `AppState.addEventListener`, `Alert.onPress`, `Switch.onValueChange`, `RefreshControl.onRefresh`) are `() => void`; async fn → discarded Promise → Hermes unhandled rejection crashes release builds. Wrap: `onValueChange={(v) => { doThing(v).catch(e => ...); }}` or use a try/catch async handler. Notably:
   - **`AppState.addEventListener('change', handler)`** — handler must have outer try/catch + reset `isAuthenticating` in `finally`. Else biometric hw error → app permanently locked.
   - **`RefreshControl.onRefresh`** — `() => { refetch().catch(() => {}); }`.

3. **Always wrap SecureStore / Keystore in try/catch.** `expo-secure-store` → Android Keystore throws on: Keystore corruption after failed OS update, Direct Boot (pre-unlock), low storage, key invalidated after screen-lock change. `src/lib/secureStorage.ts` + `src/lib/biometrics.ts` wrap every call. **Never** call `SecureStore.*` direct — always wrappers.

4. **Never fire-and-forget Promises without `.catch()`.** Non-awaited Promise must have `.catch(() => {})` or be inside try/catch. Same for `Haptics.*Async()` (rejects on devices without haptic motor — tablets, emulators, budget phones), including shared `Button` (`src/components/ui/Button.tsx`) on every press.

5. **Always use `finally` for loading state.** `isLoading=true` → reset in `finally`. Throw between → UI stuck loading forever.

6. **Audio recorder hook must recover from native failures.** `useAudioRecorder` ops (expo-audio) can throw on interrupt (call, focus lost, permission revoked):
   - **`stop()`** — swallow errors (try/catch, no rethrow); state + URI always cleaned.
   - **`pause()`/`resume()`** — catch, cleanup (capture duration, force `recorder.stop()`, save URI, state → `stopped`, reset audio mode), **rethrow** so callers show feedback.
   - Without → one native fail permanently corrupts hook. `record.tsx` wraps in try/catch + Alert. `pause()`+`record()` sync; `stop()`+`prepareToRecordAsync()` async. Polling via `useAudioRecorderState(recorder, 500)` (500ms = responsiveness vs CPU on weak hw). Auto-releases on unmount.

7. **Keep `validateRequestUrl()` inside try in `ApiClient.request()`.** SSL pin validation inside try/catch so `finally` runs `clearTimeout(timeout)`. Move out → timer leak + uncaught throw.

8. **Sign-out preserves recordings; clears only transient caches.** `clearTransientCaches()` in `AuthProvider.tsx` runs on both logout paths (explicit `handleSignOut` + involuntary `SIGNED_OUT`); clears only non-PHI scratch (`cleanupAudioCache`, `audioTempFiles.cleanupAll`, `clearPeakCache`, in-memory `audioEditorBridge.clear()`+`clearClipboard()`). Per the 2026-05-29 owner decision (vet recordings carry no security concern; not HIPAA), drafts/stashes/their audio and `RECOVERY_INTENT` **survive every logout** and reappear on re-sign-in — isolation comes from per-user disk scoping (rule 13), bounded growth from status-aware eviction (rule 13), NOT from wiping. Do **not** re-add `draftStorage.clearAll()`/`stashStorage.clearAllStashes()`/`stashAudioManager.deleteAllStashedAudio()` (or `RECOVERY_INTENT` deletion) to any logout path — that reintroduces the "Lela bug" (un-uploaded recording destroyed on involuntary logout). `support_staff` sign-out additionally runs `preserveSupportStaffRecordings()` → owner/admin/vet recovery vault (`SignOutRecoveryMode`; 'required' can block sign-out on save failure).

9. **Validate local files before upload.** `recordingsApi.createWithFile()`/`createWithSegments()` check `getInfoAsync(uri)` pre-upload. 250MB/file limit (`MAX_FILE_SIZE_BYTES`), 10min timeout (`R2_UPLOAD_TIMEOUT_MS`) via `withTimeout()`. `createWithSegments()` validates each segment. Missing/empty → user-friendly throw, not silent 0-byte upload.

10. **Guard `response.json()` against null + unexpected shapes.** API error body can be literal `null` (valid JSON). Always `?? {}` after `.catch(() => ({}))`. `Array.isArray()` before `.map()` on fields like `details`.

11. **Guard `new Date()` before Intl.** `new Date(null/undefined)` → "Invalid Date"; Hermes `.toLocaleDateString()` w/ Intl options → `RangeError`. Check `isNaN(parsedDate.getTime())` first.

12. **Gate `console.error` behind `__DEV__`.** Never log PHI strings. Android release logs visible via `adb logcat` over USB on shared clinic tablets. All `console.error` → `if (__DEV__) console.error(...)`.

13. **Stash/draft ops require user ID first.** `stashStorage`, `stashAudioManager`, `draftStorage` all user-scoped (cross-user leak on shared tablets). All expose `setUserId(userId)` — must be called before any read/write. Called in `fetchUser()` in `AuthProvider.tsx`. Cleanup (orphaned dirs, legacy migration, orphan drafts) runs **after** `setUserId`, never on a timer that could fire before `fetchUser`. Status-aware **30-day eviction** runs on Record-tab mount (`draftStorage.evictExpired()`+`stashStorage.evictExpired()`, each after `setUserId`): server-confirmed-uploaded drafts (>30d) deleted **silently** (server keeps the recording); un-sent drafts/stashes **never** auto-deleted — returned for a warn-first UI (Submit/Delete `Alert` ≥30d, heads-up ≥23d). Offline → uploaded-confirm branch deferred (status unverifiable). Pre-sign-out, `settings.tsx` `countUnsentRecordings()` warns when un-sent work remains.

14. **Upload URL validation fail-closed.** `validateUploadUrl()` in `sslPinning.ts` throws if `R2_BUCKET_HOSTNAME` empty. All uploads fail in prod if EAS secret missing — intentional; upload to unvalidated URL worse than failing.

15. **Validate segment URIs before accept.** `RESTORE_SESSION`+`REPLACE_ALL_SEGMENTS` in `useMultiPatientSession.ts` run `validateSegments()` → keep only local `file://` or absolute `/`. Blocks corrupted stash / compromised editor bridge injecting remote URL that exfiltrates audio on upload.

16. **Distinguish user sign-out from session expiry in `onAuthStateChange`.** Supabase emits `SIGNED_OUT` for explicit sign-out **and** expired/failed refresh; clearing on every one logs users out on transient network fail. Two refs in `AuthProvider.tsx`:
   - **`userInitiatedSignOutRef`** — `true` inside `handleSignOut()`, reset on next sign-in. `SIGNED_OUT` + this `false` → try one `refreshSession()` before clearing.
   - **`sessionRecoveryAttemptedRef`** — caps recovery at once per cycle; reset on successful sign-in or recovery.
   - Don't remove either or collapse paths → reintroduces "transient glitch logs out user" OR infinite recovery loop.

17. **Supabase session storage writes must read-back verify.** Post-rotate, old refresh token invalidated server-side; SecureStore silent fail → no valid refresh token → next refresh fails → logged out despite successful rotation. Adapter in `src/auth/supabase.ts`: `setItem` writes → reads back → retries once if differ; on throw, wait 1.5s + retry. Never simplify to bare `await secureStorage.setSession(value)`.

18. **Foreground-resume refresh reads current session, not closure.** `AppState` `'active'` handler in `AuthProvider.tsx` calls `supabase.auth.getSession()` inside handler. Closure over `session?.expires_at` → stale/null `expires_at` from SecureStore → refresh skipped. Effect deps stay `[]` (`supabase` module-singleton, `refreshPromiseRef` ref).

19. **Lazy-load optional native auth modules.** `@react-native-google-signin/google-signin`, `expo-apple-authentication`, `expo-crypto` — `require()` on first use in `src/auth/socialAuth.ts` and `src/lib/secureStorage.ts` (rule 21), **not** static import. Old dev-client APKs pre-these-deps → crash on module load if static. Google Sign-In Expo plugin in `app.config.ts` conditionally included only when `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` set (Android builds don't need it; unconditional → prebuild fails Android-only).

20. **Propagate new PatientSlot fields through stash round-trip.** Fields on `PatientSlot` affecting `uploadSlot` server behavior (`serverRecordingId`, `serverDraftId`, future idempotency keys) must land in all three: (1) `StashedSlot` type (`src/types/stash.ts`); (2) `stashAudioManager.moveSegmentsToStashDir()` write; (3) `useStashedSessions.convertToPatientSlots()` read + its local param type. Miss any → Resume strips field → Submit fresh-creates → duplicate server recording. Fix e.g. `397f109`.

21. **Security-critical random via `expo-crypto`, not global `crypto`.** Hermes on iOS does **not** expose `globalThis.crypto.getRandomValues` in RN 0.83.6 / Expo SDK 55 despite Hermes docs. Silent fallthrough to null → `secureStorage.getDeviceId()` null → `X-Device-Id` omitted → 401 `DEVICE_ID_REQUIRED` → forced sign-out loop (iOS launch-blocker, verified 2026-04-19). Pattern (`src/lib/secureStorage.ts`): prefer `require('expo-crypto').getRandomBytes(16)`, fall back to global `crypto.getRandomValues` only if unavailable. Also: `SecureStore.setItemAsync` w/ `kSecAttrAccessibleAfterFirstUnlock` sometimes fails on iOS Simulator — retry once without the attribute. Non-security randomness (idempotency keys in `src/api/recordings.ts`) may use Math.random; security-critical IDs (device ID, nonces) must not.

22. **`signIn` retries once on `AuthRetryableFetchError`.** GoTrue's auto-refresh timer leaves a stale `AbortController` after `signOut`; next `signInWithPassword()` rejects immediately with `AuthRetryableFetchError` (status 0, "Network request failed") → iOS sign-in loops. `signIn` in `AuthProvider.tsx` catches `error.name === 'AuthRetryableFetchError'` and retries once after 500ms (fresh `AbortController`). Do NOT call `supabase.auth.signOut({ scope: 'local' })` before sign-in — emits `SIGNED_OUT` → `onAuthStateChange` (rule 16) tries `refreshSession()` which hangs on the same poisoned controller (90s hang confirmed). Retry alone suffices.

23. **`registerDevice` detects phone vs tablet on both platforms.** Flat `Platform.OS === 'ios' ? 'ios_tablet' : 'android_tablet'` was wrong — every iPhone showed as "iPad", every Android phone as "Android Tablet". iOS uses `Platform.isPad`; Android uses `expo-device`'s screen-diagonal heuristic (`Device.deviceType === Device.DeviceType.PHONE`), lazy-`require`d (rule 19) so old dev-clients without expo-device don't crash, defaulting to `'android_tablet'` on `UNKNOWN`/unavailable. Result: `ios_tablet`/`ios_phone`/`android_tablet`/`android_phone`. `app/(app)/devices.tsx:formatDeviceTypeLabel` + `DeviceLimitModal.tsx` map all four. Server accepts `android_phone` (zod enum + `device_type TEXT` column, no policy gates on type — Connect repo). Don't revert Android to one-size `'android_tablet'`.

24. **UI-gating async work must have a hard timeout.** Any async call gating a render decision (`isLoading`, `isLocked`, `isReady`, loader early-return) must have a watchdog that flips the gate even if the Promise never settles. Native bridges (GoTrue auto-refresh `AbortController`, SecureStore Keystore reads on Direct Boot, biometric prompts, expo-audio ops, expo-file-system on locked storage) hang silently post-update / low-storage; `.finally()` never fires → user stares at spinner. Pattern in `AuthProvider.tsx` startup useEffect: `setTimeout(() => { captureMessage('auth_init_watchdog_fired', 'warning', ...); setIsLoading(false); }, 15_000)`, cleared in `.finally` (Sentry signal + silent recovery). `AppLockGuard` cold-start biometric uses 12s watchdog. Also add a tactical timeout inside (`withTimeout(supabase.auth.getSession(), 10_000, 'auth_init_get_session')`) so the user lands on a real screen 3–5s before the watchdog. Use both layers.

25. **MFA auth requests must use hardened network handling.** `mfaAuthRequest()` in `AuthProvider.tsx` keeps `ApiClient.request()` safety: build URL from `API_URL` then `validateRequestUrl(mfaUrl)` inside the `try`; `AbortController` + `MFA_REQUEST_TIMEOUT_MS`, always `clearTimeout(timeout)` in `finally`; send `Authorization`, `X-Device-Id`, `X-Supabase-Refresh-Token` when the route needs the refresh token; parse errors `await response.json().catch(() => ({})) ?? {}`; throw `ApiError` with `mfaErrorMessage(...)`, not raw `data.error`. `src/auth/mfaPolicy.ts` owns MFA error-code branching + safe messages; `app/(auth)/mfa.tsx` uses `isSetupApprovalCodeError()` + `mfaErrorMessage()`. Never display raw MFA server error text.

## Device Binding

Mobile sends `X-Device-Id` header every API req. UUID v4 gen'd on first launch, persisted in SecureStore (survives sign-out — device-scoped, not user-scoped). Server `validateDeviceSession` requires it, can revoke specific devices.

- `secureStorage.getDeviceId()` — gen + cache UUID.
- `ApiClient.doFetch()` — memory-caches device ID after first SecureStore read.
- MFA bearer routes in `mfaAuthRequest()` also send `X-Device-Id`; don't route around device binding for auth-only endpoints.
- `AuthProvider.registerDevice()` — called on sign-in AND session restore; **must return `boolean`** so `ApiClient` can retry after auto-register.
- Server `DEVICE_REGISTRATION_REQUIRED` (428) → `ApiClient` calls `registerDevice()` via `onDeviceRegistrationRequired` callback, retries once. Any `/api/*` call from a never-registered device returns 428 — do NOT treat 428 as fatal in new code.
- Server `DEVICE_REVOKED` (401) → force sign-out + msg. `DEVICE_ID_REQUIRED` (401) → "restart or reinstall" msg (Keystore fail).

## EAS Build Notes

- **Secrets:** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — EAS project-level (not `eas.json`). After `.env` edit → `eas secret:push --scope project --env-file .env --force` (stale EAS secret overrides local `.env` in prod) AND `npx expo start --clear` (Metro inlines `EXPO_PUBLIC_*` at build time → stale cache).
- **Credentials:** preview + production → `credentialsSource: "remote"` (EAS-managed).
- **Store releases must bump the marketing version first:** before any AAB/IPA intended for Google Play Console or Apple Developer/App Store Connect, increment the public app version in `app.config.ts`, `package.json`, and `package-lock.json` (for example `1.12.4` → `1.12.5`) and commit it. EAS `autoIncrement` only bumps Android `versionCode` / iOS `buildNumber`; that is not sufficient for store release builds. If a store build was started without a marketing-version bump, cancel it or discard the artifact and rebuild after the bump. `AGENTS.md` is a symlink to this file, so this rule applies there too.
- **APK builds:** use profile `production-apk`, NOT `production` (which builds an AAB): `npx --yes eas-cli@latest build --platform android --profile production-apk --non-interactive`. Managed project, no committed `android/`; local APKs require `eas build --local` or `expo prebuild` + local Android/JDK/signing.
- **Lock file:** sync via `npm install --legacy-peer-deps` pre-build if deps change (EAS `npm ci` fails on mismatch). `.npmrc` has `legacy-peer-deps=true` for `@config-plugins/ffmpeg-kit-react-native` peer conflict w/ SDK 55.
- **FFmpeg Maven (Android):** `com.arthenica:ffmpeg-kit-min` removed from Maven Central. Self-hosted `https://homeless-pets-foundation.github.io/ffmpeg-kit-maven`, wired in `app.config.ts` `extraMavenRepos` (Gradle 9). **Current: `6.0-3`** (16KB page-size, from `arthenica/ffmpeg-kit` `development`). Rebuild: `Homeless-Pets-Foundation/ffmpeg-kit-maven` → Actions → "Build FFmpeg Kit min (16KB page size)".
- **ffmpeg-kit-react-native patch:** `patches/ffmpeg-kit-react-native+6.0.2.patch` overrides AAR `6.0-2` → `6.0-3` in pkg `gradle.properties`. Applied via `postinstall: patch-package`. Bump AAR → update patch version string.
- **FFmpeg CocoaPods (iOS):** `ffmpeg-kit-ios-min@6.0` trunk podspec 404s (arthenica sunset iOS releases). Self-hosted at `ffmpeg-kit-maven/ios/6.0-3/`. `plugins/with-ffmpeg-ios-pod-source.js` injects `pod 'ffmpeg-kit-ios-min', :podspec => '<URL>'` into the Podfile before `use_native_modules`; registered in `app.config.ts` right after `@config-plugins/ffmpeg-kit-react-native`. URL in `DEFAULT_PODSPEC_URL`, currently `raw.githubusercontent.com/...` (Pages flaky due to billing cap); flip to Pages URL when healthy. Rebuilding xcframework needs Apple Silicon Mac (`./ios.sh --xcframework --disable-armv7 --disable-armv7s --disable-i386 --disable-arm64-mac-catalyst --disable-x86-64-mac-catalyst`, zip the 8 xcframeworks at zip root). GH Actions `build-ios-xcframework.yml` exists but billing-gated.
- **`preview-simulator` profile:** standalone iOS sim `.app` w/ JS bundle baked in (no dev-client / Apple creds). `eas build --platform ios --profile preview-simulator` → install on a Mac's iOS Simulator for visual smoke tests. Not a real-device path.
- **`sharp` in `optionalDependencies`, not `devDependencies`:** used only by `scripts/generate-icons.mjs` locally. As devDep, EAS `npm ci --include=dev` blew up on macOS arm64 (no `node-addon-api`). Optional deps non-fatal on install failure. Keep it there.
- **Expo doctor:** `npx expo-doctor` before every EAS build (auto via `.claude/hooks/pre-eas-build.sh`). Dependabot bumps past SDK compat → `npx expo install --fix`.
- **APP_VARIANT:** `app.config.ts` exposes `extra.isProduction` from `APP_VARIANT=production`; gates prod-only features at runtime. Screen-capture prevention (`expo-screen-capture` `FLAG_SECURE`) was **removed** (2026-05-29; vet records not HIPAA, screenshots wanted) — do not re-add. Dep stays installed-but-unused; `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` blocks in `app.config.ts` remain valid.
- **Reading expo.dev (EAS cloud) build logs when a build fails — logs are GZIP-encoded:** When an `eas build`/`eas submit` fails, **diagnose it yourself — do not ask the user to paste the log.** The `eas-cli` only prints a one-line summary (e.g. `Unknown error. See logs of the Install pods build phase`); `eas build:view <id>` shows metadata (status/commit/artifact URLs) but **no log text**; and the expo.dev build page is auth-gated, so `WebFetch` and unauthenticated `curl` cannot read it. Pull the per-phase log via the **Expo GraphQL API** with the eas-cli session token:
  1. **Token:** `~/.expo/state.json` → `auth.sessionSecret`; send as header `expo-session: <secret>` to `https://api.expo.dev/graphql` (or `Authorization: Bearer $EXPO_TOKEN` if set).
  2. **Query:** `query($id:ID!){builds{byId(buildId:$id){status logFiles error{errorCode message}}}}` → `logFiles[0]` is a **signed GCS URL** (expires ~15 min, so re-query each time).
  3. **Download with `curl --compressed`** — the GCS object is **gzip-encoded**; plain `curl -o` / `gzip -dc` yields binary garbage or 0 bytes. Decompressed it is **NDJSON** (one JSON object per line, each with `phase` + `msg`); grep the failing phase (`INSTALL_PODS`, `RUN_FASTLANE`, `RUN_GRADLEW`, `PREBUILD`, `READ_APP_CONFIG`) for the real error.
  - Helper: `~/eas-buildlog.sh <BUILD_ID> [grep_regex]` does all of the above (re-mints a fresh signed URL each run). Workflow: fail → fetch log → diagnose → fix (usually a config plugin / Podfile mod / dep pin) → rebuild → resubmit.
- **GoogleSignIn iOS static-library pod fix:** `@react-native-google-signin/google-signin` (GoogleSignIn 9.x) pulls `AppCheckCore` (a Swift pod) whose non-modular transitive deps `GoogleUtilities` + `RecaptchaInterop` can't integrate under the iOS static-library framework build — `pod install` fails: *"The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and `RecaptchaInterop`, which do not define modules."* `plugins/with-ios-modular-headers.js` injects `pod '<name>', :modular_headers => true` for those two before `use_native_modules` (mirrors `with-ffmpeg-ios-pod-source.js`); registered in `app.config.ts` **only inside the `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` block** so non-Google builds don't pull the pods in. If a *different* Swift pod throws the same "do not define modules" error after a dep bump, add it to the plugin's pod list. Fixed in PR #90 (cloud iOS build was failing at INSTALL_PODS).

## Emulator Testing (WSL2)

Metro in WSL2; emulator on Windows. All `adb` → **Windows** ADB binary (`adb.exe`), not WSL2 `adb`.

### Setup & Launch

1. **Start emulator:** `"/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/emulator/emulator.exe" -avd Medium_Phone_API_36.1 -no-snapshot-load &>/dev/null &`
2. **Wait:** `"/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" devices`
3. **ADB reverse** (emulator localhost → Windows localhost): `…/adb.exe reverse tcp:8081 tcp:8081`
4. **Port proxy** (Windows localhost → WSL2 IP, admin req):
   ```bash
   WSL_IP=$(ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
   powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1; netsh interface portproxy add v4tov4 listenport=8081 listenaddress=127.0.0.1 connectport=8081 connectaddress=$WSL_IP' -Verb RunAs"
   ```
5. **Start Metro:** `npx expo start --clear`
6. **Deep-link app:** `…/adb.exe shell am start -a android.intent.action.VIEW -d 'captivet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'`

Port 8081 busy → `lsof -ti:8081 | xargs kill -9`.

### ADB UI Interaction (all Windows ADB)

| Action | Command |
|--------|---------|
| Screenshot | `adb.exe exec-out screencap -p > /tmp/screen.png` (view via Read) |
| Tap | `adb.exe shell input tap <x> <y>` (px, 1080x2400) |
| Swipe/Scroll | `adb.exe shell input swipe <x1> <y1> <x2> <y2> <ms>` |
| Type text | `adb.exe shell input text "hello"` (spaces → `%s`) |
| Press back | `adb.exe shell input keyevent KEYCODE_BACK` |
| Dismiss keyboard | `adb.exe shell input keyevent 66` (ENTER — safer than ESCAPE) |
| UI hierarchy | `adb.exe shell uiautomator dump /sdcard/ui.xml && adb.exe shell cat /sdcard/ui.xml` |

**Keycode gotcha:** `KEYCODE_ESCAPE` (111) + `KEYCODE_MENU` (82) → Expo dev element inspector → intercepts taps → session unworkable. Dismiss keyboard via neutral tap or ENTER (66); reload via `Reload` in dev menu, not MENU; toggle off `Tools button` at session start (steals taps near top-right where `Save for Later` sits). Inspector stuck → `am force-stop com.captivet.mobile` + relaunch.

**Emulator upload limit:** `hasSilentAudioOnly()` uses `peakMetering` at record-time; emulator mic peaks ≤ −20 dBFS → every Submit throws "This recording appears silent" **before** API call. Upload-path regressions (e.g. `serverDraftId` promotion) verifiable only by count-doesn't-bump on emulator; full server path = physical device.

**Tap coords:** prefer `uiautomator dump` (`bounds="[left,top][right,bottom]"`, center = midpoints; filter `grep -iE "button_text|content_desc"`). Fallback: screenshot + Read + estimate (1080x2400). Dump fails mid-animation ("could not get idle state").

### Key App Flows

- **Record:** Home → Record tab / "Record Appointment" → fill Patient Name, Client Name, Species, Appointment Type → scroll → "Start recording" → "Finish".
- **Stash:** during/after record → "Save for Later" (top-right) → "SAVE" → under "Saved Sessions" w/ "Resume Session".
- **Edit:** post-record → "Edit Recording" → waveform, trim handles, playback, "Apply Trim"/"Done".
- **Draft-save-on-finish:** Finish → server `status='draft'` + local draftStorage → "Not Submitted" (amber) → tap card → reopens Record. Submit → promotes draft in place (no duplicate).
- **App package:** `com.captivet.mobile`. Launch: `adb.exe shell am start -n com.captivet.mobile/.MainActivity`.

## File Conventions

- `src/lib/secureStorage.ts` — sole `expo-secure-store` interface (all try/catch). `getDeviceId()` → persistent UUID v4, memory-cached; uses `expo-crypto.getRandomBytes` primary, global `crypto.getRandomValues` fallback (rule 21). `setItemAsync` has keychainAccessible-less retry for iOS Sim. `DEVICE_ID` NOT deleted in `clearAll()` (device-scoped).
- `src/lib/biometrics.ts` — sole `expo-local-authentication` + biometric pref interface, all wrapped.
- `src/lib/fileOps.ts` — safe wrappers around `expo-file-system` `File`/`Directory`. Use `safeDeleteFile`/`safeDeleteDirectory`, never `.delete()` direct. Never import `expo-file-system/legacy` in new code.
- `src/lib/secureClipboard.ts` — 30s auto-clear clipboard. `clearClipboard()` for sign-out.
- `src/lib/audioEditorBridge.ts` — singleton bridging `record.tsx` ↔ `audio-editor.tsx`. `clear()` for sign-out.
- `src/lib/stashStorage.ts` — encrypted stash metadata, chunked (Android 2KB limit). **User-scoped** (keys prefixed w/ user ID); `setUserId()` first. `clearLegacyGlobalStashes()` one-time migration.
- `src/lib/stashAudioManager.ts` — stashed audio in `documentDirectory/stashed-audio/{userId}/`. `setUserId()` first; session IDs validated vs path traversal. `moveSegmentsToStashDir` persists `serverDraftId`/`draftSlotId` (rule 20).
- `src/lib/draftStorage.ts` — local audio draft persistence. SecureStore metadata (chunked) + audio at `documentDirectory/drafts/{userId}/{slotId}/`. **User-scoped**; `setUserId()` first. `saveDraft`/`getDraft`/`listDrafts`/`deleteDraft`/`clearAll`. `syncPending(createFn)` retries unsynced server-draft creations on reconnect. `cleanupOrphaned(deleteFn)` on Record mount sweeps entries w/ missing local audio + deletes server row.
- `src/config.ts` — env var access + graceful fallback. Exports `CONFIG_MISSING`.
- `src/constants/strings.ts` — centralized UI labels (`PROCESSING_STEP_LABELS`, `UPLOAD_OVERLAY_COPY`, `SOAP_SECTION_ACTIONS`). Add new labels here (one grep surfaces every site; i18n precursor).
- `app/_layout.tsx` — gates app on `CONFIG_MISSING` before providers mount. Root `ErrorBoundary` wraps tree.
- `src/components/ui/Button.tsx` — shared button + haptics, optional `icon`. `Haptics.impactAsync` has `.catch()`. No shadow on `ghost`. Every press flows here.
- `src/hooks/useAudioRecorder.ts` — wraps expo-audio. `audioSource: 'voice_recognition'` on Android. `stop()` swallows; `pause()`/`resume()` catch+cleanup+rethrow. `resetWithoutDelete()` keeps file; `reset()` deletes file. Auto-releases on unmount.
- `src/hooks/useMultiPatientSession.ts` — `useReducer` multi-patient state. ≤10 `PatientSlot`s w/ `segments[]`, recorder binding, upload status, `CONTINUE_RECORDING` for multi-segment. `RESTORE_SESSION`+`REPLACE_ALL_SEGMENTS` validate URIs. `SET_DRAFT_IDS` sets `draftSlotId`+`serverDraftId`.
- `src/hooks/useStashedSessions.ts` — stash list + resume. `stashSession` moves segments to stash dir, writes metadata, then `draftStorage.deleteDraft()` for every slot w/ `draftSlotId` (stash owns audio post-commit). `convertToPatientSlots` restores `serverDraftId`/`draftSlotId`.
- `src/types/multiPatient.ts` — `PatientSlot` (incl. `draftSlotId`/`serverDraftId`), `AudioSegment`, `SessionAction`, `SessionState`.
- `src/types/stash.ts` — `StashedSlot`/`StashedSegment`/`StashedSession`. `StashedSlot` carries optional `serverDraftId`/`draftSlotId` (rule 20).
- `app/(auth)/mfa.tsx` — MFA challenge/enrollment. `react-native-qrcode-svg` for TOTP QR. RN callbacks wrap async w/ `.catch(() => {})`.
- `src/auth/mfaPolicy.ts` — safe MFA error-code handling + UI messages. Keep setup approval-code checks here; add tests in `tests/security-mfa.test.mjs` for new MFA codes.
- `src/auth/AuthProvider.tsx` — `handleSignOut` clears only transient caches before clearing state; recordings (drafts/stashes/`RECOVERY_INTENT`) are preserved across logout, `support_staff` additionally preserved to recovery vault (rule 8). `fetchUser()` calls `setStashUserId()`+`draftStorage.setUserId()`. `registerDevice()` on sign-in + restore, sends `ios_phone`/`ios_tablet`/`android_phone`/`android_tablet` via `Platform.isPad` (iOS) + `expo-device` (Android) (rule 23). `signIn` retries on `AuthRetryableFetchError` (rule 22). MFA helpers here; `mfaAuthRequest()` follows rule 25.
- `plugins/with-ffmpeg-ios-pod-source.js` — local Expo plugin inserting `pod 'ffmpeg-kit-ios-min', :podspec => '<self-hosted URL>'` into iOS Podfile via `withDangerousMod`. Registered after `@config-plugins/ffmpeg-kit-react-native`. URL in `DEFAULT_PODSPEC_URL`. Don't remove — else `pod install` 404s on arthenica zip.
- `src/api/client.ts` — sends `X-Device-Id` all reqs, memory-caches it. Handles `DEVICE_REGISTRATION_REQUIRED` (428) via `onDeviceRegistrationRequired` → `registerDevice()` + retry once. Handles `DEVICE_REVOKED`/`DEVICE_ID_REQUIRED` 401s before token refresh.
- `src/api/recordings.ts` — `createWithFile()` single, `createWithSegments()` multi. Both validate via `getInfoAsync()`, 250MB limit, 10min timeout. Both take optional `existingRecordingId` → skips `create()`, uses server draft as recording ID (promote path).
- `src/components/AppLockGuard.tsx` — biometric on cold start (not just bg resume). Defaults `isLocked=true` + blank screen until biometric done (no PHI flash). Sign-out = escape hatch.
- `src/components/PatientSlotCard.tsx` — per-patient form + recording + upload status. "Finish" (not "Stop") w/ checkmark. "Delete & Start Over" = de-emphasized text link.
- `src/components/PatientTabStrip.tsx` — horizontal tab strip to switch slots, status badges.
- `src/components/SubmitPanel.tsx` — bottom panel w/ "Submit All", visible when multiple slots ready.
- `src/components/RecordingCard.tsx` — list item. `status='draft'` → amber "Not Submitted". Tap → `/(tabs)/record?draftSlotId=X` (resume) if local draft exists, else detail.

## UI Gotchas

**Text truncation is a render bug, not a typo.** "Cop" for "Copy", "Transcribin" for "Transcribing", clipped captions — Android TextView under-measures single-word `<Text>` in flex-row parents and clips the last glyph; `flex-row` labels without `flex-1` truncate silently (no ellipsis, `numberOfLines` unset). Grep the FULL word in source before assuming a typo — it's there, spelled right. Fixes:
- **Row labels w/ long content** (stepper, list items): `flex-1` on Text + `numberOfLines={2}` to claim row space + wrap.
- **Short-word action buttons** (Copy, Copy All): trailing-space literal (`` `${label} ` ``) + `style={{ flexShrink: 0, paddingRight: 2 }}` on Text + `flexShrink: 0` on sibling icons. **Inline comment required** — the trailing space looks like lint debris.
- **Centered captions in narrow cards** (UploadOverlay): reduce outer padding (`px-8`→`px-6`), prefer shorter active-voice phrasing.
- Never `numberOfLines={1}` on single-word Text in a `self-end` Pressable (→ `"Co..."`). Verify on physical Android; iOS + emulator hide this class.

## Monitoring & Analytics

Three layers, all env-gated + PHI-scrubbed. Each silently no-ops if its key is missing (rule 1).

| Layer | Module | Purpose | Key |
|---|---|---|---|
| Crash + error | `src/lib/monitoring.ts` (`@sentry/react-native`) | Stack traces, breadcrumbs, releases | `EXPO_PUBLIC_SENTRY_DSN` |
| Product analytics | `src/lib/analytics.ts` (`posthog-react-native`) | Funnel events, user ID | `EXPO_PUBLIC_POSTHOG_KEY` |
| Server telemetry | `src/api/telemetry.ts` → `POST /api/telemetry/client-error` | Non-network client failures tied to a recording row | (existing auth) |

- **Event catalog** = `AnalyticsEvent` discriminated union in `analytics.ts` (single source of truth; not listed → won't compile, prevents ad-hoc PHI events): `session_start`, `session_signed_in{auth_method}`, `session_signed_out{trigger}`, `recording_started/paused/resumed/finished/discarded`, `submit_attempted/succeeded/failed{error_phase,error_code}`, `stash_saved/resumed/discarded`, `submit_all_attempted/completed`.
- **Error phase tagging:** upload errors phase-tagged at throw sites in `recordings.ts` via `tagPhase()`/`phaseError()`. Phases: `silent_check`, `presign`, `r2_put`, `confirm`, `create_draft`, `unknown`. `uploadSlot` in `record.tsx` reads `getUploadPhase(error)` in catch → routes to all three layers. Do NOT pattern-match error messages — tag at the throw site.
- **PHI scrubbing:** (1) Never put patient/client names, transcript, or form fields in events/errors — event types forbid it; Sentry `beforeSend` redacts PHI-shaped keys + strips `file://`. (2) Never `captureException(err)` on an error carrying form data; if about to pass `slot.formData` anywhere, stop. (3) `reportClientError()` truncates `message` to 512 chars + strips file paths; server re-scrubs. (4) Identify by `user_id` only (`setMonitoringUser`/`identifyUser(userId, orgId)`) — never email/name. (5) No session replay, screen capture, or navigation autocapture (PostHog disables all three).
- **Server table:** `ClientTelemetry` Prisma model (`packages/database/prisma/schema.prisma`) → `client_telemetry`, indexed on `(organization_id, created_at)`, `(user_id, created_at)`, `recording_id`, `error_code`, `phase`. One-query view: `SELECT phase, error_code, network_state, attempt_number, app_version, message, created_at FROM client_telemetry WHERE recording_id = '<uuid>' ORDER BY created_at DESC;`
- **Releases:** Sentry release ID auto from `Application.nativeApplicationVersion`+`nativeBuildVersion`; `@sentry/react-native/expo` plugin uploads source maps during EAS build. Missing source maps → check EAS logs for `sentry-cli` upload + `SENTRY_AUTH_TOKEN` set as EAS **build-time** secret (not runtime `EXPO_PUBLIC_*`).
- **Dev:** Sentry disabled in dev (`enabled: !__DEV__`); test locally via `EXPO_PUBLIC_SENTRY_ENABLE_IN_DEV=true` + `--clear`. PostHog logs `[PostHog] Initialized` when active.

## Multi-Patient Recording Architecture

`app/(app)/(tabs)/record.tsx` → ≤10 patients/session, each a "slot" as a horizontally-pageable card.

**Data model** (`src/types/multiPatient.ts`): `AudioSegment` = `{ uri, duration }` (one continuous file). `PatientSlot` = form data (`CreateRecording`), `audioState` (`idle`|`recording`|`paused`|`stopped`), `segments[]`, upload lifecycle (`uploadStatus`, `uploadProgress`, `uploadError`, `serverRecordingId`), draft linkage (`draftSlotId`, `serverDraftId`). `SessionState` = `{ slots, activeIndex, recorderBoundToSlotId }`. `SessionAction` = discriminated union. Max 10 enforced in `ADD_SLOT`.

**Recorder ownership:** single `useAudioRecorder` shared; one owner via `recorderBoundToSlotId`. `BIND_RECORDER` on start; `UNBIND_RECORDER` after capture (`recorder.state === 'stopped'` effect). Pending-start queue: new start while another active → stop current via `pendingStartSlotRef`, post-stop the pending slot auto-starts via `startRecordingRef`. Auto-pause on swipe-away (`handleScrollEnd`); pause fail (rethrown) → stop fallback. Consistency guard: effect watching `recorderBoundToSlotId` forces orphaned `recording` slot back to `stopped` (w/ segments) or `idle`.

**Multi-segment:** each slot's `segments[]` = source of truth. `SAVE_AUDIO` appends + sums duration. `CONTINUE_RECORDING` → `idle` + hook `resetWithoutDelete()` (keeps file). Upload: `uploadSlot()` → `createWithFile()` (single) or `createWithSegments()` (multi uploads each segment to own presigned URL, confirms w/ all keys).

**Concurrency guards (refs in `record.tsx`):** `audioCaptureDoneRef` (prevents stopped-effect double-save), `pendingStartSlotRef` (queues next slot), `startRecordingRef` (stable ref, avoids stale closure), `stoppingRef` (in hook, prevents double-stop), `isScrollingRef` (suppresses programmatic `scrollToIndex` during swipe), `swipeChangeRef` (prevents `activeIndex` effect re-scrolling after swipe).

**Upload state machine** (per-slot `pending` → `uploading` → `success`|`error`): `uploadSlot(slot)` → `string | null`; skip if uploading/succeeded; `slot.serverDraftId` set → spreads `existingRecordingId` → promotes draft in place (no duplicate). Single submit (`handleSubmitSingle`): other slots unsaved → stay; else reset + nav to detail. Submit all (`handleSubmitAll`): all eligible slots **sequentially** (no network saturation); full success → reset + nav to list, partial fail → alert + stay. Post-upload: delete local audio + local draft metadata (if `draftSlotId`).

**Nav & cleanup:** `usePreventRemove` blocks nav when `unsavedCount > 0` (discard confirm w/ count). Discard → iterate slots + `FileSystem.deleteAsync` all segments. `resetSession` dispatches `RESET_SESSION` (record tab stays mounted across navigations → no reset = stale state).

## Draft-Save-on-Finish

Finish → server `status='draft'` + local `draftStorage` entry → Home/Records "Not Submitted" (amber). Tap card → Record w/ form + audio preloaded via `loadDraft(draftSlotId)`.

1. **Finish** → `autoSaveDraft(slot)` in `record.tsx`: `draftStorage.saveDraft(slot)` copies audio to `drafts/{userId}/{slotId}/`, writes SecureStore metadata (`pendingSync: true`). Online → `recordingsApi.create(formData, { isDraft: true })` → `updateServerDraftId()` + `pendingSync: false`; offline → stays pending, retried on NetInfo reconnect via `draftStorage.syncPending()`. `dispatch SET_DRAFT_IDS` → slot gets `draftSlotId`+`serverDraftId`.
2. **Stash** — `stashSession` moves segments to stash dir, writes payload (incl. `serverDraftId`/`draftSlotId`), **then** `draftStorage.deleteDraft(draftSlotId)` (stash owns audio). Server draft row stays.
3. **Resume** — `useStashedSessions.resumeSession` → `convertToPatientSlots` restores `draftSlotId`+`serverDraftId` (rule 20). `audioState: stopped`, ready to submit.
4. **Submit** — `uploadSlot()` sees `serverDraftId` → adds `existingRecordingId` → server promotes draft in place (no duplicate). Post-success: `deleteDraft(draftSlotId)` + local audio delete.
5. **Orphan sweep** — Record mount runs `draftStorage.cleanupOrphaned(recordingsApi.delete)` → drafts w/ missing local audio → delete server row + local metadata. Clears "Not Submitted" zombies from older clients that stashed before rule 20.

**Storage layout:** local metadata in SecureStore `captivet_draft_{userId}_{slotId}_meta` + chunks (2KB workaround), index `captivet_drafts_index_{userId}`; local audio `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a`; server `Recording` row `status='draft'` (server `confirmUpload` allows `draft → uploading`).

**Sign-out cleanup:** local drafts/stashes are **preserved** across logout (rule 8); `handleSignOut` clears only transient caches. Drafts removed only by post-upload cleanup or the warn-first 30-day eviction (rule 13).

## Codex Review Guidelines

Codex GitHub review should flag only serious, merge-relevant issues. Focus on correctness, security, data isolation, secret handling, auth/session flows, billing or payment logic, production deploy risk, migrations, and missing tests for changed behavior.

- Prefer concrete findings with file/line references and the smallest safe fix.
- Do not raise style-only comments, broad rewrites, or low-confidence guesses.
- Check that user input, credentials, tokens, private data, and logs are handled safely.
- Check that API/database changes preserve tenant or account boundaries where applicable.
- Check that schema, migration, configuration, and environment changes are documented and backwards compatible.
- Check that new behavior has tests or a clear reason tests are not practical.
- Treat generated files, lockfiles, and vendored assets as low priority unless they affect runtime behavior or supply-chain risk.

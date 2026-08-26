# iOS Simulator Test Results — 2026-08-25

Execution of [`ios-simulator-build-and-test-plan-2026-08-25.md`](./ios-simulator-build-and-test-plan-2026-08-25.md)
(revision 2). This is the **first time this app has ever been run on iOS**.

> **PHI:** this build signs into production, so every authenticated screen renders real patient and
> client data. Per the plan's PHI rule, nothing below quotes an accessibility dump, names a patient
> or client, or embeds a screenshot of an authenticated screen. Screenshots live in the session
> scratchpad and on the Mac under `~/shots/`. Counts and statuses are cited without identifiers.

## 1. What was built

| | |
|---|---|
| Commit | `0fb17c2` on `fix/request-amplification-latency` — tree **identical** to `origin/main` |
| Marketing version | 1.13.19 (`CFBundleShortVersionString` 1.13.19, `CFBundleVersion` 1) |
| Profile | `preview-simulator` (`APP_VARIANT=preview`, `ios.simulator: true`), `eas build --local` |
| Bundle id | `com.captivet.mobile` |
| Artifact | `~/builds/captivet-ios-sim-1.13.19.tar.gz`, 40,177,493 bytes (`Captivet.app` ≈ 115 MB) |
| Build result | `IOS_BUILD_EXIT=0`, `Build Succeeded` |
| Build duration | 20:33:49 → 20:40:32 UTC = **6 min 43 s** (warm npm cache, cold Pods) |
| Durable capture | `EXPO_PUBLIC_FORCE_DURABLE_CAPTURE` **unset** — production-faithful; the server flag governs |
| Sentry / PostHog | both **live** (release bundle). Source-map upload disabled (`SENTRY_DISABLE_AUTO_UPLOAD=true`) |
| Env var names supplied | `API_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_BUCKET_HOSTNAME`, `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_IOS_URL_SCHEME`, `SENTRY_DSN`, `POSTHOG_KEY`, `POSTHOG_HOST` (values not recorded) |
| Devices | `QUAL-iPhone-17-Pro-Max-26.5` (440×956 pt, 3×) · `QUAL-iPad-Air-11-M3-26.5` (820×1180 pt, 2×), iOS 26.5 |

Both local Expo native modules compiled and linked; `pod install` completed with the self-hosted
`ffmpeg-kit-ios-min` podspec and the AppCheckCore/GoogleUtilities modular-headers plugin, i.e. the
same native surface a production iOS build uses. Both `patch-package` patches applied
(`expo-audio@55.0.16 ✔`, `ffmpeg-kit-react-native@6.0.2 ✔`).

### Preflight

| Check | Result |
|---|---|
| `npm test` | **849/849 pass**, 0 fail, 77 files, 9.6 s |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npx expo-doctor` | 19/20 — the one failure is 22 **patch**-level dependency drifts, pre-existing on `main` and deliberately not fixed (see [F-07](#f-07--expo-doctor-drift-two-different-things-in-one-warning)) |
| Ship integrity | 428/428 files, 5+1 module Swift files, 2 podspecs, 11 PNG assets, font present |

## 2. Pass/fail

| # | Item | iPhone | iPad | Evidence |
|---|---|---|---|---|
| A.1 | Device registration on a never-registered device | **PASS (partial evidence)** | **PASS (partial evidence)** | Registration succeeded silently on both sims — each appears under Manage Devices with the right type, and org capacity moved 16→17 as the second registered. Nothing was surfaced to the user. **Caveat:** `registerDevice()` is also called directly on sign-in, so this does not prove the `DEVICE_REGISTRATION_REQUIRED` (428) → auto-register → retry-once path in `ApiClient` specifically fired; that branch is not observable from the UI |
| A.2 | Bad password | **PASS** | n/t | "Invalid email or password" banner; no crash, no stuck spinner, no log anomaly |
| A.3 | Real credentials → Home | **PASS** | **PASS** | Sign-in completed and Home rendered fully populated on both devices; no error state, no stuck spinner, no sign-in loop. **Caveat:** the rule-24 watchdog reports via Sentry `captureMessage`, which is not observable from here — the only client-visible symptom of a fire (landing on login despite a valid session) never occurred across sign-in plus 3 relaunches |
| A.4 | Relaunch ×3 → Keychain session restore | **PASS** | n/t | 3/3 relaunches landed on Home, never on login |
| A.5 | Background → foreground (rule 18) | **PASS** | n/t | `idb ui button HOME` → `simctl launch`; returned to Home with the session intact and no forced sign-out. The refresh itself is not directly observable; the assertion is the absence of the regression rule 18 exists to prevent |
| A.6 | Cold-start splash (iOS native path) | **PASS** | **PASS** | No flash, no hang; `SplashGate` is Android-only so this is the never-exercised path |
| A.7 | MFA | **N/A** | **N/A** | The test account is not MFA-enrolled — sign-in completed with no challenge |
| B | Device type label (rule 23) | **PASS** | **PASS** | Manage Devices shows `iPhone · v1.13.19` for the phone sim and `iPad · v1.13.19` for the tablet sim. **First-ever iOS verification of `Platform.isPad` → `ios_phone`/`ios_tablet`.** See [F-05](#f-05--device-name-is-simulator-ios--expected-but-unverified-on-real-hardware) |
| B | `useDeviceCapacity` + `DeviceLimitModal` | **PASS** | **PASS** | Capacity banner rendered a truthful count ("16 of 20" → "17 of 20" after the iPad registered) with a working Manage action; the Devices list rendered the fleet with per-device type, app version and last-active, an "Approaching limit" chip, and a revoke action on every row **except** the current device. `DeviceLimitModal` itself never triggered — capacity stayed under the cap |
| C | 19 routes | **18/19 rendered, 1 guard-only** | walk-through PASS | 18 screens rendered and were inspected; `mfa` could only be verified at the guard level because the account is not enrolled, so there is no challenge for it to render. See [§3](#3-route-coverage) |
| D | Light / dark, both geometries | **PASS** | **PASS** | Dark mode correct on Home, Settings, Local Recovery, Recovered Recordings; contrast and brand colours adapt; no clipping |
| D | Largest Dynamic Type | **FAIL → FIXED** | **FAIL → FIXED** | The 1.3× cap was not applied — measured **3.58×** (iPhone) / **3.57×** (iPad). Fixed after the run and re-measured on a rebuilt app at **1.30×**. See [F-01](#f-01--p0--the-global-text-patch-is-a-no-op-on-rn-083--fixed) and [F-02](#f-02--device-capacity-banner-overflows-at-large-dynamic-type--fixed-by-f-01) |
| E | Sign-out data preservation (rule 8) | **PASS** | n/t | Baseline before sign-out: 2 rows, both `status draft`, both "audio not on this device", against 2952 total. Signed out (**no** unsent-work warning — correct, nothing local existed), signed back in: **both rows still present with identical status**. `clearTransientCaches()` preserved them, and presence reconciliation re-established them after `queryClient.clear()` |
| — | `DEVICE_REVOKED` force sign-out (bonus) | n/a | **PASS** | Revoking the iPad from the iPhone force-signed-out the iPad to login with a message and no crash — but it is the wrong message, see [F-06](#f-06--an-admin-revoked-device-is-told-its-session-expired) |
| F | Biometrics | **PARTIAL** | n/t | Enrolment via `notifyutil` works and unhides the Face ID Lock row; `authenticateAsync` never presents a prompt over SSH, so enable/lock/unlock are not drivable. No crash — the toggle simply stays off |
| — | Recording → upload | **BLOCKED** | **BLOCKED** | Capture cannot start on this hardware. See [F-04](#f-04--recording-cannot-start-on-the-simulator--and-fails-correctly) |

`n/t` = not tested on that device by design (the plan runs the full matrix on the iPhone and the
device-identity/geometry subset on the iPad).

## 3. Route coverage

| Group | Routes | Status |
|---|---|---|
| `(auth)` | `login` | **PASS** — email field, password field with show/hide, Forgot password link, Sign In, Apple and Google buttons all render |
| `(auth)` | `forgot-password` | **PASS** — "Reset password" heading, explanatory body, required Email field, Send reset link, Cancel |
| `(auth)` | `reset-password` | **PASS** (via `captivet:///reset-password`) — "Set new password", New password + Confirm password (both `At least 8 characters`), show/hide, Update password, Cancel |
| `(auth)` | `mfa` | **GUARD-ONLY** — `captivet:///mfa` correctly **bounces to login** instead of rendering a challenge (`mfa.tsx:97-98` redirects when `!isAuthenticated`). Refusing to render without a pending factor is the right behaviour, but it means **the MFA UI itself was never seen**: the challenge screen, the TOTP QR enrolment, and `mfaPolicy`'s error copy all remain unverified on iOS. Needs an MFA-enrolled account, not different hardware |
| `(tabs)` | `index` (Home) | **PASS** — org name (#176), device-capacity banner, attention section, Record CTA, recent-patient card, stat tiles, Not-Submitted list, recent recordings, Clinic Quality card |
| `(tabs)` | `record` | **PASS** — patient tab strip, "Patient 1 of 1", timer, Start recording, collapsible patient form, Foreign Language toggle |
| `(tabs)` | `recordings/index` | **PASS** — search field, status filter, list |
| `(tabs)` | `recordings/[id]` | **PASS** — AI-flagged banner, patient/species/type/date block, audio permission gate, Reprocess action, Suggested Tasks with Accept/Dismiss |
| `(tabs)` | `recordings/attention` | **PASS** — "Needs you (1)" + "Across the practice (18)"; practice rows render **without** a collapse toggle, confirming PR #161 on iOS |
| `(tabs)` | `patient/index`, `patient/[id]` | **PASS** — search + list; detail with Summary/Visits/Profile segments and an empty-summary state with a generate action |
| `(app)` | `settings` | **PASS** — account card, Appearance segmented control, Security, Support, Legal, Local Recovery, Danger Zone, version string `Captivet v1.13.19` |
| `(app)` | `profile` | **PASS** — name field + Save, password-change block |
| `(app)` | `devices` | **PASS** — capacity header, "Approaching limit", per-device rows with type/version/last-active, revoke on every row except the current device |
| `(app)` | `subscription` | **PASS** — correct role-gated empty state ("available to organization owners and administrators") |
| `(app)` | `delete-account` | **PASS (render only)** — permanent-deletion warning, the rule-8 note that local unsent recordings survive sign-out, "Type DELETE" field, Request Deletion button. **Not exercised**, per the user's decision |
| `(app)` | `audio-editor` | **PASS (empty state)** — "No recording to edit." Mounts cleanly with no bridge state |
| `(app)` | `durable-recovery` | **PASS (empty state)** — "Captivet recovered 0 unsaved local recordings", "No recordings to recover." |
| `(app)` | `recording-recovery` | **PASS (empty state)** — "No Recoverable Recordings" with an explanatory body and a Check Again action |

Five `(app)` routes have no reliable UI entry point and were reached by deep link
(`xcrun simctl openurl <udid> 'captivet:///<route>'`). iOS gates custom-scheme opens behind an
"Open in *Captivet*?" system prompt that must be confirmed each time, and consecutive `openurl`
calls **queue** those prompts rather than replacing them.

**Two specific checks called out in the plan:**

- **Audio-player permission gating** — the detail screen rendered the forbidden-state card
  ("Only the recording author or an admin can play this audio.") from the **first** accessibility
  dump after navigation, and identically at t+1 s and t+3 s. **No permission flash.**
- **`/recordings/attention` back-navigation** — opening a row pushed the detail, one back returned
  to the attention screen, a second back returned to the Recordings tab **with its list and search
  intact**. The `(tabs)`-group placement fix holds on iOS; the Recordings tab was never stranded.

## 3a. Screenshots

Not committed — every authenticated screen carries production PHI (see the PHI note above). Held in
the session scratchpad and on the Mac under `~/shots/`, named `<case>-<udid-prefix>.png`:

| File | Screen | Device | Theme / size |
|---|---|---|---|
| `A-launch` | login (safe to share — pre-auth) | iPhone | light |
| `A3-after-signin` | Home | iPhone | light |
| `C-form` | Record + patient form | iPhone | light |
| `F-toggle`, `F-prompt` | Settings → Security | iPhone | light |
| `E-settings-bottom` | Settings, scrolled | iPhone | light |
| `deeplink-prompt` | Delete Account behind the scheme prompt | iPhone | light |
| `D-home-dark`, `D-home-dark2`, `D-home-dark3` | Local Recovery, Recovered Recordings, Home | iPhone | **dark** |
| `D-home-axxxl` | Home | iPhone | light, `accessibility-extra-extra-extra-large` |
| `ipad-after-signin` | Home | iPad | light |
| `ipad-dark` | Home | iPad | **dark** |
| `E-postsignin` | Home after the rule-8 sign-out/sign-in cycle | iPhone | light |

## 4. Anomalies

**No crash, redbox, Hermes unhandled rejection, or native exception was observed at any point.**

Method: after each block, the app's unified log was sampled with
`xcrun simctl spawn <udid> log show --last <N>m --style compact --predicate 'processImagePath CONTAINS "Captivet"'`
and grepped for `unhandled|redbox|RCTFatal|NSException|Terminating app|SIGABRT`, plus a targeted
`error|exception|reject|fatal` pass around auth and biometrics. Every scan returned empty. (`log stream`
was deliberately avoided — it is unbounded and would exceed the controlling tool's 10-minute call cap.)

The only error-level output produced during the entire run was the audio one, quoted verbatim:

```
2026-08-25 16:48:46.157 E  Captivet[50086:2033b2] [com.apple.coreaudio:AudioConverter]
  AudioConverter.cpp:1087  Failed to create a new in process converter -> from  0 ch,  44100 Hz,
  .... (0x00000000) 0 bits/channel, 0 bytes/packet, 0 frames/packet, 0 bytes/frame
  to  1 ch,  44100 Hz, aac  (0x00000000) 0 bits/channel, 0 bytes/packet, 1024 frames/packet,
  0 bytes/frame, with status -50
2026-08-25 16:48:46.157 E  Captivet[50086:2033b2] [com.apple.coreaudio:AQ]
  AudioQueueObject.cpp:1886  BuildConverter: AudioConverterNew returned -50
2026-08-25 16:48:46.169 E  Captivet[50086:20346c] [com.apple.coreaudio:AMCP]
  HALC_ProxyIOContext.cpp:1623  HALC_ProxyIOContext::IOWorkLoop: skipping cycle due to overload
```

That is the missing-microphone condition, handled correctly by the app — see
[F-04](#f-04--recording-cannot-start-on-the-simulator--and-fails-correctly). It is a simulator
limitation surfacing through a working error path, not a defect.

Two non-crash behaviours worth recording because they *look* like anomalies and are not:

- **`idb ui describe-all` returned only the root `Application` node** on several occasions. Cause: an
  iOS system alert (the "Save Password?" sheet, the "Open in Captivet?" scheme prompt) was up and
  blinds the accessibility dump. Screenshot before concluding a screen failed to render.
- **The Face ID Lock toggle stayed off** after two taps with no prompt and no log output. That is
  `biometrics.authenticate()` returning false rather than throwing — graceful degradation, not a hang.
  See section F.

## 5. Findings

### F-01 · **P0** · The global text patch is a no-op on RN 0.83 — **FIXED**

`app/_layout.tsx:49-73` monkey-patches `Text.render` and `TextInput.render` to inject **(a)** the
global `maxFontSizeMultiplier` 1.3 cap and **(b)** `fontFamily: 'Inter'`. It is guarded by
`if (typeof baseRender === 'function' && !target.__interApplied)`.

In React Native 0.83, **neither component has a `.render` static.** `Text` is a plain function
component (`TextImpl.displayName = 'Text'`, `export default TextImpl`); `TextInput` likewise
(`TextInput.displayName = 'TextInput'`, `export default TextInput as any as TextInputType`). Neither
file contains a `.render =` assignment. `baseRender` is therefore `undefined`, the `if` is false, and
**the entire patch is skipped in silence** — by design, since it is wrapped in `try/catch` for rule 1.

Verified against the exact version this build used: `package-lock.json` resolves `react-native` to
**0.83.10**, the Mac installed fresh from that lockfile, and the published
`react-native@0.83.10/Libraries/Text/Text.js` and `.../TextInput/TextInput.js` both show the shape
above with no `.render` assignment. (The stale local WSL `node_modules` holds 0.83.6, which is
identical in this respect — see [F-07](#f-07--expo-doctor-drift-two-different-things-in-one-warning).)

Two regressions follow, both silent:

1. **The 1.3× font-scaling cap is never applied.** Measured on device by comparing the accessibility
   frame height of a single-line, non-wrapping label at two content sizes:

   | Device | `content_size large` | `accessibility-extra-extra-extra-large` | Ratio |
   |---|---|---|---|
   | iPhone 17 Pro Max | 22 pt | 78.67 pt | **3.58×** |
   | iPad Air 11 M3 | 28 pt | 100 pt | **3.57×** |

   Expected ≤ 1.30×. The raw OS text scale passes through unclamped.

2. **Inter is never applied.** `assets/fonts/Inter-Variable.ttf` is bundled by the `expo-font`
   plugin, and `tailwind.config.js` declares `sans: ['Inter', 'system-ui', 'sans-serif']` — but the
   app contains **zero** `font-sans` usages and the patch at `app/_layout.tsx:64` is the **only**
   `fontFamily` assignment anywhere in `src/` or `app/`. With the patch dead, every `<Text>` falls
   back to the iOS system font. The comment at `app/_layout.tsx:34` states the reason the patch
   exists ("RN `<Text>` does NOT inherit fontFamily from a parent View") — the mechanism it chose
   simply no longer exists in this RN version.

**Why CI is green.** `tests/font-scaling-guard.test.mjs:39-43` asserts only that three *source
strings* appear in `app/_layout.tsx`:

```js
assert.match(src, /const GLOBAL_MAX_FONT_SIZE_MULTIPLIER = 1\.3;/);
assert.match(src, /element\.props\.maxFontSizeMultiplier === undefined/);
assert.match(src, /maxFontSizeMultiplier: GLOBAL_MAX_FONT_SIZE_MULTIPLIER/);
```

A source-text guard cannot observe that the code it fences never executes. This is exactly the class
of defect the plan's premise predicted: 849 sandboxed logic tests, none of which run the iOS runtime.

**Fixed (2026-08-25, after this run).** Scope was deliberately limited to the **cap**; Inter was left
off — see below.

- `src/lib/fontScaling.ts` holds the cap arithmetic as a plain, side-effect-free module so the guard
  can **execute** it. A smaller per-element cap wins; a larger one is clamped; null/0/NaN/Infinity
  fall back to 1.3 rather than disabling scaling.
- `src/components/ui/Text.tsx` is now the app's `Text`/`TextInput` and the only file allowed to import
  them from `react-native`. `TextInput` forwards a ref and re-exports itself as a type so
  `useRef<TextInput>` still resolves. `className` is forwarded to the underlying RN element, so
  NativeWind interop is unchanged and no `cssInterop` registration is needed.
- 63 files had their import swapped; the 318 `<Text>` call sites are untouched.
- The dead patch is deleted from `app/_layout.tsx`.
- Two independent fences: an ESLint `no-restricted-imports` rule (fails in the editor) and a rewritten
  `tests/font-scaling-guard.test.mjs` that executes the resolver **and** asserts no file outside the
  wrapper imports `Text`/`TextInput` from `react-native`.

**Verified at runtime on the rebuilt app**, which is the whole point — a source guard could not have
caught this. Measured on the pre-auth login screen, same method as the original finding:

| Label | `content_size large` | `accessibility-extra-extra-extra-large` | ratio |
|---|---|---|---|
| "Sign in to your account" | 22.00 | 28.67 | **1.303×** |
| "Email" | 18.00 | 23.67 | **1.315×** |
| "Password" | 18.00 | 23.67 | **1.315×** |

Was 3.58×. The residual above 1.30 is line-height rounding at 3× pixel snapping. Login and Home
render pixel-identically to their pre-fix screenshots at default text size, so NativeWind styling did
not regress.

**Inter was fixed separately, after a device probe** — see
[F-08](#f-08--inter-never-rendered-on-android-because-the-file-was-named-wrong--fixed). The cap fix
shipped first on its own because it is unambiguous; adopting the typeface was a design decision that
needed evidence, and the probe found a second bug.

### F-02 · Device-capacity banner overflows at large Dynamic Type — **FIXED by F-01**

At `accessibility-extra-extra-extra-large` on the iPhone, the Home device-capacity banner
(`app/(app)/(tabs)/index.tsx:463`) breaks: the message text overruns the bottom edge of its card —
the final word is clipped mid-glyph — and the "Manage" action overlaps the text column rather than
sitting beside or below it. The banner's row does not grow to fit its content.

This was downstream of [F-01](#f-01--p0--the-global-text-patch-is-a-no-op-on-rn-083--fixed), and
re-checking after that fix rather than assuming it healed was the right call — it did heal. On the
rebuilt app at the same content size the banner wraps to two lines **inside** its card with "Manage"
beside it, "Welcome, Phil" fits on one line, and the org name is no longer ellipsized. Nothing is
clipped and nothing overlaps.

One milder case remains at that size: the "Not Submitted" row ellipsizes its client name and breed
and its two status badges crowd the text column. That is ordinary constrained-row behaviour rather
than the overflow class above, and it is not tracked as a defect.

Note this is **not** the Android Bold-text class documented in CLAUDE.md's UI Gotchas
(`fontWeightAdjustment` does not exist on iOS) — it is ordinary Dynamic Type overflow.

### F-03 · "this tablet" in an accessibility label on a phone

`app/(app)/settings.tsx:460` sets `accessibilityLabel="Recover local recordings on this tablet"`
while the visible `title` is the device-neutral "Recover Local Recordings". On an iPhone a
screen-reader user hears "tablet". Cosmetic, but it only affects the accessibility path, which is
where nobody looks. Several other strings share the assumption (`src/lib/recordingPermissions.ts:7`,
`src/constants/strings.ts:536,720,729,730`, `src/components/DeviceLimitModal.tsx:181,191`,
`app/(app)/recording-recovery.tsx:206,288`) — reasonable when the fleet was tablet-only, now stale
given rule 23 explicitly ships an `ios_phone`/`android_phone` device type.

### F-04 · Recording cannot start on the simulator — and fails correctly

Tapping **Start recording** produces the app's own alert: *"Recording Error — Could not start
recording. Please check that your device has a microphone and it is not in use by another app."*
The simulator log gives the cause:

```
AudioConverter.cpp:1087  Failed to create a new in process converter -> from  0 ch,  44100 Hz, ...
                         to  1 ch,  44100 Hz, aac ..., with status -50
AudioQueueObject.cpp:1886  BuildConverter: AudioConverterNew returned -50
```

The input device enumerates with **0 channels**, so AudioQueue cannot build an AAC converter. This is
the **expo-audio / `AVAudioRecorder`** path, not only `AVAudioEngine` — so no capture engine works
here, and the plan's earlier hypothesis that expo-audio might still yield a valid silent file is
disproved.

**This is a rule-6 pass.** `useAudioRecorder` threw, `record.tsx` caught it, and the user got an
actionable alert rather than a crash, a stuck timer, or a corrupted recorder.

Everything downstream is consequently unreachable on a simulator: segments, draft-on-Finish, the
silent-audio guard and its "Upload Anyway" override, `createWithFile` preflight, upload, and durable
ADTS capture. The stash path is unreachable too — `canStash` (`record.tsx:5399`) requires
`hasUnsavedRecordings`, so **Save for Later** never renders; verified with a fully filled patient form
and no audio.

### F-05 · Device name is "Simulator iOS" — expected, but unverified on real hardware

Both sims register with device name **"Simulator iOS"** while the Android device in the same list
shows its real model. `registerDevice()` (`src/auth/AuthProvider.tsx:921-931`) takes the name from
`expo-device`'s `Device.modelName`, which returns a placeholder on a simulator. The **type** label —
the thing rule 23 exists for — is correct on both. Not a defect, but it means the iOS *model name*
shown in Manage Devices has still never been seen on real hardware.

### F-06 · An admin-revoked device is told its session expired

Revoking the iPad from the iPhone worked: the iPad force-signed-out to the login screen with no
crash and no stuck state — the `DEVICE_REVOKED` path in `src/api/client.ts:427-435` doing its job.
The **message** it showed was:

> Your session expired. Please sign in again.

That is the wrong guidance. An admin revoked the device; the session did not expire, and signing in
again is not the remedy — contacting an administrator is. The correct string already exists one line
away, at `src/api/client.ts:431`:

> This device has been revoked. Contact your administrator.

but it is thrown as an `ApiError` to the *caller*, and on the session-restore path the caller has no
UI. The login screen's copy comes from `src/lib/logoutReason.ts`, whose type is:

```ts
type LogoutReason = 'session_expired' | null;
```

There is no `'device_revoked'` variant, so the login screen **structurally cannot** say anything
else. Compounding it, the handler that actually runs on revocation
(`src/auth/AuthProvider.tsx:1608-1610`) calls `handleSignOut(...)` and never calls
`setLogoutReason(...)` at all — the "session expired" text most likely came from a concurrent 401
travelling the `onUnauthorized` / `onSessionExpired` path, which does set it
(`AuthProvider.tsx:1650`, `:1665`, `:1685`). Which of the two set it on this run is not
distinguishable from the client, but the user-visible outcome is the same either way.

Small, self-contained fix: widen `LogoutReason` to include `'device_revoked'`, set it in the
`setOnDeviceRevoked` handler, and map it to the existing revoked copy on the login screen. Worth
doing because on shared clinic hardware a revocation is exactly the case where the user needs to
stop retrying and call someone.

### F-07 · `expo-doctor` drift: two different things in one warning

`expo-doctor` reports 22 patch-level mismatches. They are not the same kind of problem, and the
distinction matters:

**21 of them are intentional repo pins** one patch behind what SDK 55 currently expects — e.g.
`expo-audio` pinned `~55.0.16` against an expected `~55.0.17`. **Do not run `npx expo install --fix`
to clear these.** The repo carries `patches/expo-audio+55.0.16.patch`, and `patch-package` matches on
the exact version, so bumping `expo-audio` silently drops the Android recorder-latency patch that
`tests/legacy-android-recorder-latency.test.mjs` guards. Left as-is deliberately.

**One is a stale local install, not a pin.** `react-native` is `0.83.10` in **both** `package.json`
and `package-lock.json`, but the WSL `node_modules` holds **0.83.6**:

| package | package.json | package-lock.json | installed (WSL) |
|---|---|---|---|
| `react-native` | `0.83.10` | `0.83.10` | **`0.83.6`** |
| `expo` | `~55.0.28` | `55.0.28` | `55.0.28` |
| `expo-audio` | `~55.0.16` | `55.0.16` | `55.0.16` |
| `expo-router` | `~55.0.17` | `55.0.17` | `55.0.17` |
| `expo-file-system` | `~55.0.19` | `55.0.24` | `55.0.24` |

Only `react-native` diverges, and only locally. The Mac installed fresh from the shipped lockfile, so
**the artifact under test is RN 0.83.10** — the local tree is simply behind. A plain `npm install` in
WSL resolves it and would drop `expo-doctor` to 21 findings. Worth doing, because a stale local tree
means local greps of `node_modules` describe a version the app is not built with — which is precisely
the trap [F-01](#f-01--p0--the-global-text-patch-is-a-no-op-on-rn-083--fixed) had to be re-verified around.

## 6. Not completed

Everything in the plan's matrix ran. Two items were deliberately not pursued, and one piece of
cleanup needs a hand:

| Item | Status |
|---|---|
| **Google Sign-In sheet** | **Not attempted.** The button renders and is backed by real client ids, so the configuration is proven; actually completing the flow needs Google account credentials that were not on hand. Remaining assertion for a future run: the `ASWebAuthenticationSession` opens and cancels cleanly. |
| **Phase 6 — forced-durable second build** | **Superseded, not skipped.** Capture fails at AudioQueue *before* either engine is reached ([F-04](#f-04--recording-cannot-start-on-the-simulator--and-fails-correctly)), so `EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true` would buy a second identical alert for another 7 minutes of build. |
| **Revoking the last test device** | **Needs an operator.** See [§8](#8-cleanup-record) — a device cannot revoke itself, so one simulator registration remains. |

An unrelated interruption is worth recording because it is a real operational risk for this setup:
mid-run, Tailscale wedged on the controlling Windows host (`unexpected state: NoState`, two
`tailscaled` processes) and `macmini-ios` — which resolves **only** through MagicDNS, with no LAN or
mDNS fallback — became unreachable for roughly 40 minutes. `tailscale up` did not recover it;
launching the tray client (`tailscale-ipn.exe`, user-level, no elevation) did. The run resumed exactly
where it stopped, at the sign-out confirmation dialog.

## 7. Still needs a physical iPhone

Nothing in this list is a simulator shortcoming that better tooling would fix.

1. **Any recording at all.** Capture, segments, multi-segment `CONTINUE_RECORDING`, pause/resume, the
   interruption path, draft-on-Finish, stash and Resume, Submit, upload, and transcription.
2. **The iOS durable recorder Swift runtime.** `CaptivetDurableRecorderModule.swift` is excluded from
   the CI typecheck and has now still never executed. Its recovery surface mounts cleanly but has no
   manifests to recover.
3. **Real ADTS byte validation** and the R2 upload contract end-to-end.
4. **The silent-audio guard and "Upload Anyway"** — never reached.
5. **`AppLockGuard`** enable/lock/unlock, since `authenticateAsync` does not present over SSH.
6. **Apple Sign In** (needs an Apple ID signed into the device; name/email arrive only on first auth).
7. **The real iOS device model name** in Manage Devices ([F-05](#f-05--device-name-is-simulator-ios--expected-but-unverified-on-real-hardware)).
8. **Font rendering after F-01 is fixed** — CLAUDE.md's UI Gotchas already require verifying Inter
   weights on physical hardware.

One further gap needs a different **account**, not different hardware: the **MFA screens**
(challenge, TOTP QR enrolment, `mfaPolicy` error copy) were never rendered because the test account
is not enrolled. Any MFA-enrolled account on any device closes that gap.

## 8. Cleanup record

| | |
|---|---|
| Test account | the `CAPTIVET_USERNAME` account (a veterinarian in the production org) |
| Run window | 2026-08-25, approx. 20:41 – 22:35 UTC (including a ~40 min Tailscale outage) |
| Sentry / PostHog release | `1.13.19`, `platform: ios` — all events from this window on iOS are synthetic |
| Rows created | **none.** No recording, draft, or stash was ever produced, because capture never started. The one patient form filled in used the obviously-synthetic values `ZZTEST-IOSSIM` / `ZZTESTCLIENT` and was never submitted or saved |
| Devices registered | 2 (`ios_phone`, `ios_tablet`); org capacity went 15 → 16 → 17 of 20 |
| Devices revoked | **1** — the iPad (`ios_tablet`), revoked from the iPhone; capacity 17 → 16 |
| **Outstanding** | **1 device still registered.** A device cannot revoke itself, so the iPhone simulator's registration survives. Revoke it from Captivet Connect or another signed-in device — it is unambiguous in the list: name **`Simulator iOS`**, type **`iPhone`**, version **`v1.13.19`** (no other row combines those). That restores capacity to 15 of 20 |
| Sessions | signed out on **both** sims (the iPad was force-signed-out by its own revocation) |
| Simulator state | `content_size large` and `appearance light` restored on both; Face ID enrolment left on the iPhone (harmless — it only unhides an app-lock toggle that is off) |
| Artifacts | `~/builds/captivet-ios-sim-1.13.19.tar.gz` kept; `~/builds/captivet-joy-sim-1131.tar.gz` fallback untouched |
| Broken pre-run tree | parked at `~/VetSOAP-Mobile.shipfail` on the Mac; `~/VetSOAP-Mobile.bak` (Jul 1) untouched |
| Mac scripts changed | `~/ios-build.sh` rewritten (env fail-fast, no `eas env:pull`, absolute output, `EAS_NO_VCS` first); `~/ios-drive.sh` now requires `SIM_UDID` (original at `~/ios-drive.sh.bak-udid`); `~/ios-ax.sh` added |

### F-08 · Inter never rendered on Android because the file was named wrong — **FIXED**

Enabling the typeface (a one-line change in the wrapper, since the cap fix had already routed every
call site through it) surfaced a platform-split bug that had been latent since the font was embedded.

**iOS was fine.** A controlled comparison — same build, only the `fontFamily` line differing —
moved the one shrink-wrapped label on the login screen from **116.33 pt → 117.00 pt**, and a
same-string weight ladder proved the variable `wght` axis resolves as real instances rather than
synthetic emboldening:

| class | fontWeight | width | vs 400 |
|---|---|---|---|
| `font-normal` | 400 | 121.67 | — |
| `font-medium` | 500 | 123.67 | +1.64% |
| `font-semibold` | 600 | 125.67 | +3.29% |
| `font-bold` | 700 | 127.67 | +4.93% |

Four distinct widths, **exactly +2.00 pt per step**. That linear ladder is axis interpolation; faux
bold does not produce it.

**Android was not fine.** Android never reads a font's internal name table. `expo-font` enumerates
`assets/fonts/` with `^(.+?)(_bold|_italic|_bold_italic)?\.(ttf|otf)$`
(`FontLoaderModule.kt:66-76`) and RN's `ReactFontManager` resolves `fontFamily: "Inter"` to
`fonts/Inter.ttf`. The file shipped as **`Inter-Variable.ttf`**, which registers as
`"Inter-Variable"` — so `fontFamily: 'Inter'` matched nothing and **silently fell back to Roboto**,
while iOS rendered Inter correctly off the internal family name. Enabling the font as-is would have
shipped two different typefaces on the two platforms, with nothing failing.

Fix: rename the asset to `assets/fonts/Inter.ttf`. iOS is unaffected (it resolves by internal name,
still `Inter`); Android now matches. Measured on an emulator, same build, only the filename differing:

| label | `Inter-Variable.ttf` (Roboto fallback) | `Inter.ttf` | Δ |
|---|---|---|---|
| "Forgot password? " | 294 px | **310 px** | +5.4% |
| "Sign In " | 142 px | **154 px** | +8.5% |

`tests/font-scaling-guard.test.mjs` now asserts the filename stem equals `APP_FONT_FAMILY`, so the
next person who renames the asset fails CI instead of shipping a split typeface.

**Android Bold-text was verified, not assumed.** CLAUDE.md records this class as physical-Android-only
because emulators run `font_weight_adjustment=0` — but the setting can be forced with
`adb shell settings put secure font_weight_adjustment 300`, and the emulator honours it (0.28% of
screenshot pixels changed on the re-render). With Inter actually rendering, at `fwa=300`:

- **Login**: every string painted in full — nothing vanished, nothing clipped.
- **Home** (the dense screen, where most of `ui-clip-guard`'s 64 at-risk shapes live): 23 text nodes,
  **identical strings and identical bounds** at `fwa=0` and `fwa=300` (Yoga measuring with the
  unadjusted font, exactly as documented), and every one painted complete — including all four
  tab-bar labels, the classic at-risk shape.

Worth recording as a capability: **this bug class IS testable on an emulator** with the adb setting,
which is cheaper than the physical-device round trip CLAUDE.md currently implies.

**Residual.** Verified on login and Home on both platforms. The remaining screens were not walked at
`fwa=300`, and `ui-clip-guard`'s census is a static shape count that does not move with the font — so
it neither caught nor could catch a font-induced regression. A physical-device pass over the dense
screens before release is still the prudent close-out.

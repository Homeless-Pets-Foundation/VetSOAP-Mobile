# Plan: Local Android + Mac-mini iOS builds, then thorough test of recent PR work on a test org

## Context

The `durable-recorder-verified` branch (PR #126, MERGEABLE, all CI green) plus a stack of recently-merged PRs (#105 playback timeline, #108 UI/font polish, #112 reprocess model-selection, #113 provider-fallback banners, #115 subscription-crash/Pixel-perf, #116 record-first multi-patient, #120 Consult-AI link) have never been exercised together in a real build. The owner wants a **local Android APK** (built in WSL via Gradle using EAS/expo.dev-managed credentials) and a **Mac-mini iOS simulator build**, then a **thorough functional test** of the durable recorder + all recent PR work + core flows, run on a **test organization**.

Two hard realities shape the approach (both confirmed this session):
1. **The durable recorder is server-flag-gated and prod never enables it.** `src/lib/durableFlag.ts` defaults `captureEnabled=false`; it only flips when an API response carries header `x-durable-capture-enabled` (`src/api/client.ts:331-332`). The deployed Connect backend (`VetSOAP-Connect@main`) emits that header **nowhere**, though its presign allowlist already accepts `audio/aac` (`apps/api/src/routes/recordings.ts:610`). So to exercise PR #126 at runtime we apply a **temporary, uncommitted client override** forcing the flag on.
2. **Emulator/simulator can't do real record→Submit.** The silent-audio guard (the emulator/sim mic registers below the `SILENT_METERING_THRESHOLD_DB = -35` dBFS threshold, `record.tsx:233`) throws "This recording appears silent" *before* the API call. Owner chose emulator/sim UI-only testing but wants it **thorough with automation**. So the same temp override adds a **test-only silent-guard bypass** so the upload→server→transcribe→SOAP pipeline is still exercised against the test org (a silent/near-silent clip still creates a real server row and drives the promote/idempotency path). Android-emulator host-mic passthrough is available as a realism bonus for a real transcript.

Everything the override touches is **uncommitted and reverted** before any commit. The test org absorbs the throwaway recordings by design.

*This plan was hardened by a multi-agent adversarial audit (build correctness, override safety, execution mechanics, matrix completeness). Confirmed corrections are folded in and tagged "audit …" inline; every build command, env var, patch point, and disk path below is code-verified against the current tree.*

## Environment (live-verified this session, 2026-07-01)

- **WSL Android toolchain:** JDK17, `ANDROID_HOME=~/android-sdk` (SDK 36 + NDK 27.1.12297006 + build-tools 36 + cmake), env in `~/.captivet-android-env`. `eas-cli` logged in as `jaxnnux`. Windows adb at `/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe`. Emulator `emulator-5554` currently attached (AVD `dvmcalc`, API 35).
- **Mac mini (`ssh macmini-ios`):** macOS 26.5, Xcode 26.6, CocoaPods 1.16.2, node 24, `eas` logged in as `jaxnnux`. **iPhone 17 Pro simulator already booted**; GUI console logged in as `phil` (enables `launchctl asuser`). No repo/gh there — source shipped via tar + `EAS_NO_VCS=1`.
- **App version:** 1.13.7. These are **test builds** (apk / simulator / internal) → **no marketing-version bump** needed (that rule is for store releases only).
- `.env` present with `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_R2_BUCKET_HOSTNAME` (the "secret"-visibility vars EAS won't inject into `--local`).

## Required kickoff input from owner

- **Test-org account (provided):** `empoweredpets@gmail.com` (email/password auth — Google/Apple SSO don't work in local builds). App resolves org from `/auth/me` after sign-in; I'll confirm the org name once signed in and verify it is a **test** org before generating throwaway recordings.

---

## Phase 0 — Pre-flight (read-only, ~5 min)

1. `git status` clean; on `durable-recorder-verified` @ `54ae5b5`.
2. Static gates green before building: `npx tsc --noEmit`, `npm test` (incl. `tests/durable-recorder-plan.test.mjs`), `npx expo lint`.
3. `npx expo-doctor` (also enforced by `.claude/hooks/pre-eas-build.sh`).
4. **Min-version-floor pre-flight:** `curl -s -i https://api.captivet.com/health | grep -i x-minimum-app-version` (`src/api/client.ts:322` → `getRecordStartGate()` in `src/lib/minVersion.ts:140`). The gate fails **open** when the floor is unknown, but **blocks record-start** if a cached floor > running version (1.13.7). Confirm prod floor ≤ 1.13.7 (expected — it's a low minimum); if higher (rare contingency), temporarily bump the local `app.config.ts`/`package.json` version for the test build — this intentionally dirties the tree (relaxing the 0.1 git-clean gate) and gets reverted alongside the override in Phase 6. A fresh install has no cached floor and the first API call refreshes it, so the only real risk is a floor > 1.13.7.
5. **Test-account role:** the account must be `owner`/`admin`/`veterinarian` to reach Record (`RECORD_APPOINTMENT_ROLES` in `src/lib/recordingPermissions.ts`); `support_staff` is blocked. Confirm `empoweredpets@gmail.com`'s role right after first sign-in (or via Connect/Supabase); if it's `support_staff`, the owner must promote it before Phase 5.
6. **Test-org device capacity:** registering the emulator + simulator as devices can hit the org device limit → `403 DEVICE_LIMIT_REACHED` at `/api/device-sessions/register` (`AuthProvider.tsx:885`, surfaced as `DeviceLimitModal`). Confirm free device slots on the test org (devices screen / Connect UI); revoke an old test device if at limit.
7. **MFA:** verify MFA is **disabled** for `empoweredpets@gmail.com`, or have the TOTP secret/current code ready — otherwise sign-in stalls at the challenge screen (`app/(auth)/mfa.tsx`) and the emulator/sim can't scan a QR.

## Phase 1 — Temporary TEST override (uncommitted)

Two-file diff, reverted at the end. Both hooks are **inert unless their env var is set**, so the same source could even build clean by accident — but we revert regardless.

- **Force durable flag on** — `src/lib/durableFlag.ts`: in `isDurableCaptureEnabled()` (l.27) return `true` when `process.env.EXPO_PUBLIC_TEST_FORCE_DURABLE === '1'`, else the cached value. This is sufficient because `wantDurable = !!ctx && isDurableCaptureEnabled() && durableRecorder.isAvailable()` (`useAudioRecorder.ts:577`) — `ctx` (userId/slotId/recordingId) is always supplied by `record.tsx`, and `durableRecorder.isAvailable()` is true in a fresh native build that includes the committed `captivet-durable-recorder` module. No other gate.
- **Bypass silent-audio guard** — `app/(app)/(tabs)/record.tsx`: add an early return at the **top of `checkSilentAudio()` (l.254)**: `if (process.env.EXPO_PUBLIC_TEST_BYPASS_SILENT === '1') return { silent: false, inconclusive: false, reason: null };`. Placing it at the function top covers **both** call sites — durable (l.1944) and legacy expo-audio (l.2143) — vs. the threshold check against `SILENT_METERING_THRESHOLD_DB = -35` (l.233).
- Both env vars exported only in the build shell; **never committed**. Revert = `git checkout -- src/lib/durableFlag.ts "app/(app)/(tabs)/record.tsx"`; confirm `git status` clean before any future commit.

## Phase 2 — Android APK build (WSL, Gradle + EAS credentials)

Pre-req: `npm install --legacy-peer-deps` has run so `postinstall` applies the `patch-package` ffmpeg AAR patch (`.npmrc` sets `legacy-peer-deps=true`); a `--local` build that skips this fails at the ffmpeg Gradle step.

```bash
source ~/.captivet-android-env
set -a; source .env; set +a                     # EXPO_PUBLIC_* (secret-vis vars not injected into --local)
export SENTRY_DISABLE_AUTO_UPLOAD=true           # gradle sentry plugin fails source-map upload locally
export EXPO_PUBLIC_TEST_FORCE_DURABLE=1 EXPO_PUBLIC_TEST_BYPASS_SILENT=1
npx --yes eas-cli@latest build -p android --profile production-apk --local --non-interactive --output ./build/captivet-durable-test.apk
```
- `production-apk` profile pulls the **remote EAS keystore** ("credentials from expo.dev") and runs Gradle under the hood → single APK (~168 MB, `com.captivet.mobile`). This is the memory-validated local path.
- Install to the emulator via the **Windows** `adb.exe` (it can't resolve WSL `/home` paths — stage under `/mnt/c` and pass a Windows path): `cp ./build/captivet-durable-test.apk /mnt/c/Users/jaxnn/` then `adb.exe -s emulator-5554 install -r "$(wslpath -w /mnt/c/Users/jaxnn/captivet-durable-test.apk)"`. If it fails `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (a differently-signed `com.captivet.mobile` — e.g. an old dev-client — is already present), `adb.exe uninstall com.captivet.mobile` first (clears that app's local data), then install.

## Phase 3 — iOS simulator build (Mac mini over SSH)

1. Ship source **including `.env`** (exclude node_modules/.git/build): `ssh macmini-ios 'mkdir -p ~/VetSOAP-Mobile' && tar czf - --exclude=node_modules --exclude=.git --exclude=build . | ssh macmini-ios 'tar xzf - -C ~/VetSOAP-Mobile'` (the `mkdir -p` guards a first run where the dir doesn't exist yet; `tar … .` includes dotfiles like `.env`/`.npmrc`). If your `tar` skips dotfiles, `scp .env` separately — `.env` must land on the Mac (it carries `EXPO_PUBLIC_*`).
2. On the Mac, in `~/VetSOAP-Mobile`, run **in this order**:
   1. `set -a; source .env; set +a` — load `EXPO_PUBLIC_*`.
   2. `npm install --legacy-peer-deps` — node_modules was excluded from the tar; this also runs `postinstall`/`patch-package` (the ffmpeg iOS podspec patch). **Required**, or `pod install` fails.
   3. `eas env:pull --environment preview` writes `.env.local` — but the `preview` env also holds `POSTHOG_KEY`/`SENTRY_DSN`, and `.env.local` **overrides** `.env`. Keep ONLY the two Google iOS vars so prod monitoring stays off and prod `.env` values win: `grep -E 'EXPO_PUBLIC_GOOGLE_IOS_(CLIENT_ID|URL_SCHEME)' .env.local > .env.local.tmp && mv .env.local.tmp .env.local`. (Secret `API_URL`/`SUPABASE_*`/`R2` are **not** pullable — they come from `.env`.) `eas build --local` then auto-loads `.env.local` + `.env` via `@expo/env`.
   4. `export EAS_NO_VCS=1 SENTRY_DISABLE_AUTO_UPLOAD=true EXPO_PUBLIC_TEST_FORCE_DURABLE=1 EXPO_PUBLIC_TEST_BYPASS_SILENT=1 EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=placeholder` — the WEB id is a **secret** (builder-only, unreadable locally), so a placeholder is fine (email sign-in works; Google SSO won't).
   - **Why all three Google vars** (top audit blocker, EAS-verified): `app.config.ts requireGoogleIosBuildConfig()` (l.7-22) throws on any iOS EAS build (`EAS_BUILD_PLATFORM=ios` && `APP_VARIANT!=development`) if any is missing, and `preview-simulator` sets **no** `environment` key so EAS won't auto-inject them. Setting `GOOGLE_IOS_URL_SCHEME` also registers the google-signin + modular-headers pods (`app.config.ts:99-109`).
3. Build a **simulator** build: `eas build -p ios --profile preview-simulator --local --output ./build/captivet-ios-sim.tar.gz`. The iOS simulator `--local` artifact is a **gzipped tarball**, not a bare `.app` — extract it (`tar xzf ./build/captivet-ios-sim.tar.gz`) to get `Captivet.app` before install. (JS baked in, no dev-client/Apple-creds needed.) The FFmpeg iOS podspec + `with-ios-modular-headers` plugins run during `pod install`.
4. **Drive the booted sim over SSH via `launchctl asuser`** (GUI is logged in as `phil`; `UID` is a **readonly** shell var, so call `id -u phil` inline — never `UID=…`):
   ```bash
   launchctl asuser "$(id -u phil)" xcrun simctl install booted ./Captivet.app
   launchctl asuser "$(id -u phil)" xcrun simctl launch booted com.captivet.mobile
   ```
   Fallback if authorization still blocks: I build + confirm launch/render via read-only `launchctl asuser "$(id -u phil)" xcrun simctl io booted screenshot`, and hand off interactive steps for you to drive at the console.

## Phase 4 — Reusable test-driver scripts (owner asked "need a script?")

Write two idempotent scripts under `scripts/manual-test/` (uncommitted helper tooling; kept in scratchpad if you prefer):
- **`android-drive.sh`** — wraps Windows adb: launch app, screenshot→Read, `uiautomator dump` for tap coords (per CLAUDE.md Emulator Testing), tap/type/swipe helpers, a true process-death for the crash-recovery step (`adb.exe root` + `adb.exe shell 'kill -9 $(pidof com.captivet.mobile)'` — single quotes so `pidof` runs on-device — or `am crash`; not `am kill`, which spares foreground apps), and `adb.exe root` + `adb.exe shell ls`/`pull` of `/data/data/com.captivet.mobile/files/durable-recordings/…` to inspect the durable manifest + `audio.aac` (release APK is non-debuggable → `adb root` on the emulator image, not `run-as`).
- **`ios-drive.sh`** — `launchctl asuser` wrappers for install/launch/terminate + `simctl io booted screenshot`, and durable-artifact inspection via `simctl get_app_container booted com.captivet.mobile data`.

These make the run repeatable and let re-runs after a fix be one command.

## Phase 5 — Test matrix (both platforms; test org)

Legend: **[FULL]** completes incl. upload via silent-guard bypass · **[UI]** UI/nav/state only · **[DISK]** verify on-disk artifacts. (`rule NN` references point to the crash-prevention rules in `CLAUDE.md`.)

**`[FULL]` caveat:** on emulator/sim the audio is silent (bypass), so the server transcript/SOAP will be **empty but non-erroring** — `[FULL]` validates the upload + pipeline-**advances** path (row created, status progresses, not stuck/failed), **not** transcript content. For real transcript→SOAP content, use Android-emulator **host-mic passthrough** (play a vet-consult sample so Deepgram gets real audio).

**Server support (Connect@`main`, deployed — audit-confirmed):** reprocess model-selection (`recordings.ts:3308`), provider-issues (`organization.ts:297`), consult, and `audio/aac` presign (`recordings.ts:610-611`) are all live. The **only** missing server piece is the durable `x-durable-capture-enabled` header — which the Phase-1 override substitutes client-side — so the `[FULL]` rows exercise the real prod pipeline end-to-end.

**Record precondition:** unless record-first mode is enabled, `PatientSlotCard` gates **Start** on the four required fields (`recordFirstEnabled || hasRequiredFields`, `PatientSlotCard.tsx:258`) — fill patient name / client name / species / appointment type before starting any recording.

### A. Durable recorder — PR #126 (flag forced on)
1. **[UI/DISK]** Start a recording on Record tab → confirm the durable path is active via the **upload mime `audio/aac`** + `audio.aac` + `manifest.json` on disk. Verify via mime + disk + the post-kill recovery banner — **not** analytics: `EXPO_PUBLIC_POSTHOG_KEY` is kept out of both builds (Android sources only `.env`; iOS filters the pull to Google-only), so `durable_recorder_started` won't send; and if a key were present it would hit **prod** PostHog. (If you *want* to validate analytics, add `EXPO_PUBLIC_POSTHOG_KEY` — accepting prod-analytics pollution from throwaway test events.)
   - Android (emulator): `adb.exe root` then `adb.exe shell ls -la /data/data/com.captivet.mobile/files/durable-recordings/<userId>/<recordingId>/` (or `adb.exe pull <path> ./durable-backup`). Note: the release `production-apk` is **non-debuggable**, so `run-as` fails — but the emulator image allows `adb root` to read app-private files (audit blocker fix). This deep-peek is **optional**: the recovery banner appearing after a kill already proves the on-disk `manifest.json` + `audio.aac` survived and parsed (`DurablePaths.kt`).
   - iOS: `launchctl asuser "$(id -u phil)" xcrun simctl get_app_container booted com.captivet.mobile data` → `Library/Application Support/durable-recordings/<userId>/<recordingId>/` (`DurablePaths.swift`).
2. **[DISK]** Mid-recording, force a **process-death** (not a graceful stop):
   - Android: `am kill` only reaps *background-safe* processes and won't kill a foreground recording — use a true SIGKILL: `adb.exe root` then `adb.exe shell 'kill -9 $(pidof com.captivet.mobile)'` (**single quotes** — so `$(pidof …)` runs on the device, not in the local WSL shell), or `adb.exe shell am crash com.captivet.mobile` (simulated crash).
   - iOS: `launchctl asuser "$(id -u phil)" xcrun simctl terminate booted com.captivet.mobile`.

   Relaunch → on re-auth, `runDurableRecoveryScan(userId)` (`src/lib/durableAudio/durableRecovery.ts:226`, invoked at `AuthProvider.tsx:747`) sets the store → **DurableRecoveryBanner** (`src/components/DurableRecoveryBanner.tsx:13`) appears → tap → routes to `/durable-recovery` (`app/(app)/durable-recovery.tsx`) → **Resume**. Do **not** use `am force-stop` — that's a graceful stop that runs teardown, unlike a real crash.
3. **[FULL]** Submit the recovered recording → verify a **single** server row (no duplicate), promote-in-place (`existingRecordingId`/`serverRecordingId` persisted before R2 PUT + deterministic idempotency key), and `audio/aac` upload. Pass = the pipeline **advances without erroring the row** (status progresses; silent-bypass transcript may be empty and SOAP minimal — that's expected, see the `[FULL]` caveat).
4. **[UI]** Flag-off sanity: rebuild/run with `EXPO_PUBLIC_TEST_FORCE_DURABLE` unset → confirm the legacy expo-audio path still records normally (no regression). (Cheapest: a second install without the env, or verify via the regression suite which asserts flag-off behavior.)

### B. Core functionality
- **[FULL]** Email/password sign-in → `/auth/me` resolves test org; device auto-registers (428→register→retry, per client.ts). If the account has MFA enrolled, the challenge screen (`app/(auth)/mfa.tsx`) gates entry — have the TOTP code ready, or the owner disables MFA for the test account first.
- **[FULL]** Single-patient record → Finish (draft-save-on-finish → amber "Not Submitted") → Submit → promotes draft in place → detail → transcribe→SOAP.
- **[UI]** Multi-patient: add ≤10 slots, per-slot record, swipe auto-pause, Submit-all sequential.
- **[UI/DISK]** Stash → "Save for Later" → Resume Session (round-trips `serverDraftId`/`draftSlotId`, rule 20).
- **[UI]** Sign-out preserves drafts/stashes (rule 8): sign out with unsent work → warn count → re-sign-in → recordings reappear.

### C. Recent merged-PR surface
- **[FULL]** #112 Reprocess: recording detail → Reprocess → pick transcription model (Deepgram) + SOAP model/provider (OpenAI / Gemini / Z.ai / Anthropic) → confirm re-transcribe + re-generate fire (`POST /api/recordings/:id/reprocess`).
- **[UI]** #105 Playback: interactive timeline, finger-scrub seek on a completed recording; playhead tracks with no lag.
- **[UI]** #116 Multi-patient record-first detail guidance (inline patient details for a new patient).
- **[UI]** #113 Provider-fallback banners: endpoint is live, but a banner **only renders if the org has an active provider issue logged in the last 7 days** — a clean test org shows nothing. Verify the empty state is clean; a positive banner test needs a seeded server issue (out of scope unless the owner seeds one).
- **[UI]** #115 Subscription screen loads without crash; background/resume + Pixel-perf paths responsive.
- **[UI]** #108 UI polish: Inter font renders, gradients, toast on actions, completion celebration; watch Android single-word glyph clipping (Copy/Transcribing) per CLAUDE.md UI Gotchas.
- **[UI]** #120 Consult-AI: card + button on recording detail opens the **static** link `https://app.captivet.com/consult`.
- **Out of scope:** clinic-quality signals (#123/#124) are **not on this branch** (unmerged `codex/clinic-quality-mobile-signals`) — do not test here even though Connect supports the endpoint.

### D. Crash-rule regressions to spot-check on-device UI
- Android text truncation (flexShrink/trailing-space fixes), loading states resolve (no stuck spinner; rule 24 watchdogs), Haptics no-crash on emulator.

## Phase 6 — Report + teardown

1. Compile a per-platform pass/fail table with screenshots for each matrix row; note anything blocked-by-emulator (real-mic-only) vs genuinely-failing.
2. File any regressions found (with file:line) — bundle comprehensively per owner preference.
3. **Revert the Phase-1 override:** `git checkout -- src/lib/durableFlag.ts "app/(app)/(tabs)/record.tsx"`; confirm `git status` clean.
4. **Delete the override-baked test binaries** — the APK + iOS `.app` have `EXPO_PUBLIC_TEST_FORCE_DURABLE=1`/`BYPASS_SILENT=1` **inlined by Metro at build time**, so reverting source does NOT clean them (audit finding). `rm -f ./build/captivet-durable-test.apk` and, on the Mac, `rm -rf ~/VetSOAP-Mobile/Captivet.app ~/VetSOAP-Mobile/build/captivet-ios-sim.tar.gz`. Also delete the Mac `.env.local` (holds pulled Google vars). Keep the (uncommitted) driver scripts for re-runs; rebuild without the test env vars if a clean binary is ever needed.
5. **Clean up the test org:** delete the throwaway recordings created in Phase 5 (Connect UI or the app's delete action / `recordingsApi.delete`); confirm the recordings list is clean. The test org is shared, so don't leave silent junk rows behind. (Owner or tester.)

## Risks & mitigations

- **launchctl asuser still blocked** → fall back to SSH build+render-validate + owner drives console. Detected immediately at Phase 3 step 4.
- **min-app-version floor blocks record-start** (`x-minimum-app-version` → `getRecordStartGate` `minVersion.ts:140`): only if a cached floor > 1.13.7. No force-upgrade screen — just a silent `'block'` at record-start. Mitigation = Phase-0 pre-flight header check; bump local version if floor is higher. Fails **open** when floor unknown, so a fresh install's first API call is safe.
- **Test account lacks recording role** → `support_staff` can't reach Record (`recordingPermissions.ts`). Caught by Phase-0.5; owner promotes to vet/admin if needed.
- **Test org at device limit** → emulator/sim registration returns `403 DEVICE_LIMIT_REACHED`. Caught by Phase-0.6; revoke an old device.
- **iOS build throws on missing Google vars** → all three exported in Phase 3.2 (the two iOS values pulled from EAS `preview` env, WEB a placeholder). This was the top audit blocker.
- **Override baked into built binaries** (Metro inlines `EXPO_PUBLIC_*` at build time) → Phase-6.4 deletes the test APK/.app; source revert alone is insufficient.
- **Silent-guard bypass uploads junk to the test org** → acceptable (test org); optionally use Android host-mic passthrough for a real transcript; clean up test rows after.
- **Durable module unavailable at runtime** (lazy-load fallback) → `durable_recorder_unavailable` analytics; the record path falls back to expo-audio (still a valid negative result, reported as such).
- **Native rebuild required for the override** (durable module is committed native code) — both builds are already fresh native builds, so the override ships in them; no JS-only hot-reload shortcut.

## Verification of the plan's own success

Done when: both builds install and launch; email/password sign-in reaches the Record screen on the test org on both platforms; the durable record→kill→recover→resume→submit path is demonstrated (with the [FULL] upload via bypass) or a precise blocker is reported; every Phase-5 matrix row has a pass/fail + screenshot; and the override is reverted with `git status` clean.

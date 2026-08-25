# iOS Build + Thorough Simulator Test on the Mac mini

> Revision 2 (2026-08-25). Revision 1 was audited against the live repo and the live Mac mini over
> eight passes; every corrected claim — including two corrections to revision 2's own first pass —
> is listed in [Appendix A](#appendix-a--corrections-applied-to-revision-1). One correction (P1) was
> outright build-blocking: the tree that had already been shipped to the Mac was missing both native
> modules and every image asset.

## Context

Branch `fix/request-amplification-latency` is at `0fb17c2`, a merge of `origin/main` into the
branch. **Its tree is byte-identical to `origin/main`** (`git diff origin/main HEAD` is empty): the
branch's own work landed on `main` as the squash-merge `031d92d` ("fix: stop the
request-amplification storm behind the Sentry slow-phase warnings", PR #170), and the later branch
commits were subsumed by that squash. So this is not a test of unmerged work — it is a test of
**`main` at v1.13.19**, which now contains that request-amplification rework plus the Android
Bold-text sweep (#171/#173) and the organization-name feature (#176).

What is under test is still the same platform-sensitive set: `secureStorage`/`chunkedRead` caching,
`draftStorage`, `durableAudio/tombstone` + `chunkedStore`, the `AuthProvider` device-registration
flight, `ApiClient`, the quality-dashboard scheduler, and `useAttentionFeed`/`useDeviceCapacity`
fan-out. Those are Keychain reads, cold-start gating, and network scheduling — precisely where iOS
diverges from Android, and precisely what CLAUDE.md rules 3, 13, 16, 17, 21, 22, 23 and 24 exist to
protect.

All 77 test files (849 assertions) are Node-level logic tests (`tests/helpers/loadTs.mjs` runs TS in a `vm` sandbox
with mocked `expo`/`react-native`) — **none execute the iOS runtime**. CI's
`ios-native-typecheck.yml` only `swiftc -typecheck`s 4 durable-recorder Swift files
(`AdtsWriter`, `DurableRecorderEngine`, `DurablePaths`, `DurableManifest`) and explicitly excludes
`CaptivetDurableRecorderModule.swift`; `modules/captivet-audio-focus/ios/CaptivetAudioFocusModule.swift`
is not typechecked by any workflow at all. So nothing in this app has ever actually *run* on iOS.

Goal: a real iOS simulator build from the current working tree (v1.13.19) and a systematic walk of
every screen and auth/storage path, producing a concrete pass/fail list.

**User decisions:** simulator build only · iPhone + iPad · render-only on destructive screens.

## Constants

| Name | Value |
|---|---|
| `IPHONE` | `2609580B-0A8A-47E6-8320-55E570D5EE2D` (QUAL-iPhone-17-Pro-Max-26.5, 440×956 pt, **3×**) |
| `IPAD` | `C6CBF28D-546B-4907-A9F7-BDF78661E24B` (QUAL-iPad-Air-11-M3-26.5, 820×1180 pt, **2×**) |
| Bundle id | `com.captivet.mobile` |
| Artifact | `~/builds/captivet-ios-sim-1.13.19.tar.gz` |
| Results doc | `docs/ios-simulator-test-results-2026-08-25.md` |
| Fallback artifact | `~/builds/captivet-joy-sim-1131.tar.gz` (Jun 14, known-good, **do not delete**) |

## Verified environment (re-checked live at the top of this session)

| Thing | State |
|---|---|
| SSH `macmini-ios` | works, user `iosagent`, macOS 26.6.2 |
| Xcode / CocoaPods / node / eas-cli | 26.6 / 1.17.0 / v26.7.0 / 22.4.0, logged in as `jaxnnux` |
| Mac repo `~/VetSOAP-Mobile` | *Was* v1.13.19 but **incomplete** — `modules/*/android`, `modules/*/ios` and every `assets/*.png` missing (see [P1](#p1--the-old-ship-command-silently-deleted-the-native-modules-and-all-image-assets)). Re-shipped and integrity-verified during this run; the broken tree is parked at `~/VetSOAP-Mobile.shipfail`. |
| `.env` on mac | all 6 keys — the 3 `src/config.ts` requires plus `CAPTIVET_USERNAME`/`CAPTIVET_PASSWORD`. The 3 Google + Sentry/PostHog vars live in `~/VetSOAP-Mobile-preflight-20260730/.env` and get merged in ([P4](#p4--a-complete-env-already-exists-on-the-mac-do-not-use-eas-envpull)) |
| Booted sims | both `QUAL-*` above; **both booted simultaneously** |
| Captivet installed on either sim | **no** — both are clean, so the never-registered-device path is genuinely reachable |
| `idb` | works, `~/idb-venv/bin/idb`; companion currently attached to `IPHONE` only (auto-spawns for `IPAD`) |
| `notifyutil` inside the sim | **works** — biometric enroll + match/nomatch *are* drivable over SSH |
| `simctl privacy grant` on a not-yet-installed bundle | returns 0, but grant **after** install and **before** launch anyway |
| Mac helper scripts | `ios-build.sh`, `ios-drive.sh`, `ios-smoke.sh`, `ios-matrix.sh`, `ios-install.sh`, `ios-remote-helper.sh`, `MAC_IOS_TESTING.md` — `ios-build.sh` and `ios-drive.sh` both need patching first (Phase 2 / Phase 3) |
| Disk free | 63 GiB |
| `gtimeout` / `timeout` | **both absent** — never use `timeout` in remote commands |
| `mitmproxy` | installed, but needs sudo/system-proxy → no packet-level request counting |
| `docs/mac-mini-ssh.md` | **does not exist**, despite CLAUDE.md pointing at it. Connection facts are recorded in this doc's Constants + environment table instead. |

### Two operating constraints that shape every command below

1. **The controlling Bash tool caps a single call at 10 minutes.** The iOS build takes far longer.
   Every long step therefore runs **detached** (`nohup … &`) writing to a log, and is polled.
   Nothing long-running may be issued as a foreground `ssh` command.
2. **Two simulators are booted at once, and `xcrun simctl … booted` does not error on ambiguity** —
   it silently picks one (verified: `simctl io booted screenshot` chose a display without saying
   which device). **Every** `simctl` and `idb` invocation must name an explicit UDID.

## Phase 0 — Local preflight (WSL, before shipping anything)

1. `npm test` — 77 files / 849 tests, including `query-fanout-guard`, `storage-read-parallelism`,
   `storage-read-cache`, `auth-init-stability`, `durable-tombstone`, `monitoring-phase-thresholds`
   (all six confirmed present).
2. `npm run typecheck` · `npm run lint` · `npx expo-doctor`.

A failure here gets fixed before burning ~30 min of build time — with one standing exception.
`expo-doctor` fails its "packages match versions required by installed Expo SDK" check with 22
**patch**-level drifts (e.g. `expo-audio` found `55.0.16`, expected `~55.0.17`; `react-native` found
`0.83.6`, expected `0.83.10`). Do **not** run `npx expo install --fix` to clear it: the repo pins
`patches/expo-audio+55.0.16.patch`, and patch-package matches on the exact version, so bumping
`expo-audio` silently drops the Android recorder-latency patch that `tests/legacy-android-recorder-latency.test.mjs`
guards. This drift is pre-existing on `main` and is explicitly out of scope for a test run whose
whole point is to exercise v1.13.19 as shipped.

## Phase 1 — Ship the working tree to the Mac

### P1 — the old ship command silently deleted the native modules and all image assets

Revision 1 shipped with:

```bash
tar czf - --exclude=node_modules --exclude=.git --exclude=android --exclude=build \
          --exclude=build-output --exclude=.expo --exclude=ios …
```

`--exclude=android` and `--exclude=ios` are **unanchored** — they match *any* path component. They
were meant to skip the gitignored root `android/` prebuild output, but they also stripped:

- `modules/captivet-durable-recorder/ios/*.swift` + `.podspec` (6 files)
- `modules/captivet-durable-recorder/android/**` (Kotlin source)
- `modules/captivet-audio-focus/ios/*.swift` + `.podspec`
- `modules/captivet-audio-focus/android/**`

and, for reasons not worth reconstructing, every `assets/*.png` as well. Both local Expo modules
declare iOS modules in their `expo-module.config.json`, so autolinking will look for pods that are
not there; and `app.config.ts` references `./assets/icon.png`, `./assets/logo-wordmark@3x.png`,
`./assets/android-splash-placeholder.png`, `./assets/favicon.png` and the three adaptive-icon PNGs.
**Shipping that tree cannot produce a working build.** Verified against the live Mac: `find modules
-type f` returns 6 files (only the three JS/JSON files per module) and `find assets -type f` returns
one font.

Fix: ship the **git-tracked file list from the working tree**. That is exact (427 files), keeps
uncommitted edits, and cannot accidentally drop a source directory, because gitignore already
excludes `/android` (anchored) and `modules/*/android/build`.

```bash
cd /home/philgood/Projects/VetSOAP-Mobile
ssh macmini-ios 'rm -rf ~/VetSOAP-Mobile.shipfail && mv ~/VetSOAP-Mobile ~/VetSOAP-Mobile.shipfail 2>/dev/null; mkdir -p ~/VetSOAP-Mobile'
git ls-files -z | tar czf - --null -T - | ssh macmini-ios 'tar xzf - -C ~/VetSOAP-Mobile'
scp .env macmini-ios:~/VetSOAP-Mobile/.env
```

`~/VetSOAP-Mobile.bak` (Jul 1) is left alone; the broken tree goes to `.shipfail` instead so the
older known-good copy survives.

`.env` is gitignored and EAS "secret"-visibility vars are not injected into `--local` builds, so it
must be copied explicitly.

### Post-ship integrity check — mandatory, not optional

The previous ship failed silently. Prove this one didn't before spending 30 minutes on a build:

```bash
ssh macmini-ios 'cd ~/VetSOAP-Mobile
  echo "files: $(find . -type f | wc -l)   expect 428 = 427 tracked + .env"
  ls modules/captivet-durable-recorder/ios/*.swift | wc -l   # expect 5
  ls modules/captivet-audio-focus/ios/*.swift | wc -l        # expect 1
  ls assets/*.png | wc -l                                    # expect 11
  test -f assets/fonts/Inter-Variable.ttf && echo font-ok'
```

## Phase 2 — Build

### P2 — three variables are load-bearing, and a missing one fails *invisibly*

`preview-simulator` is a **release** bundle, so `__DEV__` is `false`. In that branch `src/config.ts`
requires three variables:

| Variable | `src/config.ts` | present in `.env`? |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `requireHttps` (L57) | yes |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `requireValue` (L61) | yes |
| `EXPO_PUBLIC_R2_BUCKET_HOSTNAME` | `requireValue` (L78) | yes — value matches `contracts/r2-production-destination-v1.json` → `environments.production.virtualHost` byte-for-byte |

A missing one does not throw (CLAUDE.md rule 1) — it appends to `configErrors`, which sets
`CONFIG_MISSING`, and `app/_layout.tsx:520` then returns a bare red "Configuration Error" `View`
**instead of the entire app**. Every item in the Phase 4 matrix would be unreachable, and nothing
about the *build* would have warned you: the 2026-07-02 build in `~/ios-build.log` exited 0 while
saying nothing about runtime config.

All three are present today, so this is not a blocker — it is a **fail-fast requirement**. Add an
assertion after `source .env` and `exit 93` if any of the three is empty. `ios-build.sh` already
echoes `R2 set? …` but only as prose nobody reads at minute 20.

> Revision 2 first claimed `R2_BUCKET_HOSTNAME` was *missing* from `.env`, and inferred that the
> 2026-07-02 build must have booted to the config-error screen. Both were wrong — an audit `grep`
> used `^[A-Z_]+=`, which does not match the `2` in `R2`. `~/ios-build.log` records
> `API_URL set? yes  SUPABASE set? yes  R2 set? yes`. Retained here because "a required var is
> silently absent" is exactly the class of failure the assertion is meant to catch.

### P3 — this build talks to **production**

In a non-dev bundle `normalizeProductionApiUrl()` (`src/config.ts:30`) discards whatever
`EXPO_PUBLIC_API_URL` says and returns the literal `https://api.captivet.com`. The simulator will
therefore register **real devices against the real organization** and can write **real draft rows**.
Sentry and PostHog are also live in a release bundle (`enabled: !__DEV__`), so the run emits real
telemetry. Consequences that must be planned for, not discovered:

- Two new devices (`ios_phone`, `ios_tablet`) will consume the org's device cap. `DeviceLimitModal`
  appearing may be *correct behavior*, not a bug — resolve by revoking an old device in
  Settings → Devices.
- The run's PostHog events and Sentry issues are synthetic. Keep both **on** anyway: `trackEvent`
  and `captureException` call sites are threaded through every screen in this matrix, and stubbing
  them out would test a code path production never runs. Record the test `user_id` so the events can
  be filtered out later ([Phase 5](#phase-5--cleanup-mandatory)).
- Anything created during the run must be cleaned up in [Phase 5](#phase-5--cleanup-mandatory).

### P4 — a complete `.env` already exists on the Mac; do not use `eas env:pull`

`~/VetSOAP-Mobile-preflight-20260730/.env` (a Jul-30 v1.13.17 tree) carries **every** variable this
build wants, verified present with production-shaped values:

| Variable | Shape |
|---|---|
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | `614876359341-….apps.googleusercontent.com` — **real, not a placeholder** |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | `614876359341-….apps.googleusercontent.com` |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | `com.googleusercontent.apps.…` |
| `EXPO_PUBLIC_SENTRY_DSN` · `EXPO_PUBLIC_POSTHOG_KEY` · `EXPO_PUBLIC_POSTHOG_HOST` | set |
| `SENTRY_ORG` · `SENTRY_PROJECT` · `SENTRY_PROJECT_ID` · `SENTRY_AUTH_TOKEN` | set |

This replaces `ios-build.sh` step [3] entirely. `eas env:pull` was only ever a workaround for not
having these locally; it adds a network dependency, an untested production-environment fallback, and
an `exit 92` failure mode twenty minutes into a run. Merge the missing keys into the shipped `.env`
instead:

```bash
ssh macmini-ios 'cd ~/VetSOAP-Mobile
  for k in EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID \
           EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME EXPO_PUBLIC_SENTRY_DSN \
           EXPO_PUBLIC_POSTHOG_KEY EXPO_PUBLIC_POSTHOG_HOST; do
    grep -q "^$k=" .env || grep -m1 "^$k=" ~/VetSOAP-Mobile-preflight-20260730/.env >> .env
  done
  grep -oE "^[A-Za-z0-9_]+=" .env | tr -d "="'
```

Two consequences worth stating plainly:

- **`requireGoogleIosBuildConfig()` is satisfied with real values**, so no placeholder is needed and
  the `@react-native-google-signin` plugin plus `./plugins/with-ios-modular-headers.js`
  (`app.config.ts:157`, `:166`) are included exactly as in a production build — the AppCheckCore /
  GoogleUtilities modular-headers pod path that PR #90 exists to fix actually gets compiled.
- **Google Sign-In is no longer a dead button.** Revision 1 and revision 2's first pass both assumed
  a placeholder web client id. With the real one, tapping the button opens a genuine
  `ASWebAuthenticationSession`. Completing it still needs Google account credentials we may not have
  — so the assertion becomes "the sheet opens and cancels cleanly", with full sign-in attempted only
  if a usable Google account is on hand.

### Build environment

`~/ios-build.sh` already encodes the hard-won steps: source `.env` → `npm install --legacy-peer-deps`
(fires `postinstall: patch-package` for **both** patches, `ffmpeg-kit-react-native+6.0.2` and
`expo-audio+55.0.16`) → export build env → `eas build -p ios --profile preview-simulator --local`.

`preview-simulator` sets `APP_VARIANT=preview` and declares no `environment` key, so EAS injects
nothing — every variable must come from the shell, which is what sourcing the merged `.env` does.

**Corrections to `ios-build.sh` before running it** — the script is from 2026-07:

1. It exports `EXPO_PUBLIC_TEST_FORCE_DURABLE=1` and `EXPO_PUBLIC_TEST_BYPASS_SILENT=1`. **Neither
   flag exists in source any more** — they were one-off manual source edits, since reverted, and are
   inert. Delete both.
2. **Do not** substitute `EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true` for them (revision 1 said to).
   That flag is real (`src/lib/durableFlag.ts:15`, not `__DEV__`-gated, must be exactly `'true'`,
   one-way latch the server flag cannot clear) — but forcing it changes *which capture engine runs*
   and makes the build unfaithful to production, where `setDurableCaptureFlag()` lets the server
   decide. It also matters more than it looks on a simulator: the durable engine is `AVAudioEngine`
   (input node reports sampleRate 0 → 0 bytes), whereas the expo-audio path is `AVAudioRecorder`,
   which may well produce a valid silent file. **Primary build: flag unset.** A forced-durable
   second build is [Phase 6](#phase-6--optional-second-build-forced-durable-capture), run only if
   the server flag turns out to be off and time allows.
3. Delete step [3] (`eas env:pull` + filter + `exit 92`) and the
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=placeholder` export — superseded by
   [P4](#p4--a-complete-env-already-exists-on-the-mac-do-not-use-eas-envpull).
4. Add the fail-fast assertion from [P2](#p2--three-variables-are-load-bearing-and-a-missing-one-fails-invisibly)
   over the three required vars plus the three Google vars; `exit 93` on any empty one.
5. Point `--output` at `$HOME/builds/captivet-ios-sim-1.13.19.tar.gz` (absolute).
   `ios-smoke.sh`'s `latest_archive()` globs `$HOME/builds/*.tar.gz`, so this keeps the smoke script
   working; `captivet-joy-sim-1131.tar.gz` stays as the fallback.
6. Keep `export EAS_NO_VCS=1` — the shipped tree has no `.git` — and move it to the top of the script
   rather than mid-file.
7. Keep `SENTRY_DISABLE_AUTO_UPLOAD=true`. `SENTRY_AUTH_TOKEN` is available, but source-map upload is
   an extra failure surface on a build whose only proven-good configuration had it disabled. The cost
   is that any Sentry stack from this run is minified; JS errors are still legible via
   `ios-remote-helper.sh applog`.
8. Never wrap anything in `timeout` — it does not exist on this Mac.

### Running it

Long — run detached and poll (constraint 1):

```bash
ssh macmini-ios 'cd ~ && nohup bash ~/ios-build.sh > ~/ios-build-1.13.19.log 2>&1 & echo started $!'
# then poll, well under the 10-minute tool cap each time:
ssh macmini-ios 'tail -30 ~/ios-build-1.13.19.log; ls -la ~/builds/*.tar.gz 2>/dev/null'
```

This pipeline is proven: the same script produced a 115 MB `Captivet.app` / 40 MB tarball on
2026-07-02 with `IOS_BUILD_EXIT=0`. Budget 15–35 min (cold `node_modules` and cold Pods).

The fail-fast assertion from correction 4 runs in the first second, before `npm install`, so a
missing variable costs nothing instead of costing the whole run.

If `pod install` fails, pull the real per-phase log rather than guessing: `~/eas-buildlog.sh <BUILD_ID>`
(GZIP NDJSON, grep `INSTALL_PODS`). Likely suspects are the two local Podfile plugins,
`with-ffmpeg-ios-pod-source.js` (self-hosted `ffmpeg-kit-ios-min` podspec) and
`with-ios-modular-headers.js` (AppCheckCore/GoogleUtilities modular headers). For a `--local` build
there is no EAS build id — the phase output is inline in `~/ios-build-1.13.19.log`.

## Phase 3 — Install and drive

### P5 — `ios-drive.sh` targets `booted`, which is ambiguous here

Every command in `~/ios-drive.sh` is `xcrun simctl <cmd> booted`. With two sims booted that lands on
an arbitrary device — and the whole point of this run is comparing iPhone against iPad. Patch it to
take the device from `SIM_UDID`, failing loudly when unset:

```bash
# replace the two lines near the top of ~/ios-drive.sh
UDID="${SIM_UDID:?SIM_UDID must be set - refusing to guess between two booted sims}"
au(){ sub="$1"; shift; xcrun simctl "$sub" "$UDID" "$@"; }
```

Everything downstream (`au install`, `au launch`, `au io … screenshot`, …) then targets one named
device. Keep a copy of the original as `~/ios-drive.sh.bak-udid`.

`ios-remote-helper.sh` already honours `SIM_UDID` and needs no change.

### Install order

`simctl privacy` terminates a running app, so the order is **extract → install → grant → launch**
(revision 1 granted before install):

```bash
ssh macmini-ios 'cd ~ && rm -rf ios-extract && mkdir ios-extract && tar xzf ~/builds/captivet-ios-sim-1.13.19.tar.gz -C ios-extract && find ios-extract -maxdepth 4 -name "*.app" -type d'
APP=<path printed above>          # find it, never guess the filename
ssh macmini-ios "xcrun simctl install $IPHONE '$APP'"
ssh macmini-ios "xcrun simctl privacy $IPHONE grant microphone com.captivet.mobile"
ssh macmini-ios "SIM_UDID=$IPHONE bash ~/ios-drive.sh launch"
```

To reach a genuinely never-registered state for test A.1, `xcrun simctl uninstall <UDID>
com.captivet.mobile` first; if a device id survives in the sim keychain, `xcrun simctl erase <UDID>`
(then re-boot and re-install) is the guaranteed reset. Both sims are currently clean, so the first
run needs neither.

### Driving loop

`idb ui describe-all --udid <UDID>` (JSON array; frames in **points**) → `idb ui tap --udid <UDID> X Y`
→ `idb ui text --udid <UDID> "…"` → `xcrun simctl io <UDID> screenshot` → `scp` to WSL → `Read`.
**`--udid` is required on every idb call**, same reason as `simctl`.

Screenshot pixels ÷ point frames: **3× on `IPHONE`, 2× on `IPAD`** (revision 1 said 3× for both).

**Reaching routes with no UI entry point.** `durable-recovery`, `recording-recovery`, `audio-editor`,
`subscription` and `delete-account` are conditionally reachable at best — `durable-recovery` needs a
pending recovery, `recording-recovery` is gated on `canRecordAppointments` after a support-staff
sign-out. The app registers `scheme: 'captivet'` (`app.config.ts:178`), and expo-router deep-links to
any route, so open them directly:

```bash
ssh macmini-ios "xcrun simctl openurl $IPHONE 'captivet:///durable-recovery'"
```

Both `captivet://durable-recovery` and `captivet:///durable-recovery` resolve; group segments in
parentheses are not part of the URL. These are `(app)` routes, so the deep link only works **after**
sign-in — the auth guard will bounce it otherwise.

Without this, five of the nineteen routes are simply untestable. Record which ones rendered an empty
state versus real content — an empty state is still a pass for "the screen mounts without crashing".
`audio-editor` is the weakest of the five: it reads `audioEditorBridge` state that only a real
recording populates, so expect an empty/error state rather than a waveform, and judge it on "mounts
without crashing" alone.

**Backgrounding and locking** (needed by A.5 and F) — `simctl` cannot background an app, `idb` can:

```bash
ssh macmini-ios "~/idb-venv/bin/idb ui button HOME --udid $IPHONE"   # background
ssh macmini-ios "xcrun simctl launch $IPHONE com.captivet.mobile"    # foreground again
ssh macmini-ios "~/idb-venv/bin/idb ui button LOCK --udid $IPHONE"   # lock, for AppLockGuard
```

(`idb ui button` accepts `APPLE_PAY | HOME | LOCK | SIDE_BUTTON | SIRI`.)

Automation hazards to design around, all previously burned:

- `idb ui text` **intermittently drops trailing characters** — screenshot-verify after every typed
  field; repair by tapping the field's right edge and retyping the tail.
- `idb ui key` backspace does **not** clear fields — reset a form by terminate + relaunch.
- **`describe-all` frames cover off-screen scroll content.** They are not clipped to the viewport, so
  a y past the bottom of the screen taps whatever is actually painted there. On the iPhone the tab bar
  occupies y≈890, and one stale-coordinate tap silently navigated Home mid-form. Re-dump immediately
  before each tap, and never tap y > ~860 without confirming the target is on screen.
- **A system alert blinds `describe-all`.** While iOS's "Save Password?" sheet was up, the dump
  returned only the root `Application` node. If a dump comes back nearly empty, screenshot before
  concluding the screen is broken.
- No apostrophes inside single-quoted remote `ssh '…'` commands.
- The CoreSimulator "out of date" and "Authorization is required" warnings are non-blocking noise.
- **iOS gates custom-scheme deep links** behind an "Open in *Captivet*?" system prompt that must be
  confirmed (the Open button, not Cancel). Consecutive `openurl` calls **queue** these prompts instead
  of replacing them, so firing six routes in a loop leaves six stacked prompts and only the last route
  visible. Open one route at a time and clear its prompt before the next.
- **A short `idb ui swipe` can under-scroll a long screen.** The Settings screen stopped advancing
  under repeated default-speed swipes; `--duration 0.6` over a longer travel reached the bottom.

Crash watch: `log stream` is unbounded and would hit the 10-minute tool cap, so either run it
detached to a file, or (simpler) sample after each block with the existing helper:

```bash
ssh macmini-ios "SIM_UDID=$IPHONE bash ~/ios-remote-helper.sh applog 3m"
```

grepping for Hermes unhandled rejections, redboxes, and native exceptions.

## Phase 4 — Test matrix

Credentials: `CAPTIVET_USERNAME` / `CAPTIVET_PASSWORD` from `.env`.

**Device split.** `IPHONE` runs the whole matrix. `IPAD` runs A.1–A.3 (auth reachable), **B** (the
`ios_tablet` label — the reason the iPad run exists at all), **C** at a walk-through level, and all
of **D**. Sections **E** and the recording internals run on `IPHONE` only.

**Ordering is load-bearing:** A.1 is *observed during* sign-in (step 3), not before it — device
registration is post-auth. B requires a completed sign-in. E requires C's Record-tab work to have
produced a draft. F requires B/C first, because app-lock has to be switched on in Settings before
`AppLockGuard` locks anything.

**A. Cold start & auth — the highest-risk surface**

1. First authenticated API call from a never-registered sim → expect `DEVICE_REGISTRATION_REQUIRED`
   (428) → `registerDevice()` → automatic single retry, nothing surfaced to the user. This fires on
   the first `/api/*` call **after** sign-in, not at launch, so observe it during step 3 rather than
   before it.
2. Bad password → clean error, no crash, no stuck spinner.
3. Real credentials → lands on Home. Watch for the rule-22 `AuthRetryableFetchError` retry and the
   rule-24 15 s auth-init watchdog — **a watchdog firing is a failure here**, not a recovery.
4. `SIM_UDID=… ios-drive.sh relaunch` ×3 → session restores from the Keychain every time. This is
   the direct on-device exercise of the `secureStorage` read-back/cache changes (rules 3, 17) and
   `chunkedRead`, on a Keychain rather than a Keystore.
5. Background (`idb ui button HOME`) → foreground (`simctl launch`) → the rule-18 `AppState`
   `'active'` handler must call `supabase.auth.getSession()` fresh and not force a sign-out.
6. Cold-start splash: `SplashGate` returns `null` unless `Platform.OS === 'android'`
   (`app/_layout.tsx:268`), so iOS takes the **native** splash path Android never exercises — check
   for flash or hang. Separately, `ThemedStatusBar` (`app/_layout.tsx:372`) forces `style="dark"`
   while `isLoading` on iOS — confirm the status bar is legible in **dark** mode during launch.
   (Revision 1 conflated these two lines.)
7. MFA screen if the account is enrolled. **Risk:** if it is, headless sign-in needs a TOTP code.
   Mitigation: generate one locally with `oathtool --totp -b <secret>` if the secret is on hand;
   otherwise record MFA as **blocked — needs the enrollment secret** and continue. Determine
   enrolment on the first sign-in attempt, before planning around it.

**B. Device identity — rule 23, never verified on iOS**

- Settings → Devices must show a **phone** label on `IPHONE` and an **iPad** label on `IPAD`
  (`src/auth/AuthProvider.tsx:937-939`, `Platform.isPad` → `ios_tablet` / `ios_phone`). This is why
  the iPad run is not optional.
- `useDeviceCapacity` (+44) and `DeviceLimitModal` (+38) both changed in `031d92d` (incl. "accept an
  empty device list") — verify the list renders and the modal copy is right. Note [P3](#p3--this-build-talks-to-production):
  a device-limit modal here may be a truthful cap, not a defect.

**C. Every screen — 19 screen routes, 4 tabs**

(Revision 1 said 26 routes; the real count is 19 non-layout `.tsx` files under `app/` — 4 + 7 + 8.)

- `(auth)` — 4: `login` (email + Google + Apple buttons), `forgot-password`, `reset-password`, `mfa`.
- `(tabs)` — 7 across 4 tabs: **Home** (`index`) · **Record** (`record`) · **Recordings**
  (`recordings/index`, `recordings/[id]`, `recordings/attention`) · **Patients** (`patient/index`,
  `patient/[id]` — the directory is `patient/`, singular).
- `(app)` stack — 8: `settings`, `profile`, `devices`, `subscription`, `delete-account`
  (**render only, never confirm**), `audio-editor`, `durable-recovery`, `recording-recovery`.
- Home specifics: quality-analytics card (visible to **all roles** by design — do not report the
  absence of role-gating as a bug), attention-feed section, recent recordings, and the
  organization/practice name shipped in #176.
- Specific checks: recording detail's audio-player permission gating (player vs forbidden-state
  card, no permission flash) · `/recordings/attention` back-nav — both affordances must return to
  the tabs and never strand the Recordings tab on a detail · audio-editor left trim handle dragged
  from the screen edge, which is exactly why `gestureEnabled: false` is set there
  (`app/(app)/_layout.tsx:207`) · Record tab form validation, add/remove slots up to 10, tab strip,
  Save for Later → stash → Resume, discard confirm with count.
- **Google button:** rendered, and now backed by **real** client ids
  ([P4](#p4--a-complete-env-already-exists-on-the-mac-do-not-use-eas-envpull)).
  `isGoogleSignInConfiguredForCurrentPlatform()` (`src/auth/socialAuth.ts:129`) returns true, so
  tapping opens a genuine `ASWebAuthenticationSession`. Assert: the sheet opens, and cancelling
  returns to login with no crash and no stuck spinner. Attempt a full sign-in only if a usable Google
  account is available.
- **Apple button:** downgraded to render-only. Signing an Apple ID into a simulator is a GUI/2FA
  flow, and name/email arrive only on the *first* Apple auth — one-shot, not worth spending here.

**D. Rendering / accessibility**

Light and dark (`xcrun simctl ui <UDID> appearance dark|light`) and largest Dynamic Type
(`xcrun simctl ui <UDID> content_size accessibility-extra-extra-extra-large` — token verified valid)
against the `maxFontSizeMultiplier` 1.3 cap, on both iPhone and iPad geometry. React Native usually
picks these up live via the trait-collection change; if a screenshot does not reflect the new setting,
relaunch the app before calling it a rendering bug. Text clipping is the
known *Android* failure class (`fontWeightAdjustment`, absent on iOS); on iOS this pass is about
layout overflow, the font cap, and `KeyboardAvoidingView behavior='padding'` on the four auth
screens plus `src/components/ui/Sheet.tsx`.

**E. Sign-out data preservation — rule 8**

Create a draft → sign out → sign back in → the draft must still be there. A regression here is the
"Lela bug", and `src/lib/draftStorage.ts` is the single most heavily changed source file in
`031d92d` (+194 lines).

**This test has a mic-shaped precondition and needs a fallback.** Reaching "Finish" requires the
recorder to have produced *something*. Verify empirically, in order:

1. ~~Does `Start recording` succeed on the sim?~~ **Answered: no.** AudioQueue cannot build a
   converter from a 0-channel input (see Known simulator limits), so no segment, and therefore no
   draft, can ever be produced by recording. The draft route to E is **blocked on a simulator**.
2. ~~Fall back to the **stash** round-trip.~~ **Also blocked.** `canStash`
   (`record.tsx:5399`) is gated on `hasUnsavedRecordings`, so with no audio the **Save for Later**
   control never renders — verified on the device: a fully filled patient form with no recording
   shows no stash affordance anywhere on the Record screen. Stash cannot be reached without capture.
3. What remains is the only rule-8 evidence a simulator can produce, and it is real: the two existing
   server-side draft rows on the account render as "Not Submitted / audio not on this device" and
   must still be there after a sign-out/sign-in cycle. That exercises `draftStorage`'s presence
   reconciliation and rule 8's "clear only transient caches" on real data.
4. Full rule-8 coverage — a locally-recorded draft with real audio surviving logout — needs a
   **physical iPhone**. Say so in the results rather than implying the simulator covered it.

**F. Biometrics — recovered from revision 1's "not drivable"**

**Precondition:** `AppLockGuard` only locks when the user has turned app lock on, so enrol the
biometric *first*, then sign in, then enable app lock in Settings — otherwise the guard is a no-op
and "no lock screen" is a false negative.

`notifyutil` is present inside the simulator (verified), so `AppLockGuard` *is* drivable over SSH:

```bash
xcrun simctl spawn <UDID> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn <UDID> notifyutil -p com.apple.BiometricKit.enrollmentChanged
xcrun simctl spawn <UDID> notifyutil -p com.apple.BiometricKit_Sim.pearl.match     # success
xcrun simctl spawn <UDID> notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch   # failure
```

Cover the cold-start lock (blank screen, no PHI flash), the 12 s watchdog, and sign-out as the
escape hatch. If the notification names turn out not to drive this runtime, downgrade to partial and
say so — do not retry blindly past two attempts.

## Known simulator limits — stated now, not discovered at hour three

- **No microphone — and recording cannot start at all.** Settled empirically during this run, not
  assumed. Tapping **Start recording** raises the app's own "Recording Error" alert ("Could not start
  recording. Please check that your device has a microphone…"), and the simulator log gives the cause:

  ```
  AudioConverter.cpp:1087  Failed to create a new in process converter -> from  0 ch,  44100 Hz, ...
                           to  1 ch,  44100 Hz, aac ..., with status -50
  AudioQueueObject.cpp:1886  BuildConverter: AudioConverterNew returned -50
  ```

  The input device enumerates with **0 channels**, so AudioQueue cannot build an AAC converter. This
  hits the **expo-audio / `AVAudioRecorder`** path, not only `AVAudioEngine` — so revision 2's
  hypothesis that expo-audio "may still produce a valid, silent file" is **wrong**: no file is
  produced because capture never starts. That is also a **rule-6 pass**: `useAudioRecorder` threw,
  `record.tsx` caught it, and the user got an actionable alert instead of a crash or a stuck timer.

  Everything downstream of capture — segments, drafts-from-Finish, the silent-audio guard,
  Upload Anyway, `createWithFile` preflight, durable ADTS — is therefore **unreachable on this
  simulator** regardless of which engine is selected. Only a physical iPhone can reach it.
- **The silent-audio guard is *not* a hard block** — though on this hardware it is never reached,
  since capture cannot start. Recorded here because it changes what a *physical-device* run should
  expect. Revision 1 claimed `checkSilentAudio()`
  "blocks every Submit" and that "there is no bypass flag". Neither is true: `record.tsx:574`
  `confirmSilentUpload()` presents an `Alert` with **"Upload Anyway"** (`SILENT_CHECK_COPY.upload`),
  and only a *cancel* raises the `uploadPhase: 'silent_check'` error. So if the expo-audio path
  yields a non-empty file, the **full record → upload path is reachable on the simulator** via
  Upload Anyway. If it yields 0 bytes, `recordingsApi.createWithFile()`'s `getInfoAsync` validation
  (rule 9) rejects it earlier, at `preflight` — a different failure, at a different phase, and worth
  distinguishing in the results.
  (CLAUDE.md's *Emulator Testing* section carries the same stale "every Submit throws" claim for
  Android; correcting it is out of scope here but worth a follow-up.)
- Real ADTS durable-byte validation and the transcribe path still need a **physical iPhone**. The
  iOS durable-recorder Swift *runtime* — the single least-tested thing in the codebase — stays
  unverified. Its *recovery* surface (manifest reads, tombstone, `durable-recovery` screen) mounts
  without a mic, but with capture never engaging there will be **no manifests**, so expect an empty
  state. Proving recovery against a real manifest needs
  [Phase 6](#phase-6--optional-second-build-forced-durable-capture) or a physical device — an empty
  `durable-recovery` screen is a "mounts cleanly" pass, not a recovery pass.
- **`modules/captivet-audio-focus` is a no-op stub on iOS** (`index.ts:18` / `:30`, `getNativeModule`
  returns `null` off Android), so interruption handling takes the expo-audio `hasError` path.
  Without a mic this is not reachable either.
- **Google SSO** is configured with real client ids, so the auth sheet is reachable; *completing*
  it needs Google account credentials that may not be on hand. See C for the reduced assertion.
- **No packet-level request counting.** mitmproxy needs sudo/system-proxy and the app validates
  upload URLs. The request-amplification fix is therefore verified by the local `query-fanout-guard`
  + `storage-read-parallelism` suites plus observed symptoms (no repeated dashboard refetch, no
  spinner hangs, sane cold-start latency), not by counting packets.

## Phase 5 — Cleanup (mandatory)

Because this build hits production ([P3](#p3--this-build-talks-to-production)):

1. Revoke both simulator devices so they stop consuming the org's device cap. A device generally
   cannot revoke itself, so revoke one sim from the other; the survivor has to be revoked from
   Captivet Connect or another already-signed-in device.
2. Delete any draft/recording rows the run created — a "Not Submitted" row left behind is
   indistinguishable from a real user's un-sent work.
3. Sign out on both sims.
4. Record the test account's `user_id`, the run window (UTC), and `release = 1.13.19` in the results
   doc, so the synthetic PostHog events and Sentry issues this run produced can be filtered out of
   product metrics later. Do not delete them — a crash captured here is a real finding.
5. Reset the simulators' accessibility state so the next run starts neutral:
   `xcrun simctl ui <UDID> content_size large` and `xcrun simctl ui <UDID> appearance light`.
6. Leave `~/builds/captivet-joy-sim-1131.tar.gz` in place as the fallback artifact.

## Phase 6 — Optional second build (forced durable capture)

**Superseded by the run — do not spend the build time.** The rationale was that a forced-durable
build would at least exercise `CaptivetDurableRecorderModule.swift` at runtime. It would not: capture
fails *before* either engine is reached, at AudioQueue, because the simulator's input device
enumerates with 0 channels (see Known simulator limits). `AVAudioEngine` faces the same input and
will fail the same way, so a second 7-minute build buys a second identical alert.

The one thing it could still show is whether the native module **loads and rejects cleanly** rather
than crashing — but `DurableRecorderUnavailableError` handling is already covered by the fallback path
and by `tests/durable-*.test.mjs`. Spend the time on a physical iPhone instead.

## Abort criteria

Stop and report rather than grinding:

- `pod install` fails twice for the same reason after a targeted fix.
- The app boots to "Configuration Error" (means a required `EXPO_PUBLIC_*` is still missing).
- Sign-in cannot complete (MFA secret unavailable, or repeated `AuthRetryableFetchError`) — the
  entire post-auth matrix is then blocked, and that fact *is* the deliverable.
- Any single `idb`/`simctl` interaction fails 3 times in a row.
- The build produces no artifact and the failing phase in `~/ios-build-1.13.19.log` is not one of the
  two known Podfile-plugin suspects — an unfamiliar native failure is a report, not a debugging
  expedition.
- **SSH to the Mac dies and does not come back.** `macmini-ios` resolves only through Tailscale
  MagicDNS (`phils-mac-mini.tail56970f.ts.net`); there is no LAN or mDNS fallback, and the 100.x
  address does not route while the daemon is down. If the Windows Tailscale service wedges (symptom:
  `tailscale status` prints `Tailscale is starting. Please wait.` / `unexpected state: NoState`,
  often with two `tailscaled` processes), the entire run is blocked. `tailscale up` does not recover
  it — the service needs an elevated restart, which is the operator's call, not the agent's.
  Write up what completed and what did not rather than idling.

## Deliverable

`docs/ios-simulator-test-results-2026-08-25.md`, structured as:

1. **What was built** — commit, marketing version, artifact path and size, build duration, the exact
   env the bundle was compiled with (names only, never values), and whether durable capture engaged.
2. **Pass/fail table**, one row per matrix item (`A.1`…`F`), each with a verdict of
   `PASS | FAIL | BLOCKED | N/A-simulator` and a one-line justification. `BLOCKED` must name what
   blocked it; a blocked item is a result, not an omission.
3. **Screenshots** per screen per device, light and dark, plus the Dynamic Type pass — held in the
   session scratchpad, **not committed**. See the PHI rule below.
4. **Anomalies** — every crash, redbox, Hermes unhandled rejection and native exception quoted
   **verbatim** from `applog`, with the screen and the step that produced it.
5. **Still needs a physical iPhone** — an explicit list, so the gap is a known quantity rather than
   an assumption.
6. **Cleanup record** — Phase 5's device revocations, deleted rows, and the `user_id` / UTC window
   that identifies this run's synthetic telemetry.

Every verdict must cite the evidence that produced it. "Looks fine" is not a pass.

### PHI rule for the deliverable

This build signs into **production** ([P3](#p3--this-build-talks-to-production)), so nearly every
post-auth screen renders real patient and client data — the Home screen alone carries a full clinical
summary, owner surnames, and appointment times, and an `idb ui describe-all` dump reproduces all of it
verbatim. `docs/` is committed to git.

- **Never paste an accessibility dump into the results doc.** Describe the *structure* ("attention
  feed rendered 1 actionable row + a practice summary"), never the content.
- **Do not commit screenshots of authenticated screens.** Keep them in the session scratchpad and on
  the Mac under `~/shots/`. The `(auth)` screens are safe; everything behind sign-in is not.
- Quote log anomalies verbatim as required, but scrub any patient/client name, recording id, or
  `file://` path first — the same rule `monitoring.ts`'s `beforeSend` applies to Sentry.
- Where a specific value matters to a verdict (a count, a status, a date), cite the value without the
  identifier: "one draft row, status `draft`, audio-not-on-device" rather than the patient's name.

This is not optional politeness — CLAUDE.md's monitoring rules forbid PHI in any exported artifact,
and a git commit is the most permanent export there is.

---

## Appendix A — corrections applied to revision 1

| # | Revision 1 claim | Reality | Severity |
|---|---|---|---|
| 1 | Branch has 7 unmerged commits, 31 files, +2488/−158 | The diffstat is exactly right — but it belongs to squash `031d92d` (PR #170), already on `main`. `git diff origin/main HEAD` is **empty**, so this tests `main` @ v1.13.19, not unmerged work. | framing |
| 2 | Ship with `--exclude=android --exclude=ios` | Unanchored — strips both local Expo modules' native source **and** all `assets/*.png`. Verified missing on the Mac. Ship `git ls-files` instead. | **build-blocking** |
| 3 | Build env = `.env` + 3 Google vars | `EXPO_PUBLIC_R2_BUCKET_HOSTNAME` is *also* required in a non-dev bundle. It is present, so not a blocker — but a missing one fails invisibly, so the build now asserts all six up front. (Revision 2 first mis-reported it as missing; see P2.) | hardening |
| 4 | (unstated) | The build hits **production** `api.captivet.com` regardless of `.env`; needs a cleanup phase. | operational |
| 5 | Replace the dead test flags with `EXPO_PUBLIC_FORCE_DURABLE_CAPTURE=true` | The flag is real, but forcing it makes the build unfaithful to production and swaps `AVAudioRecorder` for `AVAudioEngine`. Primary build leaves it unset; forced build is Phase 6. | design |
| 6 | `checkSilentAudio()` "blocks every Submit"; "no bypass flag" | `confirmSilentUpload()` offers **"Upload Anyway"** (`record.tsx:574`). The upload path may be reachable. | **incorrect** |
| 7 | `app/_layout.tsx:372` gates the splash | `:372` is `ThemedStatusBar`'s icon colour. The splash gate is `:268`. Both are worth checking; they are different things. | incorrect |
| 8 | 26 routes | 19 non-layout screen routes (4 auth, 7 tabs-group, 8 `(app)` stack). Tab count 4 is correct. | incorrect |
| 9 | "Patients (`index`, `[id]`)" | Directory is `patient/`, singular. | incorrect |
| 10 | Google button "may be hidden outright (`socialAuth.ts:131`)" | It renders — and with the real client ids found in the preflight `.env` it opens a genuine auth sheet, so this is testable rather than dead. | incorrect |
| 11 | `ios-drive.sh install/launch` | The script uses `simctl … booted`, ambiguous with two sims booted — and `simctl` does **not** error, it silently picks one. Patch it to require `SIM_UDID`. | **would corrupt results** |
| 12 | `idb ui tap X Y` | `--udid` required on every `idb` call too. | same |
| 13 | Grant mic, then install, then launch | `simctl privacy` needs the app installed to be meaningful; order is install → grant → launch. | ordering |
| 14 | Screenshots are 3× | 3× on iPhone 17 Pro Max, **2× on iPad Air 11 M3**. | incorrect |
| 15 | Mac repo is stale v1.13.7, no `CAPTIVET_*` in `.env` | Repo was already v1.13.19 and `.env` already had all 6 keys — but the tree was the **incomplete** one from #2. | stale |
| 16 | Face ID only partially drivable (GUI menu) | `notifyutil` works inside the sim → enroll + match/nomatch are drivable over SSH. New section F. | too pessimistic |
| 17 | A.1 "first launch on a never-registered sim → 428" | Device registration happens after sign-in; the 428 is observed during step 3, not before it. | ordering |
| 18 | (unstated) | The 30-min build exceeds the controlling tool's 10-minute cap — long steps must run detached and be polled. | **process-blocking** |
| 19 | `log stream` alongside the run | Unbounded; same cap problem. Use `ios-remote-helper.sh applog` sampling or a detached writer. | process |
| 20 | (unstated) | Phase 4E needs a recording to exist; on a mic-less sim that may be impossible. Added an empirical precondition ladder with a stash-based fallback. | gap |
| 21 | (unstated) | No post-ship integrity check, despite the previous ship having failed silently. Added. | gap |
| 22 | (unstated) | MFA enrolment could block the entire post-auth matrix; needs an explicit mitigation and abort criterion. Added. | gap |
| 23 | Deliverable unnamed | Now `docs/ios-simulator-test-results-2026-08-25.md`. | gap |
| 24 | `docs/mac-mini-ssh.md` referenced by CLAUDE.md | The file does not exist. Connection facts recorded here instead. | doc debt |
| 25 | CI typechecks 4 durable Swift files | Correct — and additionally `captivet-audio-focus/ios/CaptivetAudioFocusModule.swift` is typechecked by **no** workflow. | addition |
| 26 | (unstated) | Five `(app)` routes have no reliable UI entry point; added `simctl openurl captivet:///<route>` deep-linking. | gap |
| 27 | "Background → foreground" with no mechanism | `simctl` cannot background an app; `idb ui button HOME` / `LOCK` can. | gap |
| 28 | `eas env:pull --environment preview`, with a `production` fallback and `exit 92` | Unnecessary: `~/VetSOAP-Mobile-preflight-20260730/.env` already holds all three Google vars plus Sentry/PostHog. Step [3] deleted; `EAS_NO_VCS=1` moved to the top of the script. | simplification |
| 29 | (unstated) | A green `--local` build says nothing about runtime config — the 2026-07-02 build exited 0 with no runtime evidence either way. Hence the fail-fast assertion and the explicit "app renders past the config gate" check. | insight |
| 30 | Revision 2's own P2 | Claimed `R2_BUCKET_HOSTNAME` was absent from `.env`; the audit grep `^[A-Z_]+=` did not match the `2`. Retracted in place — P2 is now a hardening step, not a blocker. | self-correction |
| 31 | (unstated) | Sentry and PostHog are live in a release bundle, so the run emits real telemetry. Kept on for fidelity; Phase 5 records how to identify the synthetic session. | operational |
| 32 | (unstated) | `expo-doctor` fails on 22 patch-level drifts. `expo install --fix` must **not** be run: it would bump `expo-audio` past `patches/expo-audio+55.0.16.patch` and silently drop the Android recorder-latency patch. Documented as a standing exception in Phase 0. | scope |
| 33 | Deliverable = "screenshots per screen" | Every authenticated screen renders **production PHI** — the Home screen alone carries a full clinical summary and owner surnames, and an AX dump reproduces it verbatim. `docs/` is committed. Added an explicit PHI rule: describe structure, never paste dumps, never commit authenticated screenshots. | **would leak PHI** |
| 34 | "expo-audio may still produce a valid, silent file" (revision 2's own hypothesis) | Wrong. Capture never starts: `AudioConverterNew` returns `-50` on a 0-channel input, so **no** recording path is reachable on this Mac. Settled by running it. Rule 6 handled it correctly — actionable alert, no crash. | self-correction |
| 35 | E's stash fallback | Also unreachable: `canStash` (`record.tsx:5399`) requires `hasUnsavedRecordings`, so **Save for Later** never renders without audio. Verified on device. E reduces to the server-draft survival check. | self-correction |
| 36 | Driving loop | `idb ui describe-all` returns frames for **off-screen scroll content** in the same coordinate space as visible content, so a y beyond the viewport taps whatever is really there — the tab bar sits at y≈890 on the iPhone and swallowed a mis-aimed tap. Re-dump immediately before every tap, and treat y > ~860 as the tab-bar exclusion zone. | **would corrupt results** |
| 37 | Deep-linking `(app)` routes | iOS interposes an "Open in Captivet?" prompt per `openurl`, and consecutive calls **queue** the prompts. Open one route at a time. Confirmed during the run. | addition |
| 38 | Section F precondition | Confirmed on device: the Face ID Lock row is gated on `biometrics.isAvailable()`, so it is **hidden** until a biometric is enrolled. Enrol first, or "no lock toggle" reads as a false negative. | confirmed |
| 39 | Phase 6 | Superseded. Capture fails at AudioQueue before either engine runs, so a forced-durable build cannot exercise the durable Swift runtime either. | self-correction |
| 40 | (unstated) | `macmini-ios` has **no fallback route** — Tailscale MagicDNS is the only path, so a wedged Tailscale service on the Windows host blocks the whole run mid-matrix. Added to the abort criteria. | operational |

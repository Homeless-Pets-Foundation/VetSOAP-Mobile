# Sentry triage — October 5–6, 2026

Scope: organization `vetsoap-mobile`, project `react-native`: all 16 issues
unresolved on 2026-10-06, pulled through the Sentry API (issue details, event
extras, breadcrumbs, thread dumps). Work started from Sentry's email
notifications while the connector needed re-authorization; everything below was
re-verified against the API, and the email-only first pass missed the
highest-volume issue (REACT-NATIVE-1Y) and the data-loss signal in
REACT-NATIVE-1X.

Every REACT-NATIVE-1X event comes from one clinic organization: five Galaxy
Tab A7 Lite tablets (SM-T220 ×3, SM-T227U, SM-T225N) on one account, plus an
emulator on a second account.

| Issue | Signal | Events / last seen | Disposition |
|---|---|---|---|
| REACT-NATIVE-1X | `capture_ended_without_cleanup` | 12 / Oct 5 | **Fixed** 08b4ad4 (durable flag); see below |
| REACT-NATIVE-22 | ANR (fatal, AppExitInfo) | 1 / Oct 5 | **Analyzed**; recreation fix needs a device pass |
| REACT-NATIVE-1Y | `slow_phase_recorder_durable_start` | 168 / Oct 5 | **Open** — native latency, deferred by #222 |
| REACT-NATIVE-1K | `init_watchdog_fired` | 1 (regression) / Oct 5 | **Fixed** 4f7b999 (session restore) |
| REACT-NATIVE-1W | slow recorder prepare (Sep 7 triage) | 2 / Oct 3 | Latency warning; details pending |
| REACT-NATIVE-21 | captureMessage | 1 / Oct 1 | Details pending |
| REACT-NATIVE-1T | slow draft-presence reconciliation (Sep 7 triage) | 21 / Sep 29 | Latency warning; details pending |
| REACT-NATIVE-1B | `slow_phase_fetchUser` (Sep 7 triage) | 6 / Sep 28 | Latency warning; details pending |
| REACT-NATIVE-1P | captureMessage | 3 / Sep 19 | Details pending |
| REACT-NATIVE-1S | slow pending-draft sync (Sep 7 triage) | 2 / Sep 19 | Latency warning; details pending |
| REACT-NATIVE-20 | captureMessage | 1 / Sep 16 | Details pending |
| REACT-NATIVE-1G | slow record pending-draft scan | 2 / Sep 14 | Fixed by #222 (single-flight); no events since |
| REACT-NATIVE-1D | slow draft list | 2 / Sep 14 | Fixed by #222 (single-flight); no events since |
| REACT-NATIVE-1Z | `ApiError` on a 409 | 1 / Sep 14 | #222 added 409 copy; no events since |
| REACT-NATIVE-1A | captureMessage | 2 / Sep 14 | Details pending |
| REACT-NATIVE-1J | `recording_submit_failed:prepare:HTTP_401` | 1 / Sep 14 | Fixed by #222/#223 (stale-token retry); no events since |

"Details pending" rows are being pulled per release; this table is updated in a
follow-up commit.

## REACT-NATIVE-22 + 1X: an ANR killed a recording that was not crash-safe

Timeline from the ANR event's persisted breadcrumbs and the next launch
(UTC, 2026-10-05, tablet SM-T220 "A"):

| Time | Event |
|---|---|
| 21:12:35 | App returns to the foreground |
| 21:13:52.805–.875 | `MainActivity` paused → stopped → saveInstanceState → **destroyed** |
| 21:13:52.989–53.013 | `MainActivity` created → started → resumed (foreground, ~200 ms) |
| 21:13:53–58 | Full startup again: `fetchUser`, device registration, `record_screen_mount_work`, `durable_recovery_scan offered 4`, `battery_opt_prompt`, GET /api/templates |
| 21:14:05 | ANR (AppExitInfo, fatal); no breadcrumbs after 21:13:58.459 |
| 21:14:06.641 | Next process starts |
| 21:14:11 | `capture_ended_without_cleanup` with `expo_count: 1`, `durable_count: 0`, `recovered_count: 0` |

**What froze.** Main thread: `Choreographer.doFrame` → `performMeasure` →
`SurfaceHandlerBinding.setLayoutConstraints` → `SurfaceHandler::constraintLayout`
→ `ShadowTree::commit` → `YogaLayoutableShadowNode::layoutTree` (deep Yoga
recursion). JS thread at the same moment: `ShadowTreeRegistry::visit` →
`ShadowTree::commit` → `updateMountedFlag` (deep recursion). Both threads were
committing the same surface: the new Activity's root measure forcing a full
layout while React committed the freshly re-mounted tree. The Expo module queue
was idle. Four `ExoPlayer:Playback` threads were alive.

**Why the Activity was recreated.** The destroy/create pair inside 200 ms
while in the foreground is a configuration change. Expo's default manifest
declares `keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize`
for `MainActivity`; any other runtime change (font size, display size, Bold
text / `fontWeightAdjustment`, locale, `navigation` e.g. a keyboard cover)
destroys and recreates the Activity, and React Native then unmounts and
re-mounts the whole app. That discards all in-memory state, including a
recording in progress. Which change fired here is not recorded.

**Why the audio was lost.** The in-flight capture was on the expo-audio
fallback, which has no checkpoint (record.tsx: "the live recording stays owned
by expo-audio until the user taps Finish") and whose MPEG-4 file does not
survive a process death — although the API sends
`X-Durable-Capture-Enabled: true` on every response. The flag was memory-only,
started OFF in every process, and flipped OFF on any response without the
header, so a fresh recording fell back to expo-audio after every cold start
until the first API response, for a whole offline session, and after any
edge-proxy error page.

How often: of the twelve REACT-NATIVE-1X events, this is the only one with an
expo capture (65 durable pointers in total, 15 still recoverable). The
fallback was rare in practice, which is exactly why it went unnoticed: the one
time it mattered, the audio was gone.

**Fixed** (08b4ad4): the flag is persisted and hydrated at startup
(record-start awaits it, bounded), and only a response echoing our
`X-Request-Id` may change it; from the API, an absent header still fails
closed. Connect pins the echo and header order (6c11a26). See
`src/lib/durableFlag.ts`.

**Not fixed: the recreation and the ANR.** Declaring the remaining
configuration changes on `MainActivity` (via a config plugin) would stop a
settings change from re-mounting the app mid-recording. It is a native manifest
change that needs a device pass — change font size, display size, Bold text,
and attach/detach a keyboard cover mid-recording, and confirm text and layout
update in place — so it is left as the recommended next step.

## Recordings waiting on tablets for weeks

`durable_recovery_scan` breadcrumbs on the 1X events show the same tablets
offered the same number of recoverable recordings at every launch:

| Tablet | Sep 8 | Sep 12–16 | Oct 2–5 |
|---|---:|---:|---:|
| SM-T220 "B" | 6 | 6 | 6 |
| SM-T220 "A" | 3 | 4 | 4 |
| SM-T227U | 3 | 3 | 4 |

An offer is a durable recording with audio that is neither confirmed uploaded
nor tombstoned, and that no draft or saved session owns
(`selectRecoverableSessions`); `self_healed` was 0 every time, so the server
does not have them. The recovery screen is their only way back. Unless these are
abandoned test takes, they are visits without SOAP notes. Action: open the
recovery screen on those tablets and submit or discard; then consider an
age-based escalation (or converting long-unclaimed recoveries into "Not
Submitted" drafts) so they cannot sit unseen.

## REACT-NATIVE-1K: cold start dropped signed-in vets on the sign-in screen

`supabase.auth.getSession()` awaits GoTrue's `initialize()`, and `initialize()`
refreshes the persisted session over the network whenever the access token is
within 90 seconds of expiry (`EXPIRY_MARGIN_MS`). auth-js 2.116 retries a
retryable refresh failure with exponential backoff while the elapsed time stays
under 30 seconds, and React Native's `fetch` has no timeout of its own. The
access token lives one hour, so every cold start after an hour of idleness —
start of day, after lunch — puts the network on the critical path.

Reproduced against the installed `@supabase/auth-js` 2.116.0 with a persisted
session whose access token had expired:

| Network | `getSession()` | Attempts | Result | Session in storage |
|---|---|---:|---|---|
| Offline (fetch rejects) | settles after 25.4 s | 8 | `session: null`, `AuthRetryableFetchError` | still present |
| Stalled (fetch never answers) | not settled after 40 s | 1 | — | still present |

`AuthProvider` bounds that call at 10 seconds and treated both outcomes as "no
session", so a signed-in vet landed on the sign-in screen while GoTrue still
held a valid refresh token. Online, the vet was bounced back in when the
refresh eventually landed. Offline, the vet could not sign in, so drafts and
the recorder stayed unreachable until connectivity returned. The profile-cache
fallback in `fetchUser`, which exists for the offline vet, never ran, because it
is only reached once a session exists — and it looked the user up through the
same `getSession()`. Between 1.13.20 and 1.13.21 neither `AuthProvider.tsx` nor
`supabase.ts` changed and the auth-js refresh paths are byte-identical, so the
"regression" is a resolve-without-fix, not a new bug.

**Fixed** (4f7b999, `src/auth/sessionRestore.ts`): when the bounded
`getSession()` neither answers nor reports a session because of an
`AuthRetryableFetchError`, `AuthProvider` reads the persisted session (bounded
at 4 s, inside the 15 s init watchdog) and adopts it through the normal
lazy-validation path; GoTrue's later TOKEN_REFRESHED / SIGNED_OUT still decide.
The restore re-checks after its await and skips if the watchdog already fired,
any non-INITIAL_SESSION auth event arrived, the effect was torn down, or the
auth generation moved. `fetchUser`'s cache fallback can use the restored user
id, generation-stamped so it never survives a sign-out.

Policy consequence to confirm: an offline device now keeps its signed-in session
until it next reaches the network, instead of lapsing an hour after its last
refresh. `init_watchdog_fired` will keep firing — it measures a slow cold
start, which is now recoverable rather than shorter; recoveries are counted by
the PostHog event `session_restored_from_storage`.

## REACT-NATIVE-1Y: durable start latency (168 events)

`slow_phase_recorder_durable_start` fires on nearly every recording start on
these tablets: 1.4–2.7 s against the 1 s threshold (latest 1.602 s). #222 kept
the threshold as a target and deferred the Kotlin work. Two notes for that
work, neither verifiable without a device:

- `openPipeline` is fully serial, and it calls `AudioRecord.startRecording()`
  BEFORE creating the AAC encoder, while nothing drains the mic until
  `startThreads()`. The ring buffer is 8 × min-buffer (≈0.3 s at 16 kHz mono), so
  an encoder bring-up slower than that may drop the first fraction of a second
  of every recording. Opening the encoder first removes that window.
- `start()` runs on the single `expo.modules.AsyncFunctionQueue` thread that
  every Expo module shares, so for its 1.4–2.7 s it also stalls SecureStore and
  file-system calls. A dedicated queue for the recorder's heavy functions would
  isolate them.

## Validation

Mobile: full Node suite 1318/1318, `tsc --noEmit`, `expo lint`, R2 contract under
Node 20. Connect: `durable-capture-header.test.ts` 6/6, api typecheck,
Prettier. New tests were checked to fail under mutation. Nothing here was
validated on a device.

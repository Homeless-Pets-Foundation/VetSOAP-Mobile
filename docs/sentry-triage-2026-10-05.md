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

Sentry keeps about 30 days of events (the oldest left is 2026-09-08), so an
issue's lifetime total is larger than what can be tied to a release. "Older"
below counts kept 1.13.20 events plus aged-out ones; every aged-out event
predates 1.13.21, whose first event anywhere is 2026-09-16. All three tablet
models were sending 1.13.21 events by 2026-10-02.

| Issue | Signal | 1.13.21 | Older | Last seen | Disposition |
|---|---|---:|---:|---|---|
| REACT-NATIVE-1X | `capture_ended_without_cleanup` | 6 | 6 | Oct 5 | **Fixed** 08b4ad4 (durable flag); see below |
| REACT-NATIVE-22 | ANR (fatal, AppExitInfo) | 1 | 0 | Oct 5 | **Analyzed**; recreation fix needs a device pass |
| REACT-NATIVE-1Y | `slow_phase_recorder_durable_start` | 85 | 83 | Oct 5 | **Open**: native latency, deferred by #222 |
| REACT-NATIVE-1K | `init_watchdog_fired` (regressed) | 1 | 40 | Oct 5 | **Fixed** 4f7b999 (session restore) |
| REACT-NATIVE-1W | `slow_phase_recorder_audio_prepare` | 1 | 3 | Oct 3 | Latency warning, but each event is a non-crash-safe start; see below |
| REACT-NATIVE-21 | `draft_sync_conflict` (new) | 1 | 0 | Oct 1 | **Fixed** 8addb63 (draft-create vs Submit race); see below |
| REACT-NATIVE-1T | `slow_phase_draft_presence_batch_request` | 9 | 19 | Sep 29 | Latency warning: 10.2 s vs 10 s threshold |
| REACT-NATIVE-1B | `slow_phase_fetchUser` | 1 | 87 | Sep 28 | Latency warning: 12.4 s vs 10 s |
| REACT-NATIVE-1P | `google_sign_in_failed` (iOS only) | 2 | 8 | Sep 19 | Native Google sign-in, error `-1`; the latest event is from an iPhone on an iOS 27 development build, not a clinic tablet |
| REACT-NATIVE-1S | `slow_phase_pending_draft_sync` | 2 | 8 | Sep 19 | Latency warning: 10.3 s vs 10 s |
| REACT-NATIVE-20 | `durable_recorder_op_watchdog` (op `resume`) | 0 | 1 | Sep 16 | One event ever; no evidence either way |
| REACT-NATIVE-1G | `slow_phase_record_pending_draft_scan` | 0 | 8 | Sep 14 | #222 single-flight; none since |
| REACT-NATIVE-1D | `slow_phase_local_draft_list` | 0 | 39 | Sep 14 | #222 single-flight; none since |
| REACT-NATIVE-1Z | `ApiError` on a draft-sync 409 | 0 | 1 | Sep 14 | Same race as REACT-NATIVE-21; **fixed** 8addb63 |
| REACT-NATIVE-1A | `slow_phase_registerDevice` | 0 | 17 | Sep 14 | Latency warning; none since |
| REACT-NATIVE-1J | `recording_submit_failed:{prepare,confirm}:HTTP_401` | 0 | 22 | Sep 14 | #222/#223 stale-token retry; none since |

One 1X event and one 1Y event in the 1.13.21 column come from a separate
`+83` build seen only on 2026-09-21; the rest are the clinic build `+101`.

"None since" is evidence, not proof: 1.13.21 has been in use for three weeks on
the same tablets, but 20 and 1Z each fired once in their whole history.

The three network-phase warnings still firing (1T, 1B, 1S) ran 10.2, 12.4 and
10.3 s in their latest events against 10 s thresholds. On the server, the
slowest `POST /api/device-sessions/register` requests over the same 30 days
spent nearly all their time in `requireAuth`'s Supabase `GET /auth/v1/user`
call (p99 4.3 s, max 10.5 s; see the Connect triage). That is a candidate
cause for the mobile 10 s phases, not yet matched to these events. They are
left as signals.

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

## REACT-NATIVE-21: a background draft create raced Submit

The server logged the other side of the same request (Connect NODE-1D, matched
by request id): an upload-intent conflict on `POST /api/recordings`, stage
`create`, reason `existing_recording_mismatch`. Timeline (UTC, 2026-10-01, one
clinic tablet):

| Time | Event |
|---|---|
| 21:45:48.5 | Draft saved on the device, no server draft yet (`pending_sync: true`) |
| 21:45:52.8 | Submit starts (`has_existing_draft: false`) |
| 21:45:54.4 | The background draft create is issued (`POST /api/recordings`, `isDraft: true`) |
| 21:45:55.5 | Submit's prepare-upload, issued about 0.45 s after the create, answers 200 |
| 21:45:56.6 | The draft create answers 409 after 2.2 s |
| 21:45:57.0 | `draft_sync_conflict` reported with `had_server_draft: true` |

REACT-NATIVE-1Z (Sep 14, 1.13.20) is the same race: the draft create was
issued 1.5 s after Submit started and answered 409 after 6.0 s. Connect's
NODE-1D holds the server side of both (stage `create`, reason
`existing_recording_mismatch`); its seven older events, back to July 20, have
aged out.

Both requests carry the slot's single idempotency key (`uploadKeyForSlot`).
Prepare-upload was issued second but answered first, leaving the row in
`uploading`; the draft create then found that key on a row that was not a
draft, and the server refused it. Nothing was lost: the row is Submit's.

Cause: Submit marks the slot (`markSubmitIntent`), which cancels a scheduled
draft create but not one already running. The background sync checked the
mark, read the draft from SecureStore, then created. On this tablet that read
spanned Submit's start, so the create went out 1.6 s after Submit began.

The cost went beyond a misleading warning. When the 409 arrived, Submit had
already anchored the local draft to its prepared row and cleared the draft's
dirty flag; the 409 handler then marked it dirty again, in memory and in
storage. A retry of a failed Submit would have carried a metadata update it did
not need. Sentry does not record whether this Submit succeeded.

**Fixed** (8addb63): the sync re-checks the submit and restart marks after
the read, immediately before the create; and a 409 that lands once Submit owns
the slot is recorded as the breadcrumb `sync_server_draft_conflict_submit_owned`
with no dirty mark and no warning. A 409 outside a Submit still reports
`draft_sync_conflict`. Guard: `tests/sentry-open-remediation.test.mjs`, checked
to fail under four mutations.

Unchanged: a 409 with no Submit involved leaves the draft unsynced, and the
reconnect queue keeps retrying it; which side wins such a conflict is still a
server-contract question (#223).

## REACT-NATIVE-1W: an expo-audio start 54 s after a durable one

`recorder_audio_prepare` is measured only on the expo-audio path, so each 1W
event is a recording that started without crash protection, the precondition
for the 1X data loss. The warning fires only when that prepare takes over a
second, so 1W undercounts those starts.

The 1.13.21 event, Oct 3 (UTC), one process:

| Time | Event |
|---|---|
| 13:21:36.4 | Record start (`record_floor_hydration`) |
| 13:21:38.3 | `recorder_durable_start` succeeds in 910 ms |
| 13:22:24.2 | `GET /api/patients/lookup` 200 |
| 13:22:32.1 | Next record start (`record_floor_hydration`) |
| 13:22:35.5 | `recorder_audio_prepare` 1.5 s, on expo-audio |

Any durable attempt leaves a `recorder_durable_start` phase, failed or not, and
none precedes the second start, so record.tsx never tried durable
(`freshDurable` was false). The native module and the signed-in user did not
change between the two starts. That leaves mainly two explanations: the flag
had gone off (before 08b4ad4, any response without the header turned it off),
or the slot already had audio segments (continuing a non-durable recording uses
expo-audio by design). The one response recorded in that window came from the
API, which sends the header, so the flag explanation needs a response the trail
did not record. 8addb63 adds a `record_start_expo_path` breadcrumb that
records each gate as a boolean, so the next occurrence will show which.

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

Mobile: full Node suite 1320/1320, `tsc --noEmit`, `expo lint`, R2 contract under
Node 20. Connect: `durable-capture-header.test.ts` 6/6, api typecheck,
Prettier. New tests were checked to fail under mutation. Nothing here was
validated on a device.

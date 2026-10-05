# Sentry triage — October 5, 2026

Scope: organization `vetsoap-mobile`, project `react-native`, everything that
alerted after the September 15 backlog clear (#222/#223, shipped as 1.13.21).

**Evidence source and its limits.** The Sentry connector needed re-authorization,
so the issue API, event payloads, breadcrumbs, and stack traces were NOT
available. This triage works from Sentry's own email notifications (new-issue,
regression, and high-priority alerts, plus the weekly report) and the current
repository. An issue that never triggered an alert is invisible here. The
weekly report for September 25 – October 2 counted 29 errors across 4 issues
(1 new, 3 ongoing); without the API the remaining issues cannot be named.

| Issue | Evidence | Disposition |
|---|---|---|
| REACT-NATIVE-1K (`init_watchdog_fired`, op `auth_init_get_session`) | Regression on 1.13.21 (101), October 5; 40 events lifetime (the email does not split them by release). Between 1.13.20 and 1.13.21 neither `AuthProvider.tsx` nor `supabase.ts` changed, and the supabase-js 2.115 → 2.116 bump left auth-js `_recoverAndRefresh`, `_refreshAccessToken`, and `__loadSession` byte-identical. "Regression" therefore means it was resolved without a fix, not that 1.13.21 broke it. | Root-caused and fixed in this change (below). |
| REACT-NATIVE-22 (`ApplicationNotResponding: ANR`, fatal, AppExitInfo) | New, October 5. 1.13.21+101, SM-T220 (Galaxy Tab A7 Lite), Android 14, Play-installed. The email renders zero frames ("95 additional frames"). | **Open.** Needs the main-thread stack from the event; see below. |
| REACT-NATIVE-1Z, 1J, 1D/1G, 1X | Alerted before September 15. | Fixed by #222/#223 (1.13.21). Resolve once 1.13.21 adoption is confirmed in Sentry's release view. |

## REACT-NATIVE-1K root cause

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
session", so a signed-in vet landed on the sign-in screen while GoTrue still held
a valid refresh token. Online, the vet was bounced back in when the refresh
eventually landed. Offline, the vet could not sign in, so drafts and the
recorder stayed unreachable until connectivity returned. The profile-cache
fallback in `fetchUser`, which exists precisely for the offline vet, never ran,
because it is only reached once a session exists — and it looked the user up
through the same `getSession()`.

## Fix

`src/auth/sessionRestore.ts` holds the pure decision. `AuthProvider`, on cold
start:

1. If the bounded `getSession()` neither answered (deadline or rejection) nor
   reported a session because of an `AuthRetryableFetchError`, it reads the
   persisted session directly (bounded at 4 s, so 10 + 4 stays inside the 15 s
   init watchdog) and adopts it through the existing lazy-validation path. An
   authoritative answer — no session with no error, or a non-retryable error,
   meaning GoTrue already removed a dead session — is always honored.
2. After the read it re-checks, and skips the restore if the init watchdog
   already showed the sign-in screen, any auth event other than INITIAL_SESSION
   arrived, the effect was torn down, or the auth generation moved.
3. `fetchUser`'s profile-cache fallback uses the restored user id when GoTrue
   still reports no session. The id is generation-stamped, so it never survives
   a sign-out.

GoTrue keeps refreshing in the background: TOKEN_REFRESHED replaces the token
when the network returns, and a dead refresh token surfaces as SIGNED_OUT,
which the existing handler cleans up.

**Policy consequence to confirm.** Before this change, a device that stayed
offline was effectively signed out one hour after its last online refresh.
After it, an offline device keeps its signed-in session — the vet's own drafts,
recorder, and user-scoped cached reads — until it next reaches the network,
where the server decides. That is the stated offline-first intent of the
profile-cache fallback, but it is a real change for shared clinic tablets.

**Still expected after the fix.** `init_watchdog_fired` keeps firing: it measures
a slow cold start, which this change makes recoverable rather than shorter.
Recoveries are counted by the new PostHog event `session_restored_from_storage`
(`trigger`, `access_token_expired`). Shortening the 10-second wait is a separate
tuning decision that needs the `auth_init_get_session` duration distribution.

**Validation.** `tests/auth-session-restore.test.mjs` (decision executed;
wiring and timeout budget fenced; both checked to fail under mutation), full
Node suite, `tsc --noEmit`, and `expo lint`. Not yet validated on a device: cold
start a Galaxy Tab A7 Lite in airplane mode after more than an hour idle, and
again on a throttled link, and confirm the app opens to the vet's drafts.

## REACT-NATIVE-22 (ANR) — what is known

Nothing in the notification identifies the blocked main-thread frame, so no fix
is proposed. Facts established from the code, for the investigation:

- In Expo SDK 55, every module `AsyncFunction` on the default queue — expo-secure-store
  (Keystore), expo-file-system, and both local modules — runs on ONE
  `HandlerThread` (`expo.modules.AsyncFunctionQueue`). The durable recorder's
  `start()` holds that thread through `openPipeline` (1.4–2.7 s on this tablet,
  per #222). That serializes Keystore and file work behind recorder start, which
  explains slow startup sweeps and `getSession()`, but it is not the main thread
  and so not by itself an ANR.
- The production capture path is the durable recorder (the API always sends
  `X-Durable-Capture-Enabled: true`), whose functions do not run on the main
  queue. expo-audio's recorder is the fallback only.
- Pull from the event: the main-thread stack and the breadcrumbs before exit.
  Check first for `QueuedWork.waitToFinish` (SharedPreferences writes flushed on
  pause/stop), `MediaRecorder.prepare`, ExoPlayer calls from the player or
  editor, and Fabric mount work on the record and editor screens.

# Sentry triage — September 7, 2026

Scope: rolling last 14 days (approximately August 24–September 7), organization
`vetsoap-mobile`, project `react-native`, all statuses/environments. Sentry event
aggregation returned **32 events, 8 issues, 4 distinct user identifiers**. Every
event was on `com.captivet.mobile@1.13.19+98`; 23 were warnings and 9 errors.
Distinct identifiers need not represent four different people. Counts below are
window counts, not the lifetime totals in the issue detail API.

[Open the issue search](https://vetsoap-mobile.sentry.io/issues/?project=4511258503151616&query=lastSeen%3A-14d&statsPeriod=14d).

| Issue | Events | Evidence and disposition |
|---|---:|---|
| [1B](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1B) | 10 | Slow `fetchUser`. Latest: 14.456s, successful. Breadcrumbs show a 12.408s HTTP 502, then a successful retry and 319ms device registration. Upstream availability contributed to this sample; not evidence of slow device registration. Keep warning; investigate API/proxy logs. |
| [W](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-W) | 8 | Background server-draft sync hit the 30s fetch deadline. Latest device context is offline, with earlier network loss; local draft save preceded the failure. Concrete classification gap: only `TypeError: Network request failed` was treated as expected transport failure. Fixed locally to include typed `RequestTimeoutError`. This reduces exception noise; it does not repair connectivity or prove later upload success. |
| [1T](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1T) | 5 | Latest draft-presence reconciliation succeeded in 14.058s after resume; HTTP request breadcrumb measured 9.352s. Other list requests completed after suspension. Remaining wall time is not enough evidence to assign a precise native/JS/server cause. Preserve warning and compare on the newer release. |
| [1V](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1V) | 3 | Initial list-load failures on August 27. Latest is `records` / `drafts`, HTTP 502, classified retryable. Existing retry/error UI is appropriate. Correlate API/proxy availability; do not hide the error as an empty list. |
| [1W](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1W) | 2 | Recorder preparation latency warning. Latest native prepare succeeded in 1.763s on a Galaxy Tab A7 Lite versus the 1s warning threshold. No recorder failure in this sample. Existing native parallel-preparation patch guard passes. Physical-device timing is needed before further native changes. |
| [1K](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1K) | 2 | Startup `auth_init_get_session` exceeded its 10s deadline on a low-end Samsung tablet with reachable Wi-Fi. Watchdog fired as designed; breadcrumbs do not establish whether SecureStore, GoTrue initialization, or refresh held the call. Existing bounded-storage/startup safeguards remain necessary. |
| [1S](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1S) | 1 | Pending sync succeeded in 9.688s; one attempted, one succeeded, zero failed. POST recording creation took 7.090s after resume. Long earlier GET durations span background suspension and are not reliable server-only latency measurements. Keep latency signal. |
| [1J](https://vetsoap-mobile.sentry.io/issues/REACT-NATIVE-1J) | 1 | August 31 upload confirm returned HTTP 401 on attempt 3 after a multi-day background interval. Draft presence and multiple recording-list requests also returned 401: session-wide authentication failure, not an R2 PUT failure. Durable audio and pending-confirm proof were still present at failure. Current client already refreshes/retries and routes persistent 401s through session-expiry recovery; the event does not reveal the server rejection reason or prove subsequent recovery. Needs server/auth correlation, not a speculative upload change. |

## Changes and verification

`src/lib/draftSyncErrors.ts` now classifies typed request deadlines and the existing
offline fetch error as expected transport failures. `record.tsx` uses that helper
in background draft sync, retaining the existing breadcrumb and pending local
draft behavior. Unexpected TypeErrors, untyped look-alike messages, API 401/502,
and storage failures still reach exception reporting. No retry, deletion, upload,
or authentication semantics changed.

Validation: 32 targeted tests passed across draft-sync classification, existing
Sentry remediation, account-load error classification, bounded API storage reads,
and Android recorder preparation patch guards. TypeScript passed. This is a local
change, not a deployed fix; no Sentry issues were resolved or ignored.

## Outstanding follow-up

1. Correlate confirm request ID `8cc02d8e-c2a4-41de-a3a2-1c6caf5f58b7`
   at `2026-08-31T15:07:20Z` with server authentication logs. Determine the actual
   rejection reason and whether refresh/re-registration recovered afterward.
2. Correlate startup 502 request ID `06b07eb3-7f8d-4c91-948d-7601dd51f497`
   at `2026-09-04T13:39:44Z` with proxy/API logs, alongside the August 27 list failures.
3. Validate cold-start and long-background resume on a physical Galaxy Tab A7 Lite
   using the newer app release, including expired sessions and offline draft saves.
   No events on 1.13.20 in this window is not proof of adoption or remediation.

These conclusions use Sentry issue details, latest-event breadcrumbs, event
aggregations, and current repository code. Server logs and physical-device
reproduction were not obtained in this audit. Existing unrelated working-tree
changes were preserved.

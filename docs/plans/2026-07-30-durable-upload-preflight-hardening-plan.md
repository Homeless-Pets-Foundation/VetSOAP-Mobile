# Harden Durable Upload Preparation

## Status

Proposed. This is a JavaScript/TypeScript hardening change for the 1.13.17
client. It does not change an API, database, or Expo native-module contract.

## Incident and Current Failure Path

Chico's first submission created the immutable durable upload snapshot and
showed 5%, but never contacted `prepare-upload` or R2. A Promise-returning
native filesystem metadata read never settled. Because the upload attempt was
awaiting that Promise, neither its error path nor its `finally` cleanup ran.
Restarting replaced the native bridge state; the unchanged durable original
then submitted successfully.

The current path has more than one read boundary:

1. `app/(app)/(tabs)/record.tsx` reads a durable manifest and source-file
   metadata, creates the complete-frame-prefix snapshot, and sets progress to
   5%.
2. `src/api/recordings.ts:preflightLocalFiles()` stats the snapshot again
   before the first `prepare-upload` request. This is the read that best
   matches the observed 5% stall.
3. Pending-confirm recovery probes the manifest/source before deciding whether
   a safe file-backed restart is possible. A timeout there must not be
   collapsed into “local audio missing” and accidentally select
   confirmation-only recovery.
4. The standard segmented path has equivalent upload-gating metadata reads.
   Although it was not Chico's path, the shared API boundary and the
   screen-level batch stat must use the same bounded behavior.

The synchronous `writeFilePrefix()` copy is not a Promise and cannot be
interrupted by a JavaScript Promise timeout. This plan does not claim otherwise.
The observed defect and this remediation concern Promise-returning read-only
native calls. If monitoring later identifies the synchronous prefix copy as an
app-hang source, that requires a separately designed cancellable native
snapshot API; wrapping it in `Promise.resolve()` would provide no protection.

## Required Outcomes

- While the app is active and the JavaScript event loop is running, a
  never-settling upload-preflight native read releases the UI within 10 seconds
  of the affected read batch (plus ordinary timer scheduling tolerance). This
  is not a claim that JavaScript timers run while the OS suspends the app.
- The error has stable code `NATIVE_PREFLIGHT_TIMEOUT`, phase `preflight`, and
  mode-specific fixed user-safe copy from `src/constants/strings.ts`.
- No recording preparation, confirmation, or R2 request starts after that
  attempt's timeout. A best-effort telemetry request is allowed and is not a
  recording mutation.
- A late resolve or reject is observed but cannot resume the timed-out attempt,
  mutate upload state, or start a request.
- The catch path commits a terminal error/progress state, while upload
  ownership, keep-awake ownership, split scratch, and durable snapshot scratch
  are released through guaranteed `finally` paths.
- Timeout handling does not delete or rewrite the durable original, manifest,
  draft, stash, pending-confirm proof, recovery intent, or support recovery
  vault. This does not pretend to undo a safe mutation that an earlier upload
  phase committed before a later recovery-descriptor read timed out.
- Timeout reporting is a recoverable warning, never a captured exception, and
  includes no patient/client fields, recording IDs, local paths, filenames, or
  raw native error text.
- A later process can retry the same durable recording using the same upload
  idempotency identity.
- Cold-start cleanup removes stale durable upload snapshots without deleting a
  snapshot created by the current JavaScript process.

## Design

### 1. Add a typed, shared native-preflight deadline

Add a small shared helper under `src/lib/` so both the screen orchestration and
`recordingsApi` use one definition:

- `NATIVE_PREFLIGHT_TIMEOUT_MS = 10_000`.
- `NativePreflightOperation`, the closed low-cardinality union
  `durable_manifest | source_metadata | segment_metadata | silence_metadata |
  split_input_metadata | split_output_metadata | api_metadata`.
- `NativePreflightMode = 'durable' | 'standard'`.
- `NativePreflightTimeoutError extends Error`, with:
  - `name = 'NativePreflightTimeoutError'`;
  - `code = 'NATIVE_PREFLIGHT_TIMEOUT'`;
  - `uploadPhase = 'preflight'`;
  - diagnostic fields limited to `operation`, `mode`, and `fileCount`, with
    `fileCount` clamped to an integer in `[1, 20]`.
- `isNativePreflightTimeout(error)`, based on the stable code rather than
  message matching or `instanceof` alone. It must also runtime-validate the
  closed operation/mode values and integer file count before those fields enter
  a monitoring message/tag; a server `ApiError` that happens to reuse the code
  must not inject arbitrary telemetry dimensions.

Keep this helper dependency direction `src/lib/*` → generic library/string
modules only. Give `uploadPhase` its structural literal type; do not import
`recordings.ts` or `uploadRetry.ts` back into `src/lib/`, which would create an
API/library cycle.

Add an `UPLOAD_PREFLIGHT_TIMEOUT_COPY` object to
`src/constants/strings.ts`. Durable mode uses this exact message:

> Captivet couldn't read the saved recording in time. Your audio is still
> saved. Fully close and reopen Captivet, then try again.

Standard mode must not tell the user to restart. A legacy slot can still have
audio only in the current in-memory session when its best-effort draft save
failed, and cold-start cache cleanup may remove an unowned `.m4a`. Use this
exact conservative message:

> Captivet couldn't read the recording in time. Keep Captivet open and try the
> upload again.

The error carries `mode`, and its fixed `message` is selected from this object.
Do not use `draftSlotId` alone to upgrade standard mode to the durable restart
copy; it can identify an older snapshot that does not contain the latest
segments.

Use `withPromiseTimeout()` from `src/lib/promiseTimeout.ts`; do not add another
ad-hoc `Promise.race`. Extend that helper backwards-compatibly so its timer can
reject with a supplied error factory/instance instead of forcing callers to
infer a timeout by comparing message text. Existing three-argument callers
must retain their current behavior. The void timer callback must never throw:
if a supplied factory throws, catch it and reject with a fixed fallback Error.

The native-preflight helper must accept a `() => Promise<T>` factory, not an
already-started Promise. It checks the remaining batch budget before invoking
the factory, catches a synchronous native throw without relabeling it as a
timeout, and then passes the returned Promise to `withPromiseTimeout()`. This is
what makes “expired budget does not start the next native read” enforceable.

The Promise wrapper must attach both source-settlement handlers before arming
the deadline, clear its timer on either settlement, and settle its public
Promise only once. The source operation is read-only and cannot be cancelled.
Its late settlement is deliberately ignored after the wrapper rejects, but its
late rejection remains handled so Hermes cannot see an unhandled rejection.

Do not rely on timer delivery alone. React Native may suspend JavaScript while
the app is backgrounded, then deliver a native settlement before an overdue
timer callback when the app resumes. After the source settles, the
native-preflight helper must compare `Date.now()` with the batch's absolute
deadline before returning or propagating the source result. If the wall-clock
deadline has elapsed, the typed timeout wins and no caller continuation may
start network work. Test this with an advanced clock and deliberately
undelivered timer.

### 2. Bound read batches at every upload-preflight call site

Use a 10-second deadline for each coherent read batch, not 10 seconds per file.
For a multi-file batch, compute one deadline and pass the remaining time to
each sequential stat. This keeps the maximum wait near 10 seconds rather than
up to 200 seconds for 20 segments.

Do not wrap `uploadSlot()`, `executeResilientUpload()`, a preparation request,
an R2 PUT, confirmation, or the whole transaction. A timeout around a
side-effecting outer task would allow its detached continuation to mutate the
server or race a retry.

| Call site | Deadline behavior | Timeout behavior |
|---|---|---|
| Pending-confirm durable probe in `record.tsx` | One batch across `getManifest()` and the selected source stat | Propagate the typed timeout. Do not turn it into `null`/`exists: false`, clear the hint, or choose confirmation-only recovery. |
| Pending-confirm standard probe in `record.tsx` | One batch across all segment stats | Propagate the typed timeout; ordinary missing-file results retain existing confirmation-only semantics. |
| Main durable preparation in `record.tsx` | One batch across `getManifest()` and source stat | Abort before silence/snapshot/network work. Preserve native-source rejections, tagging them `preflight` without changing them into timeout errors. |
| Main standard preparation in `record.tsx` | One batch across the initial segment stats | Abort before silence/split/network work. |
| `src/lib/oversizedSplit.ts:maybeSplitForUpload()` input stats, `src/lib/ffmpeg.ts:splitAudioBySize()` input/part stats, and `record.tsx:sumSegmentSizes()` output stats | A bounded batch for each input/output set | Preserve the existing FFmpeg execution timeout, clean split scratch, and abort before API upload. |
| `recordings.ts:preflightLocalFiles()` | One batch across all input files, both initial preparation and recovery-descriptor revalidation | Reject before the next recording request. Keep URI/type/exists/empty/250 MB validation unchanged. |

The silence-check helper performs an additional Promise-returning metadata read
before its existing FFmpeg timeout starts; bound that read too. A
`NATIVE_PREFLIGHT_TIMEOUT` must pass through the helper rather than being
collapsed into generic `ffmpeg_error`; ordinary silence-analysis failures
remain inconclusive as today.

The screen and API checks intentionally remain duplicated: the first produces
UI/oversize decisions, while the second is the final trust boundary on the
exact immutable file supplied to the uploader.

### 3. Make durable snapshot ownership process- and attempt-specific

The current deterministic
`durable-upload-${durable.recordingId}.aac` name is unsafe for deferred
cold-start cleanup and aliases retries onto the same path. Move snapshot naming
and classification into a small pure helper, independent of auth state:

- Generate one non-security launch token at module initialization using a
  no-throw JS-only source (`Date.now()`, a module counter, and `Math.random()`
  are sufficient). Do not load a native random module at module load.
- Generate a unique basename per attempt, such as
  `durable-upload-v2-${launchToken}-${counter}.aac`. Do not embed patient data,
  a local path, or a recording ID.
- Expose predicates that strictly recognize:
  - the v2 durable-upload namespace;
  - the current launch token;
  - legacy 1.13.17 `durable-upload-<recording UUID>.aac` leftovers.
- Treat every recognized legacy name and every recognized v2 name with a
  different launch token as stale. Near matches, directories, other `.aac`
  files, and current-launch names are not eligible.

Assign the returned snapshot URI to an attempt-level variable immediately
after creation succeeds. Put its deletion in the outer upload-attempt
`finally`, alongside upload-owner and keep-awake release, so any later
synchronous throw is covered. Deletion remains idempotent and may also happen
earlier when useful. Never delete `durableUri` or any manifest-owned path from
this cleanup.

Unique attempt paths are required even though late metadata reads are
read-only: they prevent a timed-out attempt, an immediate Retry, and deferred
cleanup from referring to the same pathname.

### 4. Extend cache cleanup without broadening deletion

Update the existing `cleanupAudioCache()` scan in `AuthProvider.tsx`:

- Preserve its established legacy `.m4a` cache cleanup behavior.
- For `.aac`, delete only a strict stale durable-upload basename identified by
  the helper above.
- Preserve v2 snapshots carrying the current launch token, even though startup
  cleanup is deferred by five seconds and an upload may already have started.
- Preserve every other cache entry and all document-backed originals, drafts,
  stashes, recovery intents, durable manifests, split-temp storage, and support
  vault content.

Schedule the deferred cold-start cache sweep independently at the start of the
auth initialization effect, not inside `supabase.auth.getSession().then(...)`.
Cache cleanup needs no user ID, and an auth Promise that never settles must not
prevent it from running. Use a synchronous `setTimeout` callback, retain the
timer handle, and clear it in the effect cleanup. Keep user-scoped draft/stash
maintenance where it already waits for `setUserId()`.

`cleanupAudioCache()` also runs during sign-out. The same predicate must
preserve current-process durable snapshots there; the owning upload attempt's
`finally` remains responsible for them. This change must not add any
draft/stash/recovery deletion to sign-out.

Cleanup is best-effort. A deletion failure leaves a harmless cache orphan for a
later launch and must never block auth initialization or sign-out.

### 5. Integrate UI state and telemetry explicitly

In the upload catch path:

- Recognize `NATIVE_PREFLIGHT_TIMEOUT` before generic error handling.
- Set the slot to `error`, progress `0`, and the centralized copy for the
  error's mode. The existing card then exposes `Retry Upload`. Durable copy
  directs a restart because its original is persistently owned; standard copy
  keeps the user in the current process because persistent ownership of the
  latest segments is not proven.
- Classify it as recoverable so `captureException()` is not called.
- Do not classify it as a transient network failure or auto-stash it.
- Invoke one warning capture per attempt; delivery remains rate-limited. Its
  custom timeout tags are only `operation`, `mode`, and `file_count`. Use the
  closed low-cardinality monitoring message
  `NATIVE_PREFLIGHT_TIMEOUT:<operation>:<mode>` so the existing message-keyed
  warning limiter does not collapse every operation/mode into one bucket; never
  interpolate a file count, ID, path, or raw error.
- Do not pass the timeout through the generic submit-failure payload that adds
  recording ID, duration, size, network state, submit context, or raw error
  details. Return from the dedicated branch before the ordinary
  `trackEvent({ name: 'submit_failed' })`, `reportClientError()`, and
  `captureException()` calls and before the generic `submit_failed`
  breadcrumb. Use one `captureMessage()` warning with string tags for the
  operation/mode/file count; the stable code is already the message prefix.
  Global app-version/platform monitoring tags may still apply.

The upload attempt's outer `finally` must always:

1. delete the slot from `uploadingSlotIdsRef`;
2. release its keep-awake tag with a handled Promise;
3. delete only its attempt-specific durable snapshot;
4. delete attempt-owned split scratch, if any.

Keep-awake activation is itself asynchronous and currently fire-and-forget.
Store its handled Promise. In `finally`, request deactivation immediately and
also attach a handled late-success callback that requests deactivation again.
This closes the race in which the first deactivation runs before a slow
activation settles. Do not await a possibly hung activation while releasing the
upload guard. Wrap a synchronous activation throw as best-effort failure, and
wrap each deactivation invocation in `try/catch`; keep `.catch()` on every
activation/deactivation Promise that is returned.

Do not clear a pending-confirm proof, rotate an upload key, delete a server
draft, purge native durable audio, tombstone the recording, or mark it uploaded
on this failure.

## Test Plan

### Unit and behavior tests

1. `withPromiseTimeout`:
   - existing resolve/reject behavior is unchanged;
   - a custom timeout error is returned by identity/code;
   - a throwing timeout-error factory becomes a handled fallback rejection
     rather than escaping the timer callback;
   - a never-settling source rejects at the deadline;
   - late resolve and late reject are both observed and cannot resettle the
     public Promise or produce `unhandledRejection`.

2. Shared native-preflight helper:
   - error code, phase, name, mode-selected fixed copy, operation, mode, and
     clamped file count are exact;
   - a source rejection before the deadline is preserved rather than
     mislabeled;
   - a synchronous throw from the read factory is preserved;
   - a source settling just before the deadline succeeds;
   - a multi-file batch has one 10-second budget, not `10s × fileCount`;
   - zero/expired remaining budget fails without starting the next native read;
   - a source that settles after the absolute deadline while timer delivery is
     paused still becomes `NATIVE_PREFLIGHT_TIMEOUT`;
   - the development failpoint is off by default, consumes one matching
     operation, resets with the process, and cannot arm when `__DEV__` is
     false.

3. `recordingsApi` behavior harness:
   - a hanging first metadata read rejects with
     `NATIVE_PREFLIGHT_TIMEOUT`;
   - no `prepare-upload`, recovery-inspect, confirmation, create, presign, or
     R2 PUT starts after an initial-preflight timeout;
   - if a timeout occurs while constructing descriptors after a server conflict,
     no *subsequent* recovery request starts (do not incorrectly assert that no
     earlier request occurred);
   - late source settlement starts no delayed request;
   - missing, empty, invalid-path, invalid-type, and >250 MB behavior remains
     unchanged;
   - normal durable single-file and standard multi-file uploads still execute
     prepare → ordered PUT(s) → confirm.

4. `record.tsx` orchestration:
   - pending-confirm manifest/stat timeout fails closed and leaves the proof in
     both draft and native manifest storage;
   - main durable manifest/stat timeout does not create a snapshot or contact
     the recording API;
   - standard-mode timeout uses keep-open copy and does not delete or reset its
     in-session segments;
   - silence metadata timeout propagates the typed error instead of becoming
     `ffmpeg_error`, while ordinary analysis failures remain inconclusive;
   - split input/part/output metadata timeouts abort before the recording API
     and remove attempt-owned split scratch;
   - API stat timeout after snapshot creation resets progress, releases upload
     ownership/keep-awake, and deletes that snapshot only;
   - keep-awake activation resolving after the first deactivation triggers a
     second handled deactivation and cannot leave a late-held tag;
   - Retry uses the same idempotency identity and a new snapshot URI;
   - timeout is recoverable, is not auto-stashable, and does not call
     `captureException`;
   - Submit All can continue to later slots while the failed slot stays in a
     retryable error state.

`uploadSlot` is a hook-local closure with React Native dependencies, so do not
pretend a regex-only test proves all of item 4. Extract the read-batch and
pending-confirm availability decisions into dependency-injected library
helpers and cover those with behavior tests. Keep focused source-contract tests
for the component wiring/outer-`finally` ownership, then use the device smoke
test below as the runtime evidence for state, keep-awake, and Retry behavior.

5. Snapshot lifecycle:
   - two attempts in one process produce different names;
   - current-launch v2 snapshots survive cleanup;
   - prior-launch v2 and legacy 1.13.17 snapshots are removed;
   - both deferred startup cleanup and sign-out cleanup preserve a
     current-launch snapshot;
   - a never-settling auth `getSession()` does not prevent the independent
     deferred cache sweep from running;
   - exact near-matches, unrelated `.aac`, directories, durable originals,
     drafts, stashes, recovery intent, and vault fixtures survive;
   - a deletion failure is swallowed and does not widen the deletion target.

6. Telemetry:
   - the timeout catch invokes `captureMessage()` exactly once per failed
     attempt; the monitoring rate limiter may suppress delivery and report its
     suppressed count on a later event;
   - its custom tags contain only operation/mode/file count, and its message is
     the closed code/operation/mode pattern;
   - no patient/client values, recording ID, filename, URI, or native error
     text appears;
   - `trackEvent(submit_failed)`, `reportClientError()`,
     `captureException()`, and the generic `submit_failed` breadcrumb are not
     called for this code;
   - a monitoring SDK throw is caught by the existing wrapper.

Use fake timers or short injected deadlines in automated tests; do not make the
suite wait 10 real seconds. Update the existing VM harness module maps when the
new helper/string imports are introduced.

### Static and build verification

Run:

```bash
npm test
npm run typecheck
npm run lint
npx expo-doctor
```

Then perform the project-default local release checks rather than spending an
expo.dev build merely to learn whether the code compiles:

- Android: load the current `.env`, run `npx expo prebuild --platform android`
  into an uncommitted generated project, then run
  `APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true
  ./gradlew :app:assembleRelease` from `android/`.
- iOS: use the verified Mac mini transport/toolchain workflow in
  Phase 3 of `docs/durable-recorder-build-and-device-test-plan.md`, adapting it
  to the current branch/env and not reusing that old plan's temporary feature
  overrides. Prebuild there, run `pod install`, and compile a Release
  configuration. Do not commit generated app-level `android/` or `ios/`
  directories.

### Device smoke test

Use an off-by-default, process-local preflight-read failpoint guarded by
`__DEV__` to make the next selected operation never settle. Arm it at runtime
from a development-only diagnostic action; do not use a build-time environment
flag that re-arms on every launch. The selector accepts only a member of
`NativePreflightOperation`, never a URI or patient value, consumes itself once,
and resets to off on process restart. It must be unreachable in a release
bundle. On the clinic-sized Android tablet:

1. create and finish a durable recording;
2. trigger Submit and verify the failpoint times out near 10 seconds;
3. verify the card shows the fixed message and `Retry Upload`, the overlay is
   no longer gated, and the screen may sleep after keep-awake release;
4. force-stop and reopen Captivet;
5. resume the same saved recording and submit successfully;
6. verify only one server recording exists and the durable original survived
   until confirmation.

Repeat the timeout/restart/retry smoke test on iOS hardware or, if the
development failpoint is not available in the signed hardware build, run the
same state-transition test in a development simulator build and separately
smoke a normal durable upload on hardware.

Separately exercise cold-start cleanup: hang the API metadata read after the
snapshot is created, force-stop the test app *before* the 10-second timeout,
restart, wait for the deferred startup cleanup to run, and verify the
prior-process snapshot is removed while the durable original/manifest/draft
still resume. This is distinct from the timeout-then-restart test, because a
normally handled timeout already deletes its own snapshot in `finally`. Prove
snapshot removal by inspecting the emulator/simulator app sandbox or a
`__DEV__` diagnostic that exposes counts only (never basenames or paths);
resume success alone proves preservation of the original but does not prove
cache cleanup.

Remove or disable the one-shot failpoint after the test and verify a production
bundle cannot activate it.

## Release and Rollback

- Target the next mobile release newer than 1.13.17. The code is JS-only and
  may be OTA-eligible for a matching runtime, but do not assume OTA authority or
  substitute it for the planned store release without an owner decision.
- Before any EAS store build, inspect the latest Android/iOS Expo build and
  submission versions with
  `npx --yes eas-cli@latest build:list --platform all --limit 10` and
  `npx --yes eas-cli@latest build:version:get --platform all --non-interactive`,
  choose one shared marketing version strictly above both platforms, bump
  `package.json` plus `package-lock.json`, verify `app.config.ts` resolves that
  version, and commit the marketing-version bump before starting the build.
- Keep the server unchanged. If rollout signals regress, halt the store rollout
  and ship a forward fix or a higher-version build reverting the change; do not
  assume an app store can downgrade installed clients. V2 cache snapshots left
  by a reverted build are non-authoritative, and durable originals remain
  recoverable.
- After rollout, monitor the rate of `NATIVE_PREFLIGHT_TIMEOUT` by operation,
  mode, app version, and platform. Do not add path, filename, recording, patient,
  or client dimensions.
- Success means affected users reach a recoverable error instead of remaining
  indefinitely at preparation, and restart/retry produces one confirmed server
  recording.

## Explicit Non-Goals

- No blanket upload watchdog.
- No cancellation claim for Promise-returning native reads that Expo does not
  expose as cancellable.
- No timeout around side-effecting preparation, PUT, confirmation, draft
  persistence, or the full upload transaction.
- No deletion of durable originals, manifests, drafts, stashes, recovery
  intent, pending-confirm proofs, or support vault content.
- No server/API/database schema change.
- No app-level committed `android/` or `ios/` project.
# Server and Mobile Recording Recovery Plan

## Summary

Prepare and execute a focused remediation pass across `VetSOAP-Connect` and `VetSOAP-Mobile` to fix the recording pipeline failures and the duplicate-draft mobile race, then validate the fixes on the physical Pixel device and an emulator-backed dev build.

## Implementation Changes

### 1. Server: recover stuck recordings faster and more safely

- Keep the recovery job split by pipeline phase instead of using one global timeout.
- Treat `uploading` and `uploaded` as early-pipeline states with a 5-minute stuck threshold.
- Treat `transcribing`, `transcribed`, and `generating` as active-processing states with a 20-minute stuck threshold.
- Run `recover-stuck-recordings` every 5 minutes instead of every 30 minutes.
- Preserve the current retry cap, but improve logs, analytics, and failure email text to include the actual stuck duration and threshold used.
- Leave the stale-failed recovery path in place; only tighten the early stuck detection and retry cadence.
- Deploy this change through the normal Trigger.dev manual deploy path after verification.

### 2. Server: allow manual retry of stale `uploaded` recordings

- Extend `POST /api/recordings/:id/retry` so it accepts:
  - `failed` recordings, as today.
  - `uploaded` recordings whose `updatedAt` is older than the same 5-minute early-pipeline threshold.
- Reject retries for fresh `uploaded` rows so the client cannot race normal processing.
- Keep the existing audio-file requirement and trial-cap guard.
- Use an atomic `updateMany` transition that permits:
  - `failed -> uploaded`
  - stale `uploaded -> uploaded` with cleared error fields and refreshed trigger metadata
- Clear `errorMessage`, `errorCode`, and `triggerJobId` before retriggering.
- Keep the existing template ownership validation.
- Trigger `process-recording` exactly once per accepted retry and persist the new Trigger run id back to `triggerJobId`.
- Return a clearer 400 response when the row is neither `failed` nor stale `uploaded`.
- Keep the public API shape unchanged; this is a behavior expansion, not a contract change.

### 3. Mobile: eliminate the draft autosave vs submit race

- Add a submit-intent guard in `app/(app)/(tabs)/record.tsx` using a ref-backed `Set<string>` of slot ids currently being submitted.
- Mark submit intent before `uploadSlot()` begins for both single-submit and submit-all flows.
- Clear submit intent in `finally` for both flows.
- When a stopped recording schedules deferred autosave, skip server draft sync if the slot already has submit intent.
- Preserve the local draft save even during submit intent so offline recovery still exists if upload fails.
- In `autoSaveDraft()`:
  - save the local draft first, as today;
  - stop before any server create/update when submit intent is active;
  - re-check submit intent immediately before creating a fresh server draft;
  - if a server draft is created and submit intent became active during the request, best-effort delete that server draft and do not bind it into session state.
- Change successful upload cleanup to delete the local draft by the stable slot id key, not by a potentially stale `draftSlotId` captured before autosave completed.
- Keep existing draft metadata patch-in-place behavior for normal stop/resume flows; only suppress it during active submission.
- Do not change reducer types or public API contracts unless a small type addition is required for local state hygiene.

### 4. Device and environment validation

- Validate the server changes first with targeted repo checks, then deploy:
  - API deploy to Railway.
  - jobs deploy to Trigger.dev.
- Reproduce and verify on the physical Pixel over wireless `adb`:
  - upload a new recording;
  - confirm the detail screen advances from `uploaded` into later states without manual refresh loops;
  - confirm no duplicate draft row appears in the home/not-submitted list after finish-and-submit.
- Validate the same client behavior on an emulator using a development build tied to local Metro for faster iteration.
- Use the phone for real recording and upload lifecycle checks; use the emulator for repeatable UI and state-transition regression checks.

### 5. Patch-tool handling during implementation

- Use the native `apply_patch` tool if it becomes functional again.
- If it remains broken, use narrowly scoped scripted rewrites with immediate diff verification as the fallback.
- Do not rely on a shell-level `apply_patch` wrapper as the primary mechanism unless the session explicitly permits it and the native tool remains unusable.

### 6. Infrastructure follow-up for intermittent Trigger ↔ Railway DB failures

- Treat infrastructure as a second-phase reliability project after the code fixes above ship.
- First add observability and confirm whether Prisma init failures continue after recovery and retry hardening:
  - count Trigger job failures by error class;
  - track how often rows are rescued by automatic recovery;
  - log the previous status and age for all auto-retries.
- If DB reachability failures continue, choose one of these remediation paths:
  - move background processing closer to the database, such as a Railway-hosted worker or cron process that uses the private DB hostname;
  - move the database access path to a provider/configuration that Trigger can reach reliably over public ingress;
  - split orchestration from DB mutation so Trigger schedules work but a Railway-local worker executes the Prisma-heavy pipeline.
- Default recommendation: prefer moving the processing worker closer to the DB over continuing to rely on Railway’s public Postgres proxy for clinic-critical jobs.

## Public Interfaces and Behavior Changes

- `POST /api/recordings/:id/retry` will newly support stale `uploaded` recordings in addition to `failed` recordings.
- No request-body or response-shape changes are required.
- No database schema changes are planned.
- Mobile UI copy can remain unchanged unless a clearer retry-state message is needed during QA.

## Test Plan

### Server checks

- Verify the recovery job selects:
  - `uploaded` rows older than 5 minutes;
  - `transcribing` or `generating` rows older than 20 minutes;
  - no fresh rows.
- Verify max-retry escalation still marks rows `failed` and preserves actionable messaging.
- Verify manual retry accepts:
  - a `failed` row with audio;
  - a stale `uploaded` row with audio.
- Verify manual retry rejects:
  - a fresh `uploaded` row;
  - any row without `audioFileUrl`;
  - non-retryable statuses.
- Verify Trigger run ids are updated on successful retrigger.

### Mobile checks

- Finish recording and immediately submit a single slot: no extra draft row should appear.
- Finish recording and quickly tap submit-all across multiple slots: no duplicate draft rows should appear.
- Stop recording without submitting: local draft persists and server draft sync still happens normally.
- Submit with network failure after local draft save: local draft remains resumable.
- Successful upload removes the local draft and does not leave a duplicate home-list item.

### End-to-end checks

- New uploads on the Pixel advance beyond `uploaded` without the detail screen appearing permanently stuck.
- A deliberately re-tried stale `uploaded` row completes successfully.
- Trigger production shows the updated worker version and the new recovery cadence after deploy.
- Railway API logs and Trigger run history align for the tested recording ids.

## Assumptions and Defaults

- The existing manual Trigger deploy flow remains required after jobs changes.
- The current `uploaded` stuck threshold default is 5 minutes; this same threshold will be reused for manual stale-uploaded retry eligibility.
- The duplicate draft issue is primarily client-side and does not require a server schema or draft model redesign.
- Existing unrelated dirty worktree changes in both repos will be preserved and not reverted.
- The plan document should live in the mobile repo `docs/` folder because that is where the existing implementation and audit plans already live.

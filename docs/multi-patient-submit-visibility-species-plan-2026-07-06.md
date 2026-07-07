# Full Plan: Multi-Patient Submit Visibility, Missing-Record Diagnostics, and Species Correction

## Summary

- Investigate and fix why a submitted multi-patient recording can appear missing after `Submit All`.
- Fix the AI metadata behavior so feline breed evidence can set or suggest `Feline` when species is blank or conflicting.
- Add diagnostics so future cases identify whether a slot was uploaded, deleted, draft-promoted, or hidden by sorting.
- Produce a new local Gradle APK after the fixes and validate the exact workflow on-device.

## Confirmed Findings

- Production has no recent recording named `Testgg`.
- Production does have a completed `Testbb` row from the same test window.
- Production also has a completed `Gg` row that processed around the same time as `Testbb`, but its server `createdAt` is earlier. Because the Recordings screen sorts by `createdAt`, a promoted older draft can look missing after submit.
- There was also one `recording.delete` audit entry about 3 minutes before `Testbb`, but the current audit metadata is empty, so we cannot tell whether it was user deletion, stale draft cleanup, remove-slot cleanup, or orphan cleanup.
- AI extracted `Feline` for the relevant rows, but the saved recording field already had `species = Canine`, so current backend logic preserved the filled value and dropped AI species as `already_filled`.
- The mobile submit path can currently promote an existing server draft even when local form metadata is newer than the server draft. If `draftMetadataDirty` is true and the metadata PATCH fails transiently, the app still confirms upload against the existing draft, which can submit the right audio under stale patient metadata.

## Backend/API Changes

- Add `submittedAt` to `Recording`.
- Set `submittedAt` when `POST /api/recordings/:id/confirm-upload` succeeds.
- Backfill existing non-draft recordings with `submittedAt = createdAt`.
- Expose `submittedAt` in recording list/detail responses.
- Add `submittedAt` to the recording sort whitelist and make the mobile app request `sortBy=submittedAt&sortOrder=desc` for non-draft lists.
- Keep draft lists sorted by `createdAt desc`.
- Extend `confirm-upload` to accept the latest recording metadata for draft promotion and update metadata plus upload status in one server transaction.
- Treat stale draft promotion as invalid: a recording with dirty local metadata must either confirm with that exact metadata atomically or remain unsubmitted/recoverable.

## Stale Draft Promotion Fix

- Make stale draft promotion impossible. `Submit` and `Submit All` must never complete a recording using older server draft metadata when the local slot has newer `formData`.
- Preferred implementation:
  - mobile sends the latest sanitized metadata in `confirm-upload`
  - backend validates the metadata against the same create/draft metadata rules
  - backend updates metadata, sets `submittedAt`, changes status to `uploaded`, stores audio keys, and triggers processing in one transaction
- Mobile fallback behavior if backend support is unavailable or the atomic confirm fails:
  - do not silently promote the dirty draft
  - keep the local draft/audio recoverable
  - show a retryable upload error
  - only fresh-create a replacement recording when the server draft is definitively missing
- Remove the current behavior where `patchDraftMetadataWithRetry(...)=transient_failure` still promotes the existing draft.
- Preserve duplicate prevention by using idempotency keys and the existing replaced-draft cleanup, not by accepting stale metadata.

## Delete/Audit Diagnostics

- Extend `DELETE /api/recordings/:id` to accept a PHI-free delete reason.
- Use explicit reason values such as:
  - `user_delete`
  - `discard_session`
  - `remove_slot`
  - `orphan_pending_confirm`
  - `missing_audio_rerecord`
  - `orphan_draft_cleanup`
  - `post_upload_local_cleanup`
- Store audit metadata for deletes:
  - prior status
  - had audio
  - was draft
  - replaced row status if relevant
  - delete reason
  - request id
- Update mobile cleanup paths to pass the correct delete reason instead of calling `recordingsApi.delete(id)` with no context.

## Mobile Submit Visibility Changes

- During `Submit All`, collect every successful server recording id returned by each slot upload.
- After all slots succeed, navigate to Recordings with those submitted ids in route/query state.
- On the Recordings screen, pin or highlight those just-submitted recordings at the top of the current list until the user leaves/refetches normally.
- Invalidate/refetch both regular recordings and draft recordings after submit, so stale local/server draft rows disappear promptly.
- Add a small submitted-session confirmation state showing `2 of 2 submitted` and the two resulting recording cards/ids, so staff can immediately verify both patients landed.

## Submit Telemetry Changes

- Add PHI-free submit metadata to `submit_attempted`, `submit_succeeded`, and client-error reports:
  - slot index
  - slot count
  - segment count
  - duration
  - has existing server draft
  - has pending confirm
  - draft metadata dirty
  - confirm used atomic metadata update
  - stale draft promotion blocked
  - species present/blank
  - breed present/blank
  - appointment type present/blank
  - client last name present/blank
- Do not send patient names, client names, breed strings, transcript text, or file URIs.

## Species Inference Changes

- Add deterministic backend species inference from breed for clear breeds.
- Feline examples:
  - `Domestic Shorthair`
  - `Domestic Medium Hair`
  - `Domestic Longhair`
  - `DSH`
  - `DMH`
  - `DLH`
  - `Siamese`
  - `Maine Coon`
  - `Persian`
  - `Ragdoll`
  - `Bengal`
  - `Sphynx`
- Canine examples:
  - `Labrador`
  - `Golden Retriever`
  - `German Shepherd`
  - `Beagle`
  - `Poodle`
  - `French Bulldog`
  - `Dachshund`
  - `Boxer`
  - `Chihuahua`
- Auto-apply inferred species only when saved species is blank.
- If saved species conflicts with AI/inferred species, do not overwrite automatically.
- Store a conflict reason in AI metadata, for example `conflicts_with_existing`.
- Mark the recording as needing metadata review when a conflict is detected.

## Mobile Metadata Review Changes

- Extend mobile AI metadata types to include drop reasons/conflicts.
- Keep the existing rule that normal suggestions do not overwrite nonblank staff-entered fields.
- Add a conflict-specific suggestion path that can show:
  - Current: `Canine`
  - AI suggests: `Feline`
- Tapping the suggestion opens the metadata edit sheet with the suggested species prefilled, requiring staff confirmation before save.

## Existing Test-Case Remediation

- Do not mutate production rows automatically.
- If approved later, manually correct `Testbb` species from `Canine` to `Feline`.
- If `Gg` is confirmed to be the missing `Testgg` recording, manually correct its patient/client/species metadata as needed.
- If SOAP output used the wrong species, regenerate SOAP after metadata correction.

## Test Plan

- Backend unit tests:
  - breed-to-species infers `Feline` from `Domestic Medium Hair`
  - breed-to-species infers `Feline` from `DSH/DMH/DLH`
  - breed-to-species infers `Canine` from common dog breeds
  - ambiguous breed does not infer species
  - blank species gets inferred species applied
  - filled conflicting species is preserved but marked as conflict
- Backend API tests:
  - `confirm-upload` sets `submittedAt`
  - `confirm-upload` atomically applies latest draft metadata before promotion
  - dirty draft with transient metadata-sync failure does not complete with stale metadata
  - list endpoint supports `sortBy=submittedAt`
  - draft list behavior remains unchanged
  - delete audit includes PHI-free reason/status metadata
- Mobile tests:
  - recording list requests `submittedAt desc`
  - just-submitted ids are pinned/highlighted
  - `Submit All` sends current slot metadata when promoting a server draft
  - stale dirty draft promotion is blocked or fresh-created, never completed with old patient metadata
  - regression: server draft starts as `Gg`, local slot is edited to `Testgg`, metadata PATCH fails, and submit cannot produce a completed row still named `Gg`
  - conflict species suggestions appear even when current species is nonblank
  - normal AI suggestions still avoid overwriting nonblank fields
  - submit telemetry includes only PHI-free field-presence flags
- Full validation commands:
  - Connect: `pnpm typecheck`
  - Connect: `pnpm test`
  - Mobile: `npm test`
  - Mobile: `npm run typecheck`
  - Mobile: `npx expo-doctor`

## APK Verification

- Build locally with Gradle, not expo.dev.
- Install the APK on the Android device.
- Run the exact workflow:
  - start a 2-patient appointment
  - enter only `Testgg` for patient 1
  - record, finish, resume after finish, pause/finish again if needed
  - switch to patient 2
  - enter only `Testbb`
  - record and finish
  - submit all recordings
- Verify:
  - both submitted recordings are immediately visible
  - the UI shows `2 of 2` submitted without confusing blank space
  - neither row is hidden by old draft `createdAt`
  - record list and detail show the correct server ids
  - AI fills or suggests missing metadata
  - `Domestic Medium Hair` produces `Feline` when species is blank
  - `Canine + Domestic Medium Hair` produces a visible conflict suggestion instead of silently staying wrong

### Repeatable APK Verification Helper

- Build artifact:
  - `cd android && APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease`
- Install/launch smoke with evidence capture:
  - `scripts/verify-submit-visibility-apk.sh`
- Start the local Windows/WSL emulator if needed:
  - `START_EMULATOR_AVD=dvmcalc scripts/verify-submit-visibility-apk.sh`
- Exact signed-in workflow evidence capture:
  - `MANUAL_FLOW=1 scripts/verify-submit-visibility-apk.sh`
  - The script installs the APK, launches the app, captures launch evidence, pauses for the signed-in multi-patient workflow, then verifies the final UI dump contains `2 of 2 submitted`, `Testgg`, and `Testbb`.
  - This manual mode intentionally uses the release APK and does not enable any auth bypass.

## Assumptions

- Backend changes deploy before the new APK can fully validate against production API behavior.
- Existing production rows are not changed unless explicitly approved.
- `Gg/Vv` remains unconfirmed as the possible `Testgg` row, so the implementation must solve both cases: hidden draft-promoted rows and truly missing/deleted rows.

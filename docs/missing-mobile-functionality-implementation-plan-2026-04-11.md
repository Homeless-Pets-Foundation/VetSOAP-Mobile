# Missing Mobile Functionality — Server-Grounded Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring VetSOAP-Mobile closer to feature parity with the backend and the richer Expo client already present in the Captivet monorepo, prioritizing server-supported workflows over speculative mobile-only ideas.

**Primary additions validated by the server codebase:**
- Patient directory and patient search
- Pending-metadata completion for imported recordings
- SOAP transcript review, editing, export, and regeneration
- Translation and client email draft generation
- Recording deletion and richer recording detail states
- Template browsing and template detail visibility
- Password recovery flows already proven in the Expo client

**Repos:**
- Mobile: `/home/philgood/projects/VetSOAP-Mobile`
- Server reference: `/home/philgood/projects/VetSOAP-Connect`

---

## Context

The original mobile implementation plan was based mostly on the current VetSOAP-Mobile codebase. After reviewing the server and monorepo Expo client, several features previously framed as “possible future work” are now concrete implementation targets:

- `GET /api/patients` already supports paginated patient list/search.
- `PATCH /api/soap-notes/:id` already supports section editing.
- `POST /api/soap-notes/:id/export` already supports export tracking.
- `PATCH /api/recordings/:id/complete-metadata` already supports imported recordings stuck in `pending_metadata`.
- `POST /api/recordings/:id/regenerate-soap` already supports full or per-section regeneration.
- `POST /api/recordings/:id/translate` already supports ephemeral translation.
- `POST /api/recordings/:id/email-draft` already supports client-facing email draft generation.
- `DELETE /api/recordings/:id` already exists with server-side authorization rules.
- The server repo contains working Expo reference flows for patients, records, templates, forgot password, and reset password.

This plan updates the mobile roadmap to use those existing capabilities directly, rather than inventing new APIs or leaving high-value behavior unspecified.

---

## Implementation Principles

- Prefer consuming existing server routes before proposing new backend work.
- Follow the mobile crash-prevention rules in `AGENTS.md` for every new callback, haptic call, and async UI path.
- Reuse current React Query patterns for polling, cache invalidation, refetch, and mutation status.
- Preserve PHI safety: explicit user actions only for copy/export/share, no silent background sharing.
- Treat imported-recording handling and note-finalization as higher priority than speculative offline queue work.
- Mirror server-side permissions in UI rather than letting users discover authorization failures only after tapping actions.

---

## Phase 1: Patient Directory

### Outcome

Users can directly browse and search patients from the mobile app without first navigating through a recording.

### Server truth

- `GET /api/patients` exists and supports `page`, `limit`, and `search`.
- Search already matches patient name and PIMS ID.
- Patient list responses already include `_count.recordings`.
- `GET /api/patients/:id` and `GET /api/patients/:id/recordings` already exist.
- A reference patient list implementation already exists in `VetSOAP-Connect/apps/expo/app/(app)/patients/index.tsx`.

### Tasks

- [ ] Add `patientsApi.list()` in VetSOAP-Mobile using the existing server route.
- [ ] Add `app/(app)/(tabs)/patient/index.tsx` as a patient list/search screen.
- [ ] Add one direct navigation entry point to Patients from the mobile app shell. Prefer a visible entry point over keeping patient access hidden behind recording detail.
- [ ] Reuse the existing patient detail screen rather than introducing a new patient detail model.
- [ ] Show patient name, PIMS ID, species, breed, and visit count when available.
- [ ] Add loading, empty, error, search, and pull-to-refresh states consistent with the rest of the app.

### Defaults

- Patients should be accessible directly from mobile navigation, not only through recording deep links.
- The initial patient list v1 uses search by name or PIMS ID only; no advanced filters are required.

---

## Phase 2: Imported Recordings / Pending Metadata

### Outcome

Imported recordings in `pending_metadata` become actionable on mobile instead of being passive server states.

### Server truth

- `PATCH /api/recordings/:id/complete-metadata` already exists.
- The route supports completing patient/client/species/breed/appointment/template/foreign-language fields and then transitions the recording into processing.
- A reference implementation already exists in `VetSOAP-Connect/apps/expo/app/(app)/records/[id].tsx`.

### Tasks

- [ ] Extend `recordingsApi` with `completeMetadata(id, payload)`.
- [ ] Add a `pending_metadata` recording-detail state with a metadata completion form.
- [ ] Add a recordings filter or dedicated imports entry point so users can find imported items awaiting details.
- [ ] Include patient name, client name, species, breed, appointment type, template, and foreign-language controls in the mobile form.
- [ ] On submit success, invalidate list/detail queries and return to normal processing polling.
- [ ] Show user-facing server errors clearly for invalid template, missing recording, or state conflicts.

### Defaults

- `pending_metadata` should be treated as a first-class operational workflow, not an edge-case alert.
- v1 can expose this via the recordings list filter rather than a dedicated standalone Imports tab if that is simpler.

---

## Phase 3: Record Finalization

### Outcome

Completed recordings become fully reviewable and editable on mobile, with export and regeneration paths backed by existing server APIs.

### Server truth

- `PATCH /api/soap-notes/:id` supports updating SOAP sections and additional notes.
- `POST /api/soap-notes/:id/export` supports export tracking for `clipboard`, `manual`, `pdf`, and several PIMS-oriented targets.
- `POST /api/recordings/:id/regenerate-soap` supports full or single-section regeneration.
- `GET /api/recordings/:id` already returns transcript, export metadata, cost breakdown, and status data.
- The Expo client already demonstrates transcript/section editing and copy flows.

### Tasks

- [ ] Show transcript text on recording detail when `transcriptText` exists.
- [ ] Replace read-only SOAP viewing with an editable finalization flow for supported users.
- [ ] Add section edit mode backed by `soapNotesApi.update(id, payload)`.
- [ ] Add section-level and full-note copy actions, keeping secure clipboard behavior and PHI protections.
- [ ] Add export actions backed by `soapNotesApi.export(id, { exportedTo })`.
- [ ] Surface export status in the detail UI using `isExported`, `exportedAt`, `exportedTo`, and `exportedBy`.
- [ ] Add regenerate actions:
  - full SOAP regeneration
  - single-section regeneration
- [ ] Keep polling and retry behavior intact for non-terminal recording states.

### Defaults

- Initial export targets on mobile: `clipboard` and `manual`.
- `pdf` is optional v1 only if mobile UX is straightforward; no custom PDF renderer is required for the first pass.
- Regeneration should not silently overwrite user edits without explicit confirmation.

### Permission rules

- Support staff can view and copy but cannot edit SOAP notes.
- Recording author can edit their own notes.
- Owner/admin can edit across the org where server rules permit.

---

## Phase 4: Clinical Follow-Up Tools

### Outcome

Completed SOAP notes support follow-up workflows beyond copy/export: translation and client-email draft generation.

### Server truth

- `POST /api/recordings/:id/translate` already supports ephemeral translation into supported languages.
- `POST /api/recordings/:id/email-draft` already supports AI-generated client-facing email drafts.
- Both rely on organization API-key/provider configuration already enforced by the backend.

### Tasks

- [ ] Add `recordingsApi.translate(id, { targetLanguage })`.
- [ ] Add `recordingsApi.generateEmailDraft(id, payload)`.
- [ ] Add a translation UI for completed SOAP notes that fetches translated sections on demand.
- [ ] Display translations in-app as read-only content with copy support.
- [ ] Add an email draft modal/screen that shows subject/body and supports copy.
- [ ] Surface provider/quota/API-key errors with user-readable messages.

### Defaults

- Translation results are ephemeral and not persisted in v1.
- Email draft generation is in scope; actually sending email is out of scope.
- Translation and email-draft UI belong on completed recordings only.

---

## Phase 5: Recording Lifecycle Management

### Outcome

Recordings become manageable records rather than immutable status pages with only retry.

### Server truth

- `DELETE /api/recordings/:id` already exists.
- The server already enforces delete authorization: owner/admin or recording owner.
- Recording responses already include export status and cost metadata.
- The Expo client already includes delete confirmation and richer detail states.

### Tasks

- [ ] Add a delete action on recording detail with confirmation.
- [ ] Invalidate recordings list/detail queries after delete and navigate away safely.
- [ ] Hide or disable delete for users who cannot modify the record.
- [ ] Show processing cost when `costBreakdown` is present.
- [ ] Surface quality warnings, failure reasons, and terminal statuses more prominently.
- [ ] Preserve and improve retry behavior for failed recordings.

### Defaults

- The mobile UI should follow server permissions rather than inventing separate product rules.
- Delete remains a detail-screen action in v1; bulk delete is out of scope.

---

## Phase 6: Recordings List Refinement

### Outcome

Users can find important work quickly: failed recordings, processing items, imported items awaiting metadata, and completed/exported notes.

### Server truth

- `GET /api/recordings` already supports `status`, `search`, and `userId`.
- `pending_metadata` is a supported status and should be exposed intentionally.

### Tasks

- [ ] Add status filters to the recordings list.
- [ ] Support these initial filter presets: All, Processing, Completed, Failed, Awaiting Details.
- [ ] Keep text search and status filtering composable.
- [ ] Preserve filter state while navigating into and back from recording detail.
- [ ] Ensure retry/delete/complete-metadata actions invalidate filtered lists correctly.

### Defaults

- “Awaiting Details” should map directly to `pending_metadata`.
- No advanced sorting controls are required in v1 beyond current newest-first behavior.

---

## Phase 7: Auth Recovery Flows

### Outcome

Users can request password reset and complete password recovery entirely on mobile using already-proven flow patterns.

### Server/monorepo truth

- The Expo client already has working `forgot-password` and `reset-password` screens.
- Supabase reset flow is already wired there with `captivet://reset-password` as the native redirect target.

### Tasks

- [ ] Add a `Forgot password?` action to the mobile login screen.
- [ ] Add a forgot-password screen that calls `supabase.auth.resetPasswordForEmail(...)`.
- [ ] Use `captivet://reset-password` as the native recovery redirect target.
- [ ] Add a reset-password screen gated by password-recovery session state.
- [ ] On successful reset, clear password-recovery state and return the user to login.
- [ ] Clear sensitive form state after success or route exit.

### Defaults

- Reuse the reference Expo flow semantics rather than designing a new recovery protocol.
- v1 recovery is password-reset only; invitation and magic-link flows remain out of scope.

---

## Phase 8: Template Visibility and Template Browser

### Outcome

Templates become understandable and inspectable on mobile, while avoiding unnecessary admin CRUD scope in the first pass.

### Server truth

- Template list and detail routes already exist.
- The Expo client already has template list/detail flows.
- Full template CRUD exists server-side, but that does not mean the mobile app should expose admin editing immediately.

### Tasks

- [ ] Extend `templatesApi` with `get(id)` and filtering support already exposed by the server where useful.
- [ ] Add a template browser/list screen or lightweight template picker detail view.
- [ ] Show template description, type, default status, active status, species filters, appointment-type filters, and section/output info where available.
- [ ] Improve recording-time template selection so users can understand what a chosen template will do.

### Defaults

- v1 mobile scope is browse/select/inspect, not create/edit/delete.
- Do not add per-user preferred template defaults; there is no matching backend capability to justify it.

---

## Phase 9: Connectivity-Aware Upload Recovery

### Outcome

Interrupted uploads recover more clearly under poor clinic connectivity, but only after the higher-value server-backed workflows above are in place.

### Current state

- Local stash support already exists for unfinished recording sessions.
- There is still no durable upload queue for submissions already in flight.

### Tasks

- [ ] Define a separate persisted upload queue model distinct from stashed sessions.
- [ ] Persist pending uploads so app restart does not orphan in-progress submissions.
- [ ] Add explicit retry/resume UI for pending uploads.
- [ ] Add connectivity-aware error messaging instead of generic upload failure alerts.
- [ ] Ensure queue recovery does not violate current user scoping and PHI cleanup rules.

### Defaults

- This is a later-phase reliability project, not a blocker for shipping the server-backed workflows above.
- “Saved for later” and “queued for upload” remain separate concepts.

---

## Recommended Delivery Order

1. Patient directory
2. Recordings list refinement
3. Imported recordings / pending metadata
4. Record finalization
5. Recording lifecycle management
6. Auth recovery flows
7. Template visibility / template browser
8. Clinical follow-up tools
9. Connectivity-aware upload recovery

### Rationale

- Phases 1 through 5 close the largest product gaps using server capabilities that already exist.
- Auth recovery is already solved in the reference Expo client and should be ported rather than deferred indefinitely.
- Template inspection is useful, but less urgent than imported-recording handling and note finalization.
- Translation, email drafts, and upload queue recovery are valuable, but they should follow the core patient/record workflows.

---

## Cross-Cutting Requirements

### Permission-aware UI

- [ ] Mirror server permissions in the client.
- [ ] Support staff can view/copy but cannot edit SOAP, retry processing, or delete recordings.
- [ ] Owner/admin capabilities should be surfaced where the server allows them.
- [ ] Hide unavailable destructive/edit actions when possible instead of encouraging avoidable 403 flows.

### PHI handling

- [ ] Keep copy/export explicit and user-initiated.
- [ ] Continue using safe clipboard behavior where mobile currently relies on secure clipboard semantics.
- [ ] Do not add generic share-sheet behavior by default for note content unless explicitly required.

### Query invalidation

- [ ] Recording detail mutations must invalidate the detail query and any relevant filtered recording lists.
- [ ] Patient edits must invalidate patient detail and, where relevant, patient list queries.
- [ ] Export/regenerate/edit flows must refresh SOAP note state after mutation success.

---

## Validation and QA

- [ ] Patient list search by patient name and PIMS ID.
- [ ] Patient detail navigation from both recordings and the direct patient directory.
- [ ] `pending_metadata` recording can be completed on mobile and transitions into processing.
- [ ] Support staff cannot edit SOAP, retry, or delete.
- [ ] Authorized users can edit SOAP sections and see updated content after refetch.
- [ ] Export marks the SOAP note exported and shows export destination/status on refresh.
- [ ] Full SOAP regeneration and single-section regeneration both work and refresh correctly.
- [ ] Translation handles success, unsupported language, timeout, missing key, and quota-style failures.
- [ ] Email draft generation handles success, missing API key, and provider failure states.
- [ ] Delete recording removes the item from list/detail views and respects authorization.
- [ ] Forgot-password and reset-password flows work end-to-end with deep linking on device.
- [ ] All new callbacks remain Hermes-safe: no raw async callbacks passed to void-returning props, all fire-and-forget Promises have `.catch()`, and loading state resets happen in `finally`.

---

## Explicit Assumptions

- The mobile app should consume existing backend capabilities before requesting new API work.
- Export v1 targets on mobile are `clipboard` and `manual`; `pdf` is optional but not required for initial delivery.
- Translation is read-only and non-persistent in v1.
- Client email draft generation is in scope; direct email sending is not.
- Template CRUD remains out of scope for the first mobile pass unless admin-mobile support becomes a product requirement.
- Connectivity-aware upload queueing is intentionally deprioritized behind already-supported operational workflows.

---

## Definition of Done

This plan is complete when VetSOAP-Mobile supports:
- direct patient access
- actionable imported-recording handling
- transcript review and SOAP editing/export/regeneration
- delete/retry/finalization flows aligned with server permissions
- basic password recovery
- template inspection and clearer selection
- optional follow-up tools like translation and email draft generation

At that point, the mobile app will no longer be just a recording client. It will support the broader clinical workflow that the existing backend already makes possible.

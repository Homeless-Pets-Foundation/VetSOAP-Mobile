# Attention Feed — surfacing AI-tagged metadata accuracy in the mobile app

_2026-07-29 — exploration, design, and verification audit_

> **Status: IMPLEMENTED (mobile half) — 2026-07-29.** The design below was revised after repeated
> audits against both repos and is now shipped in the app. Server-backed v1 signals use only fields
> the current recordings list can discover and destinations mobile can already render; device-local
> work is read from its existing user-scoped stores. See *Audit log* for claims removed after they
> failed current-state or history checks, and *Status* at the end for what was built and what
> remains manual verification. The server-side half (extraction tuning) is a separate, independent
> workstream and is **not** done.

---

## Context

Staff using the **record-first** flow (record without filling the patient form; the server AI
extracts patient name, client name, species, breed, appointment type from the audio) complain
the details are wrong or missing.

This is measured, not anecdotal. The 2026-06-18 audit
(`docs/record-first-ai-label-audit-and-reliability-plan-2026-06-18.md`) found:

| Metric | Value |
|---|---|
| AI review cards that auto-filled **zero** fields | **66 / 83 = 79.5%** |
| Reviews resolved as "corrected" (vs `<5%` target) | **43 / 54 = 80%** (~16× over target) |
| Avg fields corrected per corrected review | 2.84 |
| `submit_failed` (distinct upload bug) | 99; top `create_draft/HTTP_500` ×49 |

The fix affordance already exists — `MetadataReviewCard` — but is reachable **only by opening
one recording's detail screen**. A vet who records 8 appointments and walks away never learns 6
need attention. There is no aggregate surface, no badge, no unread count, and no push
notifications anywhere in the app.

**What this adds:** an in-app **Attention Feed** aggregating "this needs you" items across
recordings — led by AI-metadata accuracy — so problems are discovered without hunting record by
record. It also converts "the AI is wrong" into a specific, per-field reason.

---

## Current list contract: enough for a useful v1, not every originally proposed signal

`GET /api/recordings` (list) already returns the full `aiExtractedMetadata` blob including
per-field `dropReasons`
(`VetSOAP-Connect/apps/api/src/routes/recordings.ts:1613`, select block at `:1596-1630`;
serializer `toRecordingResponse` at `:910-958`). Workstream C7 of the old plan (per-field
drop-reason telemetry) **is already implemented server-side**
(`packages/services/src/recordings/metadata-extraction.ts:343-394`).

The list select also returns `qualityWarnings`, `errorCode`, `errorMessage`, `patientId`,
`patient.pimsPatientId`, `submittedAt`, `createdAt`, `updatedAt`, and
`soapNote { isExported, isReadyToSign, generationFallbackReason }`. The shared serializer
flattens the SOAP fields onto each response.

Two fields the first design assumed are **not** in the list response:

- `processingStartedAt` exists on the database row and the broad mobile `Recording` interface,
  but the list's explicit Prisma `select` omits it. The v1 stuck predicate therefore uses the
  server's status-aware `updatedAt` thresholds, not `processingStartedAt`.
- `reviewStatus` is not a Recording column or API response field in Connect. Connect also has no
  `PATCH /api/recordings/:id/review` route and ignores the mobile-only `reviewStatus` list query
  parameter. Consequently the current mobile `Needs Review` filter, `ReviewStatusChip`, and
  `recordingsApi.updateReview()` are contract drift, not an existing clinical-review workflow.
  The attention feed must not depend on them.

**→ The corrected v1 below is client-buildable from the existing list endpoint.** Human-review
and unresolved-reconciliation items remain deferred until they have a real list contract and a
working mobile resolution path.

### Reason vocabulary the server emits today

`AI_METADATA_DROP_REASONS` (`packages/core/src/schemas/recording.schema.ts:62-70`):
`null_extraction` · `already_filled` · `conflicts_with_existing` · `low_confidence` ·
`not_verbatim` · `multi_patient`.

**The drop-reason payload is `.strict()` and carries only `{ field, reason, score? }`**
(`recording.schema.ts:71-78`) — deliberately PHI-free, no values. Two consequences the design
must respect:

- **Suggested/current values come from elsewhere**, not the drop reason: the suggested value is
  `aiExtractedMetadata.fields[field].value` when it is a non-empty string and the current value is
  the field on the `Recording` row. The server schema permits a nullable extracted value.
  `computeSuggestionFields()` in `src/lib/recordFirstObservability.ts:206` resolves the current
  server shape safely, but its legacy fallback currently reads `suggestedValue`/`value` from a
  drop-reason object. Remove that fallback: the canonical drop parser discards such unknown
  PHI-bearing keys. A historical object without `fields[field].value` may retain a generic reason,
  but it cannot fabricate specific “Captivet heard …” copy.
- **The server never populates `aiExtractedMetadata.conflicts[]`.** The mobile
  `AiMetadataConflict` type (`src/types/index.ts:116-125`) exists and is parsed defensively, but
  no Connect code path writes it. Treat it as forward-compat only; drive conflict UI from
  `dropReasons`.

The current mobile type is looser and partly stale: `AiExtractedMetadataField.value` is typed as
non-null, while the server permits `null`, and `AiMetadataDropReason` omits the server's optional
`score`. Align those types as part of the feed work while retaining defensive parsing for
historical/legacy shapes.

### `conflicts_with_existing` only fires for `species`

`metadata-extraction.ts:363-378`: when a field already has a value, the server emits
`conflicts_with_existing` **only** for `species` (and only when the normalized values differ).
Every other field with an existing value gets `already_filled`, whatever the AI heard.

So a "record says 'Bela', AI heard 'Bella'" prompt for **patientName is not buildable today**.
Do not write that copy. Conflict rows in v1 are species-only. Broadening this is a Connect
change, listed under *The server-side half*.

### Confidence gates

Still at defaults — `patientName`/`clientName` **0.85**, `species`/`breed`/`appointmentType`
**0.70** (`metadata-extraction.ts:51-57`), overridable per-field by env (`AI_METADATA_CONF_*`)
with no deploy. The comment there records that C8 tuning was deliberately deferred pending C7
data — that data now exists.

### Also confirmed

- There is **no** Appointment/Schedule model and **no** PIMS appointment import in Connect
  (`packages/database/prisma/schema.prisma`). "Reason for the appointment" is the 4-value
  `appointmentType` enum, AI-extracted like the rest.
- Patient-record linking is via vet-entered `pimsPatientId`, **not** AI matching — so "AI-first
  patient tagging" means exactly the 5 metadata fields, nothing more.
- `qualityWarnings[]` arrives as complete human sentences, renderable as-is
  (`apps/jobs/src/jobs/process-recording.ts:965, 985`).

---

## Decisions (confirmed 2026-07-29)

1. **Scope of v1 — the currently actionable Tier 1 + Tier 2 set.** AI-metadata items plus failed,
   retry-scheduled, status-aware stuck, recent quality-warning, and un-sent-local-work signals.
   Unexported and human-review/reconciliation signals were removed from v1 after the contract
   audit below; they are explicitly gated in *Deferred* rather than silently dropped.
2. **Audience — practice-wide for every role.** Verified feasible with no server change: the
   list `where` clause is org-scoped, not user-scoped
   (`recordings.ts:1480-1493` — `{ organizationId, replacedAt: null }`; `userId` is an
   *optional query filter*, not an enforced scope). Every role already receives the whole org's
   recordings.
3. **Sequencing — the two workstreams are independent.** Land the mobile feed without waiting on
   extraction tuning. Start tuning from a PHI-free aggregate query of production drop reasons;
   feed impressions are not a substitute for that distribution and tuning need not wait for the
   mobile release.
4. **One row per server recording, without losing reasons.** A server row carries every matching
   reason, picks one deterministic primary reason for rank/copy, and shows `+N more issues` when
   applicable. Dedupe must never discard secondary matches. A whole metadata
   confirm/dismiss resolves all AI reasons only after the source UI shows that complete set;
   resolving one category may leave another category (for example quality) as the next primary.
   The two device-local rows are source-level summaries, not recording rows, and are accounted for
   separately below.
5. **No feed-local dismissal state in v1.** Source-backed items clear only when their source state
   changes. Metadata may use Connect's existing whole-review `confirmed|dismissed` states;
   non-resolvable quality warnings age out after seven days. This avoids a new user-scoped,
   bounded persistence system merely to dismiss feed rows.

### Consequence of the practice-wide decision: actionability is per item kind

Vets can **read** every org recording but can only **edit** their own — the server enforces
creator-or-owner/admin on both metadata mutation routes
(`recordings.ts:5125` and `:5291`, 403 `Not authorized to update this recording`), which
`getRecordingPermissions()` (`src/lib/recordingPermissions.ts:50`) already mirrors client-side.

That rule applies to metadata, but it is not the authorization rule for every signal. In
particular, `POST /api/recordings/:id/retry` is organization-scoped and permits any owner, admin,
or veterinarian; it does **not** require authorship. `getRecordingPermissions().canRetry`
currently understates that server permission for a veterinarian viewing a colleague's recording,
so the feed must not use `canEdit` as a universal actionability test.

The feed renders **two groups**, in this order:

- **"Needs you"** — metadata/quality items the user may edit or inspect as creator/owner/admin;
  failed/retry/stuck items for any owner/admin/veterinarian; and this user's local unsent work.
  A CTA opens the existing source UI.
- **"Across the practice"** — metadata/quality rows the current role cannot act on and processing
  rows for support staff. Read-only rows have no fix CTA; tapping may open the detail screen for
  context. This group is collapsed by default so it never buries actionable work.

Never render a fix CTA when the user lacks that item kind's permission. A metadata save would
403, and a support-staff retry would fail the server's role guard. The detail screen already
gates its edit cards on `recordingPermissions.canEdit`
(`app/(app)/(tabs)/recordings/[id].tsx:755-771`), so the read-only path works today.

Local work is the deliberate exception to “actionable means this role can submit”: support staff
may still own user-scoped bytes from before a role change/recovery. Keep that data-loss warning in
Needs you, but label its CTA **View saved work** or **Recovery help**, never Resume/Submit. The
existing Record role gate explains that the same account must be promoted or an authorized
owner/admin/veterinarian must recover the work; the feed must not imply support staff can bypass
that gate.

For retry items, use `canRecordAppointments(user.role)` (owner/admin/veterinarian), not
`recordingPermissions.canRetry`. As adjacent contract cleanup, gate the existing detail-screen
**processing** Retry controls the same way so support staff do not see an action the server
rejects, while a veterinarian may retry a colleague's row as the server allows. Do not apply that
role gate to harmless “Retry loading”/refetch controls.

Because the list omits `audioFileUrl`, processing actionability is provisional until detail loads.
If audio exists, any owner/admin/veterinarian may retry. If audio is unavailable, starting a new
visit does **not** resolve the old row. Expose a confirmed **Delete unavailable recording** source
action for `recordingPermissions.canDelete` (author or owner/admin) only after the local-anchor
check below—including orphan durable manifests and the existing authorized support-recovery
vault—not merely the draft/stash indexes. Reuse the existing delete API/cache purge; otherwise
show read-only coordination guidance. Never broaden server deletion authorization or pretend a
veterinarian may delete a colleague's row merely because they could have retried it.

Note: the list endpoint defaults to `status: { not: 'draft' }` unless a status is passed
(`recordings.ts:1485-1489`) — drafts are fetched separately, as Home already does.

---

## Recommendation: where the feed lives

**Home tab — a first-class "Needs Attention" section directly under the existing banner stack —
plus a dedicated `/(app)/attention` screen for the full bounded result.**

**Not a 5th tab.** `app/(app)/(tabs)/_layout.tsx:64-68` carries an explicit comment that the
11px tab-label size was chosen because "four labels must fit". A fifth label degrades the tab
bar for every user to serve an intermittent state.

Why Home:

- Home is already the app's signals surface — priority banner stack
  (`app/(app)/(tabs)/index.tsx:61-72` for the keys, `:316-351` for the render + `+N more alert`
  expander), quality-analytics card, stats row.
- The vet workflow is record → walk away → open the app later. Home is the landing screen; the
  feed must be there or it is not discovered.
- The Recordings tab has a `needs_review` filter chip (`recordings/index.tsx:47, 104-107`), but
  the contract audit proved it cannot currently return results. The new explicit Attention link
  supplies a truthful browsing surface while the feed supplies discovery.

Placement within Home, top to bottom:

```
Header (wordmark + settings)
Banner stack            ← existing: recovery / device limit / provider issue
▶ NEEDS ATTENTION       ← NEW: top 3 actionable rows; qualified counts inside
Record CTA (hero)
Recent patient summary
Stats row
Not Submitted
Recent Recordings
```

Rationale: above the Record CTA because fixing yesterday's bad data should be seen before
starting today's recording; below the banner stack because those banners are about the app being
broken (data loss, device blocked), which outranks data hygiene.

Secondary entry point: the Recordings `needs_review` filter must **not** stay as-is. It is
currently non-functional because the server neither accepts `reviewStatus` nor returns a
recording review state. Remove the dead option and its unsupported API parameter as contract
cleanup, then add an explicit **Needs Attention** link in the Recordings header that opens
`/(app)/attention`. This is a navigation entry, not a status filter: the feed combines status,
metadata, quality, and device-local signals.

The Home section shows at most three **Needs you** rows. If there are only read-only practice
items, it shows a collapsed `N across the practice` summary rather than expanding patient rows on
the landing screen. The full screen shows the two actionability groups, then sorts within each
group by the deterministic priority below. The section title itself is simply **Needs Attention**:
do not mix device-local rows and a truncated server page into one authoritative parenthetical
count. Group labels report the number of rows actually loaded, and a separate footer supplies the
server-page qualifier.

---

## What the feed shows (exact v1 predicates)

All server-backed v1 predicates are derivable from the existing `recordingsApi.list()` response.
Every date predicate uses a parsed valid date; an absent/invalid timestamp suppresses the
time-based signal rather than guessing and marks derivation partial when that row actually needs
the clock to evaluate a supported predicate.

### Tier 1 — AI metadata accuracy (the reported complaint)

| Item | Trigger | What the user sees |
|---|---|---|
| **Multiple patients detected** | completed + unresolved AI review + `multiplePatientsDetected === true` or a `multi_patient` drop | "Multiple patients were discussed — review each detail before saving." |
| **Species conflict** | completed + unresolved AI review + a normalized `conflicts_with_existing` drop/conflict for species (species only today) | With both values: "Record says 'Canine'; Captivet heard 'Feline' — review the species." Otherwise: "Captivet found a different species — review it." |
| **Confirm AI details** | completed + review not confirmed/dismissed + at least one valid/nonblank applied field; also the fail-safe fallback for an explicit `review:'unconfirmed'` object that has no other recoverable metadata reason | With a valid count: "Captivet filled 4 details for Bella — confirm they're right." Fallback: "Captivet marked these details for review — check them." |
| **Details missing** | completed + unresolved AI review + blank `patientName` + zero valid/nonblank applied fields + no suggestions (`shouldShowNoExtractionEmptyState()`, hardened to the same normalized applied-field helper) | "Captivet couldn't read the patient details — add them." |
| **Low-confidence suggestion** | completed + unresolved AI review + a normalized per-field `low_confidence` drop; a value-bearing suggestion is optional | With a value: "Wasn't sure about Breed — review 'Golden Retriever'." Without one: "Captivet was unsure about Breed — review it." |
| **Name not confirmable** | completed + unresolved AI review + a normalized `patientName` `not_verbatim` drop; a value-bearing suggestion is optional | "Heard a patient name but couldn't confirm it in the audio." |
| **AI suggestion (reason unavailable)** | completed + review not confirmed/dismissed + at least one suggestion with no known per-field drop/conflict reason and no global multi-patient explanation | "Captivet suggested Breed 'Golden Retriever' — review it." |

`already_filled` is **never** shown — it means the vet typed it, which is the desired state.
Likewise, `null_extraction` does not produce five noisy field rows; it contributes only to the
single **Details missing** state when the patient name remains blank and there is no suggestion.
Copy uses `displayPatientName()` and falls back to `Untitled Visit`; it never interpolates a
missing or non-string extracted value.

This mapping is the core of the feature: it replaces "the AI is wrong" with a specific,
per-field, tappable reason whenever current telemetry permits. The explicitly generic fallback is
required for pre-C7/partial blobs: it makes the suggestion discoverable without fabricating why
the server did not apply it. Conversely, a known normalized reason remains discoverable even when
its extracted value is absent/null; the row uses its generic copy and never fabricates a value.

#### Load-bearing lifecycle: discover review=`none`, but suppress reviewed metadata

`review` is set to `'unconfirmed'` only when `appliedFields.length > 0 || multiplePatientsDetected
|| hasConflict` (`metadata-extraction.ts:409-427`). A recording where the AI extracted values but
**every field was demoted by `low_confidence` or `not_verbatim`** gets `review: 'none'` →
`needsMetadataReview === false` → **no review card, no flag, no signal anywhere**.

That is precisely the "AI did nothing and nobody knows" cohort. The feed must evaluate
`dropReasons` and `computeSuggestionFields()` directly, independently of the review flag. Getting
this wrong reproduces the exact blindness the feed exists to fix.

Current organization capability is not a historical-origin flag. If `aiExtractedMetadata` is a
real object, evaluate and allow review of it even when today's user capabilities no longer include
`record_first`; disabling future record-first capture must not orphan old AI review work. Use
`recordFirstEnabled` only to infer the ambiguous `aiExtractedMetadata === null` no-extraction
cohort, because the current list has no durable “this recording originated record-first” field.
Thus capability-off suppresses null-blob `metadata_missing`, but not explicit unresolved AI
metadata.

However, the server intentionally preserves `dropReasons` after a metadata save and changes only
`aiExtractedMetadata.review` to `confirmed`/`dismissed`
(`recordings.ts:5356-5363`). Therefore the complete rule is:

1. `review === 'confirmed' || review === 'dismissed'` → no AI-metadata attention item, even though
   historical drop reasons remain.
2. Every other/absent review state is unresolved for intrinsic signals: evaluate valid applied
   fields, multi-patient, conflicts, low-confidence/not-verbatim suggestions, and the
   no-extraction empty state. With today's valid server schema, `review:'none'` naturally has no
   applied/multi/conflict signal; this broader rule is fail-safe for historical/inconsistent
   blobs rather than silently hiding them.
   An explicit `review:'unconfirmed'` must never disappear solely because every detailed legacy
   field failed normalization: when no other metadata reason survives, emit the generic
   `metadata_confirm` fallback without inventing a field, value, or cause.
3. `aiExtractedMetadata === null` + current record-first capability → the inferred no-extraction
   item clears when patient metadata is added; the server cannot attach a review state to a null
   blob. Without the capability, origin is unknowable and this one predicate is suppressed.

Without the first rule, every low-confidence/conflict row becomes immortal after the user fixes it.

### Tier 2 — other pertinent signals (same list response)

| Item | Trigger | Why it matters |
|---|---|---|
| **Recording failed** | `status === 'failed'` | Silent loss of a visit; show safe generic copy, never raw `errorMessage` |
| **Retry scheduled** | `status === 'retry_scheduled'` | Processing is delayed; the detail response determines whether audio is still available for a manual retry |
| **Upload/processing stuck** | valid `updatedAt`; `uploaded` ≥5 min, `uploading` ≥35 min, or `transcribing`/`transcribed`/`generating` ≥20 min | Mirrors Connect's status-aware windows without guessing from a missing list field |
| **Recent audio quality warning** | completed + non-empty `qualityWarnings` + valid, non-future `submittedAt` with age in `[0, 7 days]` | The server sentences are user-ready; first warning + `+N more warnings`, capped in the row |
| **Un-sent work on this device** | user-scoped local draft/stash summary | Catches work with no server row, including `create_draft` failure |

**"Un-sent work on this device" is the only feed source capable of catching the `create_draft`
HTTP_500 cohort when a recoverable local draft/stash was successfully persisted** (49 events in
the audit window). Those attempts never created a server row, so the server page is structurally
blind to them; if local persistence also failed, no feed can reconstruct missing bytes. Home's
existing local `Not Submitted` section also covers drafts; the attention item adds aggregate
discovery and stashes rather than claiming to be the app's only existing surface.

For `uploading`, the list cannot distinguish a committed audio reference (server-retryable after
5 minutes) from a prepared upload with no audio yet (35-minute signed-upload window + grace).
Use the conservative **35-minute** threshold for every list-shaped `uploading` row. This avoids
flagging a legitimate large upload while still surfacing an abandoned prepared upload; once the
detail response loads `audioFileUrl`, the existing UI can choose Retry vs Audio unavailable.
The 5/20/35-minute constants mirror `packages/core/src/logic/recording-retry.ts`; name them in one
mobile helper, use the exact helper in detail where `audioFileUrl` is known, and test their
boundary values so drift is visible. Replace detail's current “30 minutes since this screen began
polling” stale presentation with row-age eligibility, or a feed tap would wait another 30 minutes
before revealing the action.

Never render `recording.errorMessage` in a feed row. Jobs persist truncated exception messages,
which can be technical or PHI-adjacent; the detail screen intentionally keeps them behind
`Copy details`. Use generic failure copy. The attention reason sent to analytics is the bounded
`recording_failed` code, not the raw server `errorCode`. If a future event needs failure subtype,
map `errorCode` through the current Connect enum and collapse every unknown/legacy value to
`unknown` before emission.

### Existing org-level surfaces stay separate in v1

- `missingMetadataRate` is already rendered by `QualityAnalyticsCard`; duplicating it in a
  per-recording feed adds no action.
- Provider issues are already part of Home's higher-priority banner stack and can be acknowledged
  server-side. They remain there; folding them into the lower-priority feed would contradict the
  placement decision and duplicate the same incident.
- Orphan durable-recorder offers already use Home's higher-priority recovery banner.
  Support-staff recovery-vault items currently appear only in Settings and
  `/(app)/recording-recovery`; that is too hidden for preserved clinical work. As adjacent recovery
  discovery, add their bounded strict count to the same higher-priority banner stack with an
  **Open recovery** CTA. Keep both sources out of feed counts so recovery is not duplicated below
  the banner. Both still participate in the destructive detail-screen anchor check below.

### Deferred until the discovery contract and mobile action both work

- **Note not marked as filed in PIMS.** The list does return flattened `isExported`, but the
  current mobile `ExportSheet` posts a PIMS destination without the short-lived extension import
  authorization Connect now requires, so each target returns
  `409 IMPORT_AUTHORIZATION_REQUIRED`. Copy/share also do not set `isExported`. Do not create an
  immortal feed item that leads to a broken resolution path. First choose and ship a supported
  mobile action (for example, a single explicit manual-filed action using `exportedTo: 'manual'`);
  then gate the signal on completed + `soapNoteId` + review-ready + a specified valid age.
- **Human review pending.** The mobile `ReviewStatus` types/UI/API calls have no Connect recording
  field or route. This plan removes the dead mobile controls; reintroduce the concept only after a
  real server contract exists.
- **Imported recording awaiting details (`pending_metadata`).** The list can discover this status,
  but the current detail screen only displays an “Awaiting Details” card; it does not call
  Connect's `PATCH /api/recordings/:id/complete-metadata` workflow. Add the actual completion form
  and role/credential handling before calling the row actionable.
- `SoapNoteReconciliationIssue` — `GET /api/soap-notes/:id/reconciliation-issues`
  (`VetSOAP-Connect/apps/api/src/routes/soap-notes.ts:116`) with a `/resolve` action at `:150`;
  severity + section + message + hint fields. The list's `soapNoteIsReadyToSign` boolean can say
  something is blocked but cannot explain the issue, and mobile currently has no resolution UI.
  Add a batch/list contract and that UI before feeding it.
- `UnmatchedDiagnosticQueue` — AI mentioned a diagnostic it couldn't code; no mobile route yet.
- `RecordingTask` (`suggested` billing/todo) — Connect already has an org-wide paginated
  `GET /api/tasks` with linked-recording context, and mobile already resolves tasks on recording
  detail. It is deliberately deferred from this metadata-led v1 because it needs a second
  independently paginated mobile query/client and product decisions about whether accepted as
  well as suggested tasks belong in this feed; it does **not** need a new server list endpoint.
- `soapNoteGenerationFallbackReason` — returned by the list endpoint today but absent from the
  mobile `Recording` type; define user-safe reason mapping and an action before surfacing it.

Reconciliation and unmatched-diagnostic cases need an aggregate discovery contract plus mobile
resolution UI. Tasks have discovery but need a mobile aggregate client and explicit scope.
Unexported, imported-awaiting-details, and generic human review need a supported mobile resolution
path (and human review also needs a real server state). None should enter merely because a partial
boolean, status, or stale mobile type exists.

---

## Implementation shape

### New files

- `src/lib/attentionFeed.ts` — **pure**, unit-testable.
  `deriveRecordingAttention(recordings, user, { nowMs, recordFirstEnabled }) →
  { items, classificationComplete, uncheckableTimingRowCount }`, exact predicates, per-kind
  actionability, deterministic ranking, the `dropReason → copy` mapping, and explicit proof of
  whether every time-dependent supported predicate could be evaluated. Its input is a narrow
  `AttentionRecording` structural type
  containing only fields actually selected by the list route; it must not accept the broad detail
  `Recording` type as permission to read omitted fields. A `FeedItem` keeps `primaryReason` plus all
  `reasons[]`; it does not throw secondary matches away. No React, fetch, timers, or ambient
  `Date.now()`. Export a defensive `projectAttentionRecording(raw)` used at both network and
  cache-mutation boundaries so excluded detail/raw-failure fields cannot drift back in.
- `src/hooks/useAttentionFeed.ts` — composes one bounded React Query server page with a
  user-scoped local-work query. It exposes server error/stale/truncation state separately from
  items so a failed request is never rendered as a falsely clean feed.
- `src/components/AttentionFeedSection.tsx` — Home section: top 3 `ListItem`s plus a qualified
  **View recent attention** link when more rows exist.
- `app/(app)/attention.tsx` — full bounded `SectionList`, grouped by actionability and sorted by
  priority, with pull-to-refresh. “Across the practice” starts collapsed and exposes
  `accessibilityState.expanded`; expanding it must not alter “Needs you” order.

### Normalized data model (prevents payload and privacy drift)

`AttentionRecording` should be a `Pick`/structural interface over only:

`id`, `userId`, `status`, `patientName`, `clientName`, `species`, `breed`, `appointmentType`,
`qualityWarnings`, `aiExtractedMetadata`, `submittedAt`, and `updatedAt`.

Notably it excludes `audioFileUrl`, `processingStartedAt`, `reviewStatus`, `errorCode`, and
`errorMessage`; it also excludes the redundant synthetic `needsMetadataReview` flag so the
builder cannot regress to that incomplete gate. Tests construct this exact list-shaped input. A
full `Recording` remains structurally assignable, but the pure code cannot accidentally depend on
detail-only/raw-failure fields.

`FeedItem` is a sanitized view model, not a wrapper around the API row. It carries only its stable
key/recording id, on-device display label/copy, timestamps needed for display, broad category,
primary reason, normalized reasons, focus destination, and actionability. It must not retain the
raw recording, `errorMessage`, whole `aiExtractedMetadata`, or whole `qualityWarnings` array. Event
props are built explicitly from bounded enums/counts — never by spreading a `FeedItem`.
Server-row keys are `recording:${id}` and synthetic keys are fixed per user/source; never use an
array index, display text, or an extracted value as identity.

`classificationComplete=false` when a row has a supported time-dependent predicate but its clock
input cannot be evaluated: a potentially stuck processing status with invalid/future `updatedAt`,
or a completed row with quality warnings and invalid/future `submittedAt`. The row does not become
a guessed stuck/quality item, but the screen also cannot claim a clean check.
`uncheckableTimingRowCount` is the bounded count of those rows (never their ids or contents). An invalid
timestamp on a failed/retry row does not make its already-deterministic status signal incomplete;
an invalid `submittedAt` on a completed row with no quality warning affects only tie display and
does not block unrelated metadata classification.

Reason normalization rules:

- `parseMetadataDropReasons()` emits only known field + known reason + an optional finite score in
  `[0,1]`; it drops every unknown key/value from current array and legacy record shapes. Raw legacy
  objects may contain values and therefore never cross the analytics boundary. Cap traversal at a
  small documented multiple of the five possible fields and cap the normalized/deduplicated
  output to the finite `(field, reason)` vocabulary, so a corrupt historical blob cannot create
  an unbounded render/event array.
- Dedupe by `(reason, field)` and order fields by `METADATA_FIELDS`, not object/input order.
  Sort the final `reasons[]` by the global reason priority below and then field order, so primary
  selection, detail rows, and analytics are independent of payload order.
  `multiple_patients`, `metadata_confirm`, `metadata_missing`, and `quality_warning` are each one
  logical reason; low-confidence/not-verbatim/unclassified-suggestion reasons may occur once per
  field. Add the unclassified reason only for a computed suggestion with no normalized per-field
  drop/conflict reason and no global multi-patient state—never in addition to `already_filled`,
  `null_extraction`, or another known explanation.
- A quality reason stores one row-safe first warning capped at 240 characters plus
  `warningCount`; trim/collapse control and newline whitespace before the cap, and apply
  `numberOfLines={2}`. Additional warnings are rendered as `+N more warnings`; they are not
  inflated into `reasons[]`. Separately, `+N more issues` means `reasons.length - 1`. Full warning
  text remains available only on detail.
- A “filled details” count includes unique known `appliedFields` whose corresponding current row
  value is a non-empty string. Unknown, duplicate, or blank applied fields do not inflate copy.
- Normalize any on-device current/suggested value through the field's server length bound
  (`species` 50, the other four 100), trim it, and collapse control/newline whitespace before
  composing row/accessibility copy. A legacy overlong value is safely truncated for this summary
  (the full source remains on detail); `numberOfLines` still bounds layout. Never interpolate raw
  legacy strings directly.

### Existing files that must change

- `src/lib/recordFirstObservability.ts` — export one canonical, defensive
  `parseMetadataDropReasons()` helper (array plus legacy record form) and an
  `hasUnresolvedAiMetadataAttention()` helper. Narrow the metadata helper input signatures to the
  list/detail fields they actually read. Reuse the same normalized classification in the detail
  card, its `ai_metadata_review_shown` effect, and the feed; do not maintain two parsers or two
  resolution predicates. Use the normalized applied/drop lists in
  `buildExtractionObservedProps()` as well so legacy record-form counts and invalid fields do not
  drift from the UI. Remove the existing drop-object value fallback and rewrite its
  object/drop-only suggestion test; only `fields` (or the separately typed forward-compatible
  `conflicts[]` payload) may provide on-device values.
- `src/types/index.ts` — align nullable extracted values and the closed drop-reason score/reason
  types; remove the stale PHI-bearing `currentValue`/`suggestedValue`/`value` members from
  `AiMetadataDropReason`. Keep the separately typed `AiMetadataConflict` forward-compat shape.
- `app/(app)/(tabs)/recordings/[id].tsx` — use the unresolved-attention helper so a
  `review: 'none'` low-confidence/not-verbatim item opens `MetadataReviewCard` in **review**
  mode instead of the current generic edit mode. Preserve `canEdit`; retain the record-first gate
  for ambiguous null-metadata add/empty states, but do not hide a real unresolved
  `aiExtractedMetadata` object merely because the capability was later disabled. This exception
  is for the unresolved review path; ordinary post-review edit/add visibility otherwise stays
  unchanged in this feature.
  Accept validated `from=attention&focus=metadata|processing|quality`, scroll to the existing
  source card after layout, and fall back to `/attention` on Back when there is no history. Use
  status-aware row age for stale processing so the source state is present immediately. Refactor
  the draft-only delete confirmation/copy into status-aware deletion and offer
  **Delete unavailable recording** only when retry presentation is `audio_unavailable`,
  `recordingPermissions.canDelete`, and a bounded strict current-user lookup found no local
  draft/stash slot or orphan durable manifest anchored to this server id **for the signed-in
  account on this device**, and no authorized same-organization support-recovery-vault item
  matches. That result is not proof that no recoverable copy exists on another device/account. If
  a matching local anchor exists, prefer **Resume saved recording/session** or **Open recovery**
  and route to its actual surface. If any required local lookup fails/times out, fail closed: show
  retry/guidance and no destructive button. On confirmed delete success, purge the recording
  detail, every recording list (including attention), its persisted SOAP-note/task queries, and
  every cached visit-page variant for its linked patient before navigation; invalidate the
  affected patient/list/dashboard summaries. Removing the affected visit-query prefix is safer
  than filtering one row while leaving stale pagination totals. The destructive confirmation
  always says the server recording and any existing SOAP note/tasks will be permanently deleted
  and that deleting the row can disrupt recovery from another device; for an owner/admin deleting
  a colleague's row it also says that the colleague's account-local work is outside the check.
  Never read another user's scoped store.
- `src/components/MetadataReviewCard.tsx` — make whole-review semantics explicit. Show every
  normalized applied/conflict/suggestion reason in deterministic field order before completion,
  including generic reason-only rows when an extracted value is unavailable. Keep all remaining
  suggestions visible in the edit sheet, and label the terminal action
  **Save & finish review**. Add **Keep current details** for a deliberate
  `review:'dismissed'` resolution. Do not silently attach `review:'confirmed'` to an ordinary
  edit-mode save or to a partial action that did not expose the full unresolved set. Suggested
  values remain opt-in and are never auto-applied. Show the dismiss action only when an
  `aiExtractedMetadata` object exists (the server cannot attach review state to `null`) **and** the
  current values do not trigger the missing-metadata predicate; never let dismissal hide a blank
  patient-name `metadata_missing` item. For `metadata_missing`, require a nonblank patient name
  before any terminal action can claim resolution. When `aiExtractedMetadata === null`, send only
  changed fields (no ineffective review key); when a real metadata object exists, the explicit
  whole-review terminal save may send `review:'confirmed'`.
- `src/lib/recordingQueryCache.ts` — include `['recordings', 'attention']` in invalidation,
  merge, and terminal remove paths. Otherwise a metadata save/delete/retry updates detail and
  other lists but leaves an already-mounted attention row stale. Let the terminal delete helper
  take the linked `patientId` and remove that patient's whole cached recordings-query prefix;
  deleting a non-draft cascades its SOAP note/tasks server-side, so the detail mutation must also
  remove those exact persisted query keys rather than leaving offline clinical content behind.
  When merging a full detail mutation into the attention envelope, merge only the
  `projectAttentionRecording()` result; never spread `errorMessage`, `errorCode`, audio URLs, or
  the rest of the broad detail object into this narrow cache.
- `src/lib/queryPersistence.ts` — explicitly exclude the 100-row attention query from disk
  dehydration. Existing recent/list/detail data already provide the deliberate offline clinical
  cache; duplicating a large, time-sensitive queue wastes the user-scoped snapshot and can make
  old work look current. In-memory cached items may remain visible with the global offline state.
  Removing the dead review filter also shifts the normal list key from
  `[..., status, review, sort]` to `[..., status, sort]`; update
  `isPersistableListVariant()` for that exact new shape so default Recordings pages do not
  accidentally stop persisting when `submittedAt-desc` moves into index 4.
- `app/(app)/(tabs)/index.tsx` — gate the server query on the same device-registration readiness
  as other server data; include attention/local queries in pull-to-refresh with void callbacks.
  For authorized roles, add the strict bounded support-recovery-vault summary to the existing
  recovery-first banner stack and route it to `/(app)/recording-recovery`; an unknown vault read
  shows a compact recovery-check retry state rather than false zero.
- `src/lib/localRecordings.ts`, `src/lib/draftStorage.ts`, and `src/lib/stashStorage.ts` — add the
  strict explicit-user summary/anchor reads specified below without changing the existing
  best-effort warning callers. `src/lib/supportStaffRecoveryVault.ts` adds a strict read-only,
  authorization-filtered summary/anchor lookup; neither Home discovery nor the
  destructive-decision path may reuse the lenient pruning reader. Add a guarded
  `secureStorage.getRawItemStrict()` sentinel path in
  `src/lib/secureStorage.ts` so these new reads can distinguish a legitimate missing key from a
  caught/reported Keystore failure; do not add any new direct `SecureStore.*` calls.
- `src/lib/fileOps.ts` — add a read-only strict existence check that distinguishes “missing” from
  an exception instead of using the existing deliberately lenient `fileExists()` false fallback.
  Strict draft/stash/anchor proof uses it; ordinary cleanup keeps the current safe wrappers.
- `app/(app)/(tabs)/recordings/index.tsx`, `src/components/RecordingCard.tsx`,
  `app/(app)/(tabs)/recordings/[id].tsx`, `src/api/recordings.ts`, and
  `src/lib/recordingQueryCache.ts` — remove the unsupported review filter/chips/mutations,
  `reviewStatus` request field, `updateReview()`, and `review_update` cache mutation. Delete
  `src/components/ReviewStatusChip.tsx` and `src/lib/recordingReview.ts` once no consumer remains,
  remove the stale `ReviewStatus` fields from `src/types/index.ts`, and add a real Needs Attention
  navigation entry. Update tests that currently assert this dead contract
  (`joy-phase5`, `multi-patient-submit-visibility`, and the persisted-list key expectation) rather
  than leaving contradictory guards behind.
- `app/(app)/_layout.tsx` — register the attention screen in the authenticated stack.
- `src/constants/strings.ts` and `src/lib/analytics.ts` — catalog copy and PHI-free events.

### Reuse (do not reimplement)

| Need | Existing |
|---|---|
| Suggestion extraction and empty-state | `src/lib/recordFirstObservability.ts` — `computeSuggestionFields()` `:206`, `shouldShowNoExtractionEmptyState()` `:238`, `METADATA_FIELDS` `:19` |
| Metadata ownership | `src/lib/recordingPermissions.ts:50` `getRecordingPermissions().canEdit` |
| Retry-role authorization | `src/lib/recordingPermissions.ts:25` `canRecordAppointments()` |
| Null-extraction record-first inference | `user?.capabilities?.includes('record_first')` (pattern at `recordings/[id].tsx:101`); explicit AI metadata does not depend on the current flag |
| Local un-sent reads | `draftStorage` + `stashStorage` logic already composed in `src/lib/localRecordings.ts`; expose a summary instead of duplicating storage access |
| The fix UI itself | `src/components/MetadataReviewCard.tsx` (`review`/`add`/`edit` modes) |
| Row / banner / empty / skeleton primitives | `src/components/ui/` — `ListItem`, `Banner`, `Badge`, `EmptyState`, `SkeletonCard` (`Skeleton.tsx:78`) |
| Copy | `src/constants/strings.ts` — extend `METADATA_REVIEW_COPY` (`:470`), add `ATTENTION_FEED_COPY` |

`countUnsentRecordings()` is sufficient for destructive-action warnings but not for navigation:
it counts drafts per recording and stashes per session, and a resumed stash can briefly coexist
with a fresh draft. Add a best-effort, user-scoped
`getUnsentWorkSummary(userId)`, with a result shaped like
`{ draftCount, stashSessionCount, draftsKnown, stashesKnown }`. The current explicit-user list
methods swallow SecureStore/Keystore failures to `[]`, which is unsafe for a feed: a failed read
would look like “all clear.” Add strict explicit-user variants
`draftStorage.listDraftsForUserStrict(userId)` and
`stashStorage.getStashedSessionsForUserStrict(userId)`, bound each call with
`withPromiseTimeout()`, and catch them independently so one source can still produce a partial
known result.

“Strict” here is deeper than removing the outer `catch`: current draft index/chunk readers and
stash parsers also turn malformed JSON, torn chunks, invalid indexed entries, or an unusable
generation into `[]`/`null`. The strict variants must distinguish legitimate absence from
unreadable/corrupt present data and reject the latter. A healthy fallback stash generation may
still prove the result; an absent store is a known empty list; a present layout for which no valid
copy can be recovered is unknown. A validated per-user in-memory cache is valid evidence, but a
leniently filtered cache is not.

For drafts, count only entries that satisfy the same semantics as
`draftStorage.draftHasLocalAudio(meta)` (including valid pending-confirm/durable proof), but expose
a strict variant for this query: segment existence errors are unknown, and a durable pointer must
resolve to an existing recovered file or a validated non-uploaded native manifest with complete
audio rather than merely being a syntactically valid, non-tombstoned id. Keep the existing
best-effort predicate for its current callers. Bound the strict list plus audio predicates as one
source operation; if any native read/predicate cannot settle or be classified, preserve any other
source's result but set `draftsKnown=false`. Keep `countUnsentRecordings()` as the active-scope
best-effort sum/backward-compatible wrapper, and render two synthetic rows when both kinds exist:

- draft row → Recordings screen (drafts already merge into that list);
- saved-session row → Record tab (where `Saved Sessions` and Resume live).

Call them “drafts” and “saved sessions,” not an authoritative number of recordings.
If either source is unknown, render a small **Could not check all saved work** retry state and do
not show an all-clear empty state. A late rejection from a timed-out native read remains observed
by `withPromiseTimeout()`. Use one named hard limit (for example,
`LOCAL_ATTENTION_READ_TIMEOUT_MS = 8_000`) for each source. Before reading, require both storage
modules' current scoped user ids to match the query's `userId`; scope mismatch is unknown/loading,
and this hook must never rebind global storage scope itself.

A local draft can carry a `serverDraftId`, so its source summary may overlap a failed/stuck server
row for the same underlying attempt. Do not suppress the local warning merely because a server
anchor exists—the device may still hold the only resumable audio—but do not call combined UI/event
counts “unique recordings.” `item_count` is explicitly rendered rows; draft/stash counts remain
source-qualified. A later per-record local feed would need stable-id reconciliation and CTA
precedence before deduping these sources.

Also expose a read-only
`findLocalRecoveryAnchor(user, serverRecordingId)` from `src/lib/localRecordings.ts` for the
detail deletion guard. Run its independent sources concurrently with observed
`Promise.allSettled` calls under one named hard deadline (not one sequential timeout per source);
while loading there is no destructive button. Return
`draft|saved_session|durable_recovery|support_recovery|none|unknown` plus only the routing id when
known:

- strict current-user drafts/stashes match normalized `serverDraftId` or pending-confirm
  recording id. A draft match must still pass the new strict recoverability predicate. For a matching stash slot,
  prove at least one valid completion source for that slot: normalized pending-confirm proof,
  existing segment, existing recovered-durable file, or a validated native durable manifest with
  complete audio. The destructive path uses the strict proof just defined, not the lenient
  tombstone-only durable shortcut. Do not block deletion merely because stale stash metadata exists or because a
  different slot in the same multi-patient session has audio; route a proven match through the
  existing resume validation;
- the lazy optional durable-recorder bridge checks the signed-in user's recoverable manifests for
  a matching `serverRecordingId`/pending-confirm id and actual recoverable audio; an unavailable,
  hung, or ambiguous native read is `unknown`, not `none`;
- an added strict **read-only** vault lookup applies the same organization/role visibility and
  recoverability rules as `supportStaffRecoveryVault.listItemsForUser()`, then matches
  `sourceServerDraftId`/pending-confirm id and routes to `/(app)/recording-recovery`. It must not
  call the current lenient/pruning read path while making a destructive decision.

The helper never rebinds scope, never scans another user's private draft/stash/durable directory,
never mutates or prunes recovery data, never emits ids to analytics, and treats any required
source's ambiguous read as `unknown` **when no proven match exists**. A proven match already
fails the destructive check safely and may route even if another source is unknown. If duplicate
anchors exist, honor current ownership semantics deterministically: a committed stash beats its
crash-window draft duplicate, then a draft beats its underlying orphan-manifest duplicate; use
the standalone durable/vault routes only when no indexed current-user owner matches. Return
`none` only when every source completed and none matched. A vault lookup is not a private-store
scan: it uses the existing neutral, same-organization recovery surface already authorized for the
signed-in owner/admin/veterinarian.

For both summary and anchor checks, take at most one bounded strict native-manifest snapshot per
operation and index it by durable/server recording id; do not issue one native bridge call per
draft/slot. This keeps large unsent stores inside the hard deadline and gives every predicate a
consistent on-device snapshot.

### Query, refresh, and cache contract

- Server key: `['recordings', 'attention', 'updated-v1']`.
- Request: `{ page: 1, limit: 100, sortBy: 'updatedAt', sortOrder: 'desc' }`. Attention is about
  recently changed source state. Using `submittedAt` would null-sort prepared `uploading` rows to
  the end and hide the very abandoned-upload signal this feed claims to detect.
- Do **not** reuse `['recordings', 'recent']`: Home's existing query requests five rows. Sharing a
  key between different query functions/limits would make whichever response wins overwrite the
  other consumer. One additional bounded request is intentional.
- Keep a validated paginated envelope whose `data` rows are projected
  `AttentionRecording`s—not raw list rows, `FeedItem[]`, or a server/local combined view—as the
  data stored under the `recordings` query key. Derive sanitized items with a memoized pure call.
  This preserves the envelope shape expected by recording cache merge/remove helpers without
  retaining the list's raw failure fields; local synthetic rows remain under their separate
  user-keyed query.
- Gate on `user && !deviceRegistrationPending && !deviceRegistrationBlock`, but expose why the
  request is disabled. Transient device-registration pending remains a loading/disabled state and
  emits no settled impression; an actual `deviceRegistrationBlock` is
  `serverAvailability='blocked'`. Neither is a successful empty server result.
- Refetch on focused-screen mount, foreground resume, and pull-to-refresh. Poll no faster than once
  per minute, only while the focused/active surface contains a raw row in
  `uploading|uploaded|transcribing|transcribed|generating|retry_scheduled`; `pending_metadata` does
  not poll forever. Maintain a separate at-most-one-minute `nowMs` tick while focused and any raw
  row can still cross a time-based predicate (pollable processing or a currently unexpired quality
  warning, including a parseable future warning timestamp that may reflect device clock skew).
  That tick crosses 5/20/35-minute stuck thresholds, future-to-current clock boundaries, and the
  seven-day quality expiry without requiring a network request. Update immediately on foreground
  and stop both timers in background.
- Local key includes the user id, e.g. `['attention', 'local-unsent', user.id]`; force-refetch it
  on focus and pull because stash mutations do not currently invalidate React Query.
- The separate support-recovery banner query is keyed by signed-in user **and organization**,
  enabled only for owner/admin/veterinarian, strictly read-only/bounded, and refetched on Home
  focus/pull. Its rows/count never enter the attention envelope or feed analytics.
- A server failure with cached rows shows cached rows plus stale/error state; a failure without
  cached rows shows a retry state **alongside any local unsent rows**. Never translate
  `data === undefined` into a clean state. Likewise, a local clean result requires both strict
  sources to be known.
- A successful envelope whose derivation is incomplete is `serverAvailability='partial'`: render
  every proven item plus **Some recording timing data could not be checked** and a retry. Keep
  pagination coverage separate—an endpoint can be lifetime-complete yet classification-partial,
  or fully classified but truncated.

Validate the unparsed list envelope in the query function before it reaches the pure builder:
`data` must be an array of minimally valid list rows (object, bounded known status, non-empty
UUID `id`/`userId`, server-bounded `patientName`, correctly bounded string/null values for the
other four metadata fields, string-array `qualityWarnings`, null-or-object AI metadata, and
bounded string/null timestamp shapes), recording ids must be unique, and `data.length` cannot exceed the
requested cap. Validate the pagination proof as the exact page-1/limit-100 response shape: finite
non-negative integer `total`, integer
`totalPages === Math.ceil(total / limit)`, and the requested page/limit echoed back. Nullable/legacy
AI metadata still goes through the defensive parser, but a structurally invalid/duplicate list row or
inconsistent pagination shape makes the response malformed rather than being silently dropped
into a false all-clear. A structurally valid row with an invalid/future required clock uses the
explicit partial-derivation state above.
Throw/display only generic malformed-response copy; never log or report the payload. Define:

- `coverage='complete'` when a valid `pagination.total <= data.length`;
- `coverage='recent_page_only'` when a valid `pagination.total > data.length`;
- `coverage='unknown'` when the pagination proof is absent/invalid.

`isTruncated` is exactly `coverage === 'recent_page_only'`. A response may contain many perfectly
clean recordings and produce zero derived feed items; “empty server page” is therefore the wrong
test. The positive clean state—user copy **No supported items need attention right now**—is
allowed only when all of these are true:

1. the current enabled server request succeeded without a stale/refetch error;
2. `coverage === 'complete'`;
3. `classificationComplete === true`;
4. zero server attention items were derived;
5. both local sources settled as known; and
6. both local counts are zero.

This is a feed-scoped statement, not an application-wide “all clear.” A higher-priority provider,
durable-recovery, support-vault-recovery, device, or offline banner may legitimately coexist above
it; do not change the copy to claim the whole practice has no outstanding work.

Every other zero-row combination is qualified:

| Server/local state | Zero-row presentation |
|---|---|
| Server loading/disabled/blocked/error/coverage unknown | Loading, blocked, or retry copy; never all-clear |
| Successful response, classification incomplete | Proven rows (if any) + “Some recording timing data could not be checked” + retry |
| Successful truncated page, no derived items | “No attention items found in the M most recently updated practice recordings checked.” |
| Server complete and clean, one local source unknown | “Could not check all saved work” + retry |
| Server complete and clean, both local sources known empty | **No supported items need attention right now** |
| Any known local rows while server unavailable | Render those rows plus the server retry/blocked state |

The attention query is deliberately not disk-persisted, so a cold offline launch has no server
proof even if other normal recording caches hydrate. It may show known local work, but never infer
an all-clear result from a different five-row/list cache.

#### Known boundedness limit

The existing endpoint's `pagination.total` covers the organization's lifetime non-draft rows and
has no attention predicate/date-window filter. Once an organization has more than 100 such rows,
this client-only v1 is permanently a **recently updated snapshot**, not an exhaustive backlog;
older failed/unreviewed rows may be outside it. That is why it has no authoritative badge, never
says “View all,” and uses qualified copy. `updatedAt desc` makes the bounded snapshot operationally
better than `submittedAt desc`, especially for prepared uploads, but does not make it exhaustive.

If exhaustive outstanding-work semantics or push/badge counts become a requirement, add a Connect
attention-summary/list endpoint that evaluates the same predicates server-side (with cursor
pagination and bounded counts), rather than silently paginating the entire lifetime list on every
Home focus.

### Deterministic priority

Within each actionability group:

1. `recording_failed`
2. `retry_scheduled`
3. `stuck_processing`
4. `local_drafts`
5. `local_saved_sessions`
6. `multiple_patients`
7. `metadata_conflict`
8. `metadata_confirm`
9. `metadata_missing`
10. `metadata_low_confidence`
11. `metadata_not_verbatim`
12. `metadata_suggestion_unclassified`
13. `quality_warning`

Tie-break by valid `submittedAt` descending, then valid `updatedAt` descending, then `id`
ascending. At each date comparison, valid timestamps sort ahead of invalid/absent timestamps;
two invalid values tie. A recording contributes one row at the rank of its highest reason while
retaining all matched reasons for `+N more issues`. Synthetic local rows participate at their
explicit ranks above; they do not jump ahead of a failed/stuck server recording merely because
they are device-local.

### Behavior rules

- **Tap a server item → the detail screen focused on the existing source UI.** Metadata opens the
  existing review card in review mode **only when the viewer may edit it**; processing and quality
  focus their existing cards. A read-only metadata row may open ordinary detail context, but the
  `focus` parameter must not bypass `canEdit` or render a mutation card. Do not build a second
  editing/mutation surface.
- **Processing rows use a neutral “Review”/“Open” CTA, not a promised “Retry” CTA.** The list omits
  `audioFileUrl`; after detail loads, existing presentation chooses Retry versus Audio unavailable.
  Gate Retry and Start-new remediation controls with `canRecordAppointments(user.role)`. For
  unavailable audio, prefer a matching on-device recovery anchor; otherwise
  creator/owner/admin may explicitly delete the no-audio placeholder after the fail-closed
  current-device check and cross-device warning. Other veterinarians can start a replacement
  visit or coordinate but cannot falsely clear/delete it.
- **Split by per-kind actionability, don't filter.** Preserve practice-wide read-only rows.
- **Evaluate `dropReasons` directly, never `needsMetadataReview` alone — then apply the
  confirmed/dismissed resolution gate.**
- **No feed-local dismissal in v1.** Metadata clears only through the explicit whole-review source
  action; processing clears on status change; quality warnings expire from this attention surface
  after seven days.
- **Bound the fetch and say so.** `ListRecordingsQuerySchema` caps `limit` at **100**, default 20
   (`recording.schema.ts:700-712`). A practice-wide feed over a busy org cannot see everything in
   one page. Use the validated coverage state above. When truncated, labels say
   `N attention items found in the M most recently updated practice recordings checked` where
   `M = data.length` (normally 100, never a fabricated page size), or use the zero-item copy in the
   table above. The CTA says
   **View recent attention**, never “View all N.” Device-local rows are reported separately and
   are not described as part of those M. With complete coverage, server-group row counts may be
   unqualified because the page covers the server result set.
- The Home **View recent attention** link appears when a loaded row is omitted from Home (more than
  three Needs-you rows or any Across-practice rows) or when coverage is truncated/unknown and the
  full screen provides the qualifier/retry detail, or when classification/local completeness is
  partial. Do not imply the full screen fetched beyond the same bounded page. The
  Recordings-header entry is always available.
- **No badge count on the tab bar** in v1 — there is no `tabBarBadge` anywhere in the app and no
  push infra; adding one is a separate decision.

### Constraints from CLAUDE.md that apply

- Rule 1 — no validator, native availability check, or environment-dependent initialization may
  throw at module load; malformed input becomes a returned parse/result state.
- Rule 2 — no async fn passed to `onPress`/`onRefresh`; wrap with `.catch()`.
- Rule 3 — strict storage does not mean an unwrapped Keystore call. The sole SecureStore adapter
  catches/reports the native error and rejects with a safe typed sentinel that the bounded
  strict reader converts to `unknown`; no raw native message reaches UI/analytics.
- Rule 4 — every fire-and-forget Promise gets `.catch(() => {})`.
- Rule 5 — loading state reset in `finally`.
- Rule 10 — treat list/local response members defensively: `Array.isArray()` before iteration,
  nullable extracted values, and no assumption that broad `Recording` fields exist on a list row.
- Rule 11 — guard `new Date()` with `isNaN(d.getTime())` before any `Intl` call (the "stuck
  processing" age calculation and relative timestamps).
- Rule 12 — `console.error` behind `__DEV__`.
- Rule 13 — every local draft/stash read occurs only after the authenticated user id is set; local
  query keys include that id and results are never reused across users.
- Rule 19 — durable-recorder/native availability remains lazy and optional; no new static native
  import may crash an older development client.
- Rule 24 — the attention section must not gate Home behind its network/local reads. Render its
  own bounded skeleton/error state; Home, its Record CTA, and local recovery remain usable if a
  query/native storage read hangs. If the full screen uses an early-return loader, give that gate
  a hard watchdog.
- Any custom `AppState` listener is synchronous with an outer `try/catch`; foreground refetches are
  invoked as observed Promises with `.catch()`. Pull-to-refresh similarly uses a void wrapper
  around a bounded `Promise.allSettled`/observed refresh operation.
- **PHI:** patient/client names may render on-device but must never enter an analytics event or
  Sentry payload. New events carry counts and reason codes only (add to the `AnalyticsEvent`
  union in `src/lib/analytics.ts` — an unlisted event will not compile, by design). Note the
  server's drop-reason schema is already PHI-free by construction; keep it that way client-side.
- **Safe errors:** raw list `errorMessage` stays off-screen and out of analytics/Sentry. Use only
  generic copy and a bounded code vocabulary/fallback.
- Guard tests: new copy must live in `src/constants/strings.ts` (`strings-catalog-guard`), use
  theme tokens (`theme-token-guard`/`dark-mode-guard`), respect the 1.3 font-scale cap
  (`font-scaling-guard`), and keep Android clip mitigation in the shared primitives
  (`ui-clip-guard`).

### Suggested new analytics (PHI-free)

- `attention_feed_shown { surface, item_count, server_item_count, local_item_count,
  actionable_count, across_practice_count, top_reason_code, coverage, truncated, server_state,
  classification_complete, uncheckable_timing_row_count, local_complete }`
- `attention_feed_item_opened { surface, category, reason_code, field_code, actionable }`
- Extend `ai_metadata_review_resolved` with
  `source: 'recording_detail' | 'attention_feed'`, bounded `changed_fields`, and bounded
  `attention_reason_codes`; derive `source` only from the validated route source.

`surface` is `home|attention_screen`; `category` is `processing|metadata|quality|local`;
`reason_code`/`top_reason_code` use the closed priority vocabulary in this plan
(`top_reason_code='none'` for no row); `field_code` is one of the five metadata field names or
`none`; `coverage` is the
three-value coverage state above; `server_state` is a closed
`success|partial|stale_error|error|blocked` state. `partial` means the response succeeded but one
or more supported time predicates lacked a valid clock input. Counts mean loaded feed rows
represented by the surface—including rows summarized inside a collapsed Across-practice
group—not recordings beyond the bounded page and not unique recordings across local/server
sources.
`item_count = server_item_count + local_item_count`, and
`actionable_count + across_practice_count = item_count`.
`classification_complete` is true only for a successful, fully classifiable current response;
blocked/error/no-current-response snapshots report false, with zero timing count meaning “none
observed,” not proof of completeness.

Emit `shown` once the surface has a settled/blocked snapshot rather than on its initial skeleton.
Deduplicate once per surface focus and a stable PHI-free fingerprint made from item ids, normalized
reason codes, actionability, coverage/server state/classification completeness, local
completeness, and source-qualified counts; the fingerprint itself is not emitted. This lets a
real partial/error transition or local count change produce a new settled snapshot while ordinary
rerenders and a minute tick with no classification change do not inflate impressions. Construct
every event object explicitly; never include patient/client/suggested/current/warning text,
recording blobs, raw server failure codes, or storage/network exception text.

The existing detail screen currently emits `ai_metadata_review_resolved` for every metadata save,
including ordinary edit-mode changes after AI review was already confirmed. That pollutes the
correction KPI. Emit it only when the **pre-mutation** row satisfied the shared unresolved-AI
predicate **and** the normalized mutation response no longer does; a partial/no-op save is not a
resolution. `changed_fields` contains only changed names from the five-field
`RecordingMetadataField` enum (never PIMS id or values), and `attention_reason_codes` is the
deduplicated pre-mutation AI reason set encoded with bounded field association where applicable
(for example `breed:low_confidence`, never a value). Both arrays are bounded and PHI-free.
Generic later edits still perform their mutation/cache work but do not masquerade as AI-review
resolutions.

Do not add a generic `attention_feed_resolved`: metadata saves are immediate, failed/stuck
resolution is asynchronous, quality warnings merely age out, and local work resolves on another
screen. One event name would pretend those incompatible lifecycles were the same. Use the sourced
metadata event plus existing retry/stash/draft lifecycle events for action funnels.

---

## The server-side half (separate repo — reprioritized by this audit)

The feed makes bad extraction *visible and fixable*; it does not make extraction *better*. The
measured problem is the 79.5% zero-fill rate; the causal mix behind that rate is not yet known.

The first feed draft made a historical error here. During the measured 2026-06-13→06-18 window,
the original server implementation (`b7a01a8`, 2026-06-12) set
`review: 'unconfirmed'` whenever `Object.keys(extraction.fields).length > 0`, regardless of how
many fields were applied. The server changed to `appliedFields.length > 0` on 2026-06-21
(`e8452a5`), added the multi-patient review path later that day (`aa8b5db`), and added conflicts
on 2026-07-23 (`31dbabd`).

Therefore the **66 card-shown / zero-applied events prove only that the model returned extracted
fields that were not applied**. They do not identify multi-patient, confidence, verbatim, or
pre-filled fields. Multi-patient is still important — its current path hard-returns
`{ appliedFields: [], values: {}, dropReasons }` (`metadata-extraction.ts:343-351`) — so it
applies nothing while preserving classified suggestions, but history cannot make it the presumed
dominant cause.

Recommended order:

1. **Query production `aiExtractedMetadata` for the drop-reason mix** — count every
   `(field, reason)` occurrence and per-recording reason combinations; do not invent an undefined
   “dominant” reason. For `low_confidence`, bucket the score distribution per field. Segment by
   extraction date because the review predicate changed on June 21 and conflict behavior changed
   on July 23. Report blobs with absent `dropReasons` as a separate **telemetry unavailable**
   denominator; do not reinterpret absence as `null_extraction` or exclude it silently.
   Aggregate only field/reason/score and date buckets; do not export extracted values, patient
   names, user ids, raw transcript text, or whole JSON blobs.
2. **If `multi_patient` is the largest bucket:** audit the detector's false-positive rate (a client and a vet
   discussing one animal can read as two speakers/patients). Any labeled review stays in an
   authorized clinical surface rather than a data export. Consider applying high-confidence fields
   while still flagging only after the sample proves patient association; confidence alone does
   not prevent assigning the other patient's details.
3. **If `low_confidence` is the largest bucket just under the gate:** lower the per-field env overrides
   (`AI_METADATA_CONF_BREED` etc.) one field/cohort at a time — no code deploy needed — and watch
   apply rate plus the corrected `ai_metadata_review_resolved` reason/changed-field aggregates.
   Define the rollback threshold before the canary; do not trade fewer missing fields for more
   wrong auto-applies.
4. **Evaluate `not_verbatim` matching** if it is a large bucket. Test bounded normalization/fuzzy
   candidates against an authorized labeled sample—short pet names make naïve edit-distance
   matching risky—before changing the auto-apply rule.
5. **Broaden `conflicts_with_existing` beyond `species`** so name mismatches become reviewable.
6. **Fix `create_draft` HTTP_500** (49 events) — distinct upload-path bug, blocks recordings
   before extraction runs. Triage separately.

Both halves are worth doing and independent: the mobile feed does not block on this query/tuning,
and the production reason query does not block on feed analytics or release adoption.

---

## Verification plan

1. `npm run typecheck`, `npm run lint`, and the full `npm test` suite.
2. `node --test tests/attention-feed.test.mjs` — new functional tests over
   `deriveRecordingAttention()`
   using list-shaped fixture objects, not fully populated detail-only `Recording`s. Must assert:
   - `already_filled` alone produces **no** item.
   - A recording with `review: 'none'` but `low_confidence` drops **still** produces an item
     (the invariant above).
   - A historical blob with absent review state still surfaces explicit valid
     applied/multi/conflict signals.
   - An explicit `review:'unconfirmed'` object with no recoverable detailed reason gets the
     generic `metadata_confirm` fallback rather than vanishing.
   - The same drop reason under `review: 'confirmed'`/`'dismissed'` produces **no** item.
   - Null extraction metadata + blank patient name produces `metadata_missing`, which clears once
     the user adds the missing patient metadata.
   - Suggested values resolve from non-empty `fields[field].value`, tolerate `null`, and never
     come from the PHI-free drop reason; the old object/drop-only value fixture is rewritten to
     prove those legacy value keys are discarded.
   - A normalized conflict/low-confidence/not-verbatim drop still produces its generic reason
     row when the extracted value is null/absent; no copy fabricates a value.
   - Array and defensive legacy-record drop-reason shapes normalize identically.
   - A pre-C7 unresolved suggestion with absent drop reasons produces
     `metadata_suggestion_unclassified`; a suggestion with a known reason does not also get that
     fallback.
   - Multi-patient/conflict/confirm reason precedence is deterministic.
   - Multiple matches on one recording produce one row with normalized/deduplicated reasons
     retained in reason-priority then field order; quality warnings remain one logical reason
     with their own warning count.
   - Corrupt overlong metadata/drop arrays and legacy values produce bounded deterministic
     reasons/copy; stable keys never depend on array order or clinical text.
   - Failed, retry-scheduled, 5-minute uploaded, 35-minute uploading, and 20-minute
     active-processing boundaries rank correctly; invalid/future dates do not become stuck and
     make the result classification-partial only when that time predicate is needed.
   - `pending_metadata` does not masquerade as a retry/stuck item while its mobile completion
     workflow remains deferred.
   - Raw `errorMessage` and unknown raw `errorCode` never enter the normalized item, rendered copy,
     or analytics props.
   - Quality warnings appear only for completed rows with an age in `[0, 7 days]`; future,
     invalid, and older timestamps suppress them, and row copy is length/line bounded.
   - A colleague's metadata is read-only for a veterinarian, but the same veterinarian may act on
     a colleague's retryable row; support staff may do neither.
   - Owner/admin metadata actionability; capability-off suppresses only ambiguous null-metadata
     inference and does not hide an explicit unresolved AI metadata object.
   - Invalid/duplicate applied fields do not inflate displayed counts.
   - Stable tie-breaking is independent of input order.
3. `tests/attention-feed-cache.test.mjs` (or equivalent functional coverage):
   - attention query key cannot collide with Home's five-row key;
   - the recordings-key cache retains a paginated list-row envelope while derived/local feed
     items stay outside it;
   - network projection and detail-cache merge both retain only `AttentionRecording` fields;
     raw failure/audio/detail fields cannot re-enter the attention cache;
   - metadata/retry/delete invalidation reaches attention;
   - merge/remove helpers update attention payloads;
   - terminal non-draft delete removes recording detail, SOAP note, tasks, every recordings list,
     and the linked patient's cached visit-query variants before navigation, then invalidates
     affected summaries;
   - attention pages are excluded from disk persistence;
   - the post-review-removal normal Recordings key shape still persists only its default
     unsearched/unfiltered variant;
   - malformed/undefined/error/blocked server states are distinct from successful, complete
     coverage with zero derived matches;
   - device-registration pending stays loading with no shown event, while a real registration
     block settles as blocked; neither can produce clean copy;
   - a valid response with an unevaluable processing/quality clock remains pagination-valid but
     classification-partial, renders proven items plus the timing-check warning, and cannot
     produce clean copy;
   - malformed/non-UUID ids cannot be interpolated into navigation and make the envelope fail
     safely rather than routing elsewhere;
   - duplicate ids, more than 100 rows, or inconsistent page/limit/totalPages proofs make the
     envelope malformed rather than manufacturing complete coverage;
   - a non-empty server response containing only clean recordings can produce the scoped clean
     copy when coverage is complete and local sources are known empty;
   - invalid pagination produces unknown coverage, while `pagination.total > data.length`
     produces qualified dynamic “M most recently updated practice recordings checked” copy and never
     “View all”;
   - cold-offline hydrated normal recording caches do not become attention/all-clear proof;
   - the minute tick crosses 5/20/35-minute, parseable future-to-current, and seven-day boundaries
     without network refetch, while server polling uses only the explicit pollable statuses and
     pauses in background.
4. Local-work tests:
   - query/storage reads are user-scoped;
   - native failures, malformed indexes/JSON, torn chunks, invalid cached entries, and
     unrecoverable stash generations return a partial summary with the failed source marked
     unknown, never a false zero/all-clear;
   - a missing secure key is known absence while a Keystore exception from the guarded strict
     adapter is unknown; no new module calls `SecureStore.*` directly;
   - true absence and a healthy fallback generation are known results;
   - only drafts with local/pending-confirm/durable audio proof count, and an audio-proof read
     failure marks the draft source unknown;
   - a stale syntactically valid durable pointer is not proof: strict segment/recovered-file/native
     checks distinguish missing from bridge/filesystem failure, while existing best-effort callers
     retain their current behavior;
   - late native rejection after the timeout is observed;
   - draft and saved-session counts remain distinct and route to their actual existing surfaces;
   - a resumed stash remains visible, without calling the count an exact recording total;
   - a local draft with a matching `serverDraftId` remains source-qualified alongside a server
     attention row, and combined analytics counts are asserted as UI rows—not unique recordings;
   - detail anchor lookup matches draft/stash/durable/vault server or pending-confirm ids,
     requires actual recoverability proof, returns unknown on ambiguous reads, does not mutate
     recovery data, and never crosses a private user scope;
   - a proven anchor wins safely over an unrelated unknown source, stash-over-draft and
     draft-over-orphan-manifest duplicate precedence is deterministic, and `none` requires every
     source to prove no match;
   - authorized support-recovery vault count/match uses a strict read-only snapshot, routes from
     the recovery-priority banner, and renders retry—not zero—when that snapshot is unknown;
5. Detail integration tests:
   - `review: 'none'` + a low-confidence/not-verbatim suggestion renders review mode from both
     direct detail and attention navigation;
   - all unresolved AI reasons/suggestions are exposed before the whole-review terminal action;
     Save & finish confirms, Keep current dismisses only a real metadata object, and neither
     silently auto-applies a suggestion;
   - null-extraction missing metadata cannot claim resolution without a nonblank patient name and
     cannot offer a dismissal that would hide the missing field; null-object saves omit the
     server-ineffective review key;
   - a successful save sets/observes the source resolution and removes the cached feed row;
   - confirmed metadata does not reappear after refetch even though drop reasons persist;
   - `ai_metadata_review_resolved` carries only bounded changed-field/reason codes for a
     pre-mutation unresolved AI item, and an ordinary edit after confirmation emits no false AI
     resolution;
   - focus route values are allowlisted, permission gates cannot be bypassed by params, and Back
     returns to Attention;
   - retry CTA visibility matches owner/admin/veterinarian server authorization and is hidden for
     support staff; list navigation promises only Review/Open until detail knows audio
     availability, and Start-new remediation is role-gated too;
   - an audio-unavailable on-device anchor routes to its real draft/stash/durable/vault recovery
     surface; only an author/owner/admin with a known “no matching signed-in-account anchor on
     this device” result **and no authorized matching vault item** can explicitly delete the placeholder after the
     cross-device plus SOAP-note/task warning and purge all terminal caches; unknown local state
     and colleague veterinarian/support permissions fail closed to guidance;
   - the unsupported legacy review filter/request UI and its contradictory source-regex tests are
     removed or rewritten.
6. Existing guard tests stay green: `strings-catalog-guard`, `theme-token-guard`,
   `dark-mode-guard`, `font-scaling-guard`, `ui-clip-guard`, `query-persistence-guard`.
7. Android emulator per CLAUDE.md → Emulator Testing: Home renders without being gated by the
   feed, qualified count matches a mocked/truncated page, server-error + local-work coexist, tap
   routes to the right detail card/mode, pull-to-refresh does not create an unhandled promise, and
   a support-recovery item appears in the recovery-priority banner rather than the feed, while
   the clean state appears only after a successful, coverage-complete, fully classified response
   with zero derived items plus two known-empty local sources.
   (Emulator mic peaks below −20 dBFS so the upload path itself cannot be exercised there.)
8. Physical Android for the text-truncation class of bug — reason strings are long and sit in
   `flex-row` rows, the exact shape that clips on Android (CLAUDE.md → UI Gotchas).
9. Dark mode + font scale at the 1.3 cap, VoiceOver/TalkBack labels for collapsed practice rows,
   and offline launch/foreground recovery with an already hydrated normal recordings cache.

---

## Audit log (2026-07-29)

Repeated passes checked current Mobile source, current Connect source, and the relevant git
history. Corrections are kept here so implementation does not regress to an attractive but
disproved assumption.

### Pass 1 — payload and extraction semantics

| Finding | Correction |
|---|---|
| The draft put suggested/current values inside `dropReasons`. | The strict schema contains only `{ field, reason, score? }`; values come from extracted fields + the recording row. |
| It used a patient-name conflict example. | Connect emits `conflicts_with_existing` only for `species` today. |
| It treated extracted values as always strings. | The server schema permits `value: null`; mobile's type must align and copy must guard it. |
| It keyed discovery too heavily on `needsMetadataReview`. | `review: 'none'` can still contain low-confidence/not-verbatim suggestions. |
| Pre-C7 unresolved suggestions can have no reason payload at all. | Add one per-field unclassified-suggestion fallback; make missing telemetry visible without guessing a cause. |

### Pass 2 — lifecycle, list contract, and history

| Finding | Correction |
|---|---|
| Direct drop-reason evaluation would keep fixed rows forever. | `confirmed`/`dismissed` suppress AI items because the server preserves historical drops after review. |
| Stuck processing used `processingStartedAt ~30 min`. | The list omits that field. Use `updatedAt`: uploaded 5 min, active processing 20 min, and a conservative uploading 35 min when list audio presence is unknown. Detail can use exact audio-aware eligibility. |
| “Human review pending” reused a working mobile helper. | Connect has no Recording review field, query filter, or update route. The existing mobile filter/chip/API call are contract drift and must be removed or separately implemented. |
| The 66 zero-fill cards were attributed to multi-patient detection. | Git history disproves this: during June 13–18, any non-empty extracted `fields` made the card unconfirmed. Multi-patient-specific review was added June 21. Query the reason distribution before tuning. |

### Pass 3 — actionability and destination audit

| Finding | Correction |
|---|---|
| Every row used metadata `canEdit`. | Retry is org-wide for owner/admin/veterinarian; use per-kind authorization and fix the detail retry gate. |
| “Not exported” had a working detail resolution. | Current PIMS target calls lack required extension authorization and return 409; copy/share does not mark exported. Deferred until mobile has a supported explicit action. |
| One highest-severity row discarded other problems. | Keep all reasons on one row, with deterministic primary rank and `+N more`. |
| Local count was treated as an exact recording count and had one destination. | Preserve draft vs saved-session counts and route each to the surface that can resume it. |
| Provider incidents were both above and inside the feed. | Keep the existing higher-priority, server-dismissible banner; do not duplicate it. |

### Pass 4 — query/cache, failure, and observability audit

| Finding | Correction |
|---|---|
| The hook would “reuse Home query keys” despite requesting 100 vs Home's 5. | Use a distinct attention key; key/data-function mismatch would corrupt both caches. |
| Metadata mutation invalidation ignored the new cache. | Extend invalidation, merge, and remove helpers to attention. |
| The 100-row queue would silently enter the broad recordings persistence allowlist. | Explicitly exclude it from dehydration and test that choice. |
| Removing the review-filter key slot would make the persistence guard inspect the sort token as a review value. | Update the normal list-key parser/guard with the key migration so default offline pages remain persistable. |
| Undefined/error data could look like an empty clean feed. | Model server error/stale/truncated state separately and continue showing local unsent work. |
| A generic “resolved” event combined incompatible lifecycles. | Keep shown/opened plus a sourced metadata-resolution event; reuse existing lifecycle events elsewhere. |
| Raw failed-row messages were proposed as UI copy. | Render safe generic copy; raw server exception text stays off-screen. |

### Pass 5 — empty-state, local-integrity, and response-shape audit

| Finding | Correction |
|---|---|
| The clean state required an empty API page, so a nonempty page of clean recordings could never clear. | Derive zero matches from a successful complete result set; reserve scoped clean copy for complete server coverage plus two known-empty local sources. |
| Conversely, zero matches from a truncated/malformed/blocked response could look authoritative. | Add explicit coverage/availability states and qualified recent-page copy; malformed rows never get silently discarded. |
| Merely adding `*Strict()` wrappers would still let inner draft/stash parsers collapse corruption and torn chunks to empty. | Strict reads must distinguish absence from present-but-unrecoverable data all the way through indexes, chunks, generations, parser validation, and cache reads. |
| Draft metadata count included entries with no recoverable local audio. | Preserve `draftHasLocalAudio()` semantics through a strict proof variant, bound the whole source operation, and mark ambiguous audio/native/file checks unknown. |
| Fixed “100 recent” copy could lie when a response returned fewer rows. | Use the actual returned page length `M`, retaining 100 only as the request cap. |
| Sorting by `submittedAt` null-sorted prepared uploads behind ordinary visits. | Sort the bounded attention snapshot by `updatedAt desc`; keep the lifetime-page limitation explicit. |

### Pass 6 — deferred-scope and metric-integrity audit

| Finding | Correction |
|---|---|
| `pending_metadata` was omitted despite being a visible unresolved status. | Defer it explicitly because mobile has only a static card, not the existing server completion workflow. |
| Recording tasks were said to need a server batch/list endpoint. | Connect already has paginated org-wide `GET /api/tasks`; defer for mobile client/pagination/product scope, not missing server discovery. |
| The sequencing said feed analytics would reveal the production drop-reason distribution. | Query the PHI-free server JSON aggregate independently; neither workstream waits on the other. |
| `ai_metadata_review_resolved` fires for ordinary post-confirmation edits today. | Gate it on the pre-mutation unresolved-AI predicate and emit only bounded changed-field/reason codes, so tuning does not use a polluted correction KPI. |
| List navigation implied every processing row could retry. | Use neutral Review/Open copy until detail loads `audioFileUrl`, then role-gate Retry or Start-new remediation. |
| Start-new did not clear an audio-unavailable failed/stuck source row, making it immortal. | Prefer any signed-in-account draft/stash/durable anchor or authorized recovery-vault item on this device; only after a fail-closed lookup and cross-device warning may the author/owner/admin explicitly delete the no-audio placeholder. |
| Saving one metadata suggestion can mark the whole review confirmed and hide untouched reasons. | Expose the complete AI reason set before an explicit Save-and-finish or Keep-current whole-review action; null metadata cannot be dismissed server-side. |
| Blanket current-capability gating would hide historical explicit AI metadata after record-first was disabled. | Explicit AI blobs remain reviewable; the current capability gates only the origin-ambiguous null-extraction inference. |

### Pass 7 — fail-closed classification, recovery, and terminal-cache audit

| Finding | Correction |
|---|---|
| Conflict/low-confidence predicates still required a value-bearing suggestion, contradicting the promised generic handling of null/legacy values. | Detect known reasons independently of display values; use bounded generic copy when the value is unavailable. |
| An explicit `review:'unconfirmed'` blob could vanish when all legacy details failed normalization. | Use generic `metadata_confirm` only as the final no-other-reason fallback. |
| Invalid time data correctly suppressed a guessed stuck/quality row but could then produce false clean copy. | Return classification completeness separately from pagination coverage; unevaluable required clocks produce a partial check and timing warning. |
| UUID validation alone allowed duplicate rows/inconsistent pagination to manufacture complete coverage. | Validate unique ids, cap/page/limit/totalPages invariants, and fail the envelope safely. |
| Transient device registration was classified like a settled registration block. | Keep pending as loading/no-impression; only the real block state settles as blocked. |
| The unavailable-audio delete guard checked only current drafts/stashes and overstated that as “no local data.” | Check proven current-user draft/stash/durable anchors plus the authorized neutral recovery vault; `none` requires every source, while ambiguity fails closed and cross-device/account limits stay explicit. |
| A stale stash record or unrelated multi-patient slot could block deletion without recoverable bytes. | Require matching-slot pending-confirm, segment, recovered durable, or validated native durable proof. |
| Support-staff vault recoveries were described as already bannered, but source showed discovery only in Settings. | Add a strict bounded recovery-priority Home banner; keep it out of lower feed counts and route to the existing recovery screen. |
| Non-draft deletion would leave cascaded SOAP/task data and patient visits in persisted caches. | Purge all terminal recording consumers and the linked patient's visit-query prefix before navigation, then invalidate summaries. |
| A “strict” SecureStore read implemented directly would violate the Keystore crash rule. | Add a caught/reported typed strict read to the sole adapter; distinguish missing keys from native failure without new direct calls. |

### Claims that held

The org-scoped list `where`, author/owner/admin metadata guards, confidence defaults, C7 drop
reasons, full AI metadata in the list select, species-only conflict behavior, list limit 100,
quality-warning sentences, record-first capability, four-tab layout constraint, and the three
June audit metrics all matched authoritative source.

---

## Status

**Mobile half implemented 2026-07-29.**

Shipped:

- `src/lib/attentionFeed.ts` (pure derivation, envelope validation, coverage) +
  `src/hooks/useAttentionFeed.ts` + `src/components/AttentionFeedSection.tsx` +
  `app/(app)/attention.tsx`, registered in `app/(app)/_layout.tsx`.
- `src/lib/recordFirstObservability.ts` is now the single canonical
  `parseMetadataDropReasons()` / `computeMetadataAttentionSignals()` /
  `hasUnresolvedAiMetadataAttention()` source, shared by the detail card, its
  `ai_metadata_review_shown` effect, and the feed. `src/types/index.ts` aligns the nullable
  extracted value and the closed, PHI-free drop-reason shape.
- Strict local reads: `src/lib/strictRead.ts`, `secureStorage.getRawItemStrict`,
  `fileOps.fileExistsStrict`, `draftStorage.listDraftsForUserStrict` /
  `draftHasLocalAudioStrict`, `stashStorage.getStashedSessionsForUserStrict`,
  `supportStaffRecoveryVault.listItemsForUserStrict`, plus
  `localRecordings.getUnsentWorkSummary()` and `findLocalRecoveryAnchor()`.
- Cache/persistence: attention joins invalidate/merge/remove, `purgeDeletedRecordingCaches()`
  handles the cascaded non-draft delete, and the attention page is excluded from disk dehydration
  (the normal list key migrated to `[..., status, sort]`).
- Detail screen: shared unresolved-AI predicate → review mode, validated
  `from=attention&focus=…` routing with scroll-to-card, row-age stale processing, role-gated
  retry/start-new, and the fail-closed **Delete unavailable recording** guard.
- `MetadataReviewCard`: whole-review semantics — the complete reason set, **Save & finish review**,
  **Keep current details**, and no silent `review:'confirmed'` on an ordinary edit.
- The unsupported human-review contract (filter, chip, `updateReview()`, `ReviewStatus` types) is
  removed; the Recordings header now links to `/attention`.
- Copy in `src/constants/strings.ts`; PHI-free `attention_feed_shown` /
  `attention_feed_item_opened` events plus the sourced, gated `ai_metadata_review_resolved`.

Verification run: `npm run typecheck`, `npm run lint`, and the full `npm test` suite pass, including
new `tests/attention-feed.test.mjs`, `tests/attention-feed-cache.test.mjs`,
`tests/attention-local-work.test.mjs`, and `tests/attention-detail-integration.test.mjs` and every
existing guard test.

Still manual (verification plan steps 7-9): Android emulator smoke test, physical-Android
text-truncation check, and the dark-mode / 1.3 font-scale / TalkBack / offline-launch pass.

The server-side half (drop-reason distribution query, confidence tuning, broadening
`conflicts_with_existing`, the `create_draft` HTTP_500 triage) remains untouched and independent.

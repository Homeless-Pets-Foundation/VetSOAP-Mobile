# Captivet audit improvements: implementation plan

## 1. Goal and agreed defaults

Implement all ten findings from the October 28 audit, improving completed-note reading, recovery, historical retrieval, template visibility and export status.

Agreed decisions:

- Include Mobile and Connect API changes for complete date-range filtering.
- Keep Subjective open initially; allow several SOAP sections to remain open.
- Use native date pickers for custom ranges.
- Order and filter by the date currently displayed: submission date, falling back to creation/saved date.
- TalkBack gesture/speech acceptance is excluded at the user's request on October 29. Accessibility labels, layout and font-scaling checks remain required.

Preserve existing recordings, recovery offers, drafts, metadata validation, permission gates and unsaved-edit protections. Keep the work focused on the audit findings.

Before implementation, save this plan as `docs/captivet-audit-improvements-implementation-plan-2026-10-28.md`, with a corresponding reference in Connect. Use separate working branches/worktrees: Connect currently contains unrelated uncommitted work.

## 2. Delivery sequence

### PR 1 — Correct misleading guidance and recovery navigation

**Findings:** F2, F3, F4, F10. **Estimate:** 2 days.

**Metadata-review copy**

- Determine whether patient details exist from saved recording fields, including PIMS Patient ID.
- Stop using the absence of AI-applied fields as evidence that patient details are missing.
- Show neutral review guidance for populated visits with unresolved suggestions or conflicts.
- Keep add-details guidance for genuinely blank visits.
- Preserve current-versus-suggested values, required-name validation, confirmation and dismissal rules. Do not change suggestion application or review-resolution behavior.

**Readable status filter**

- Give Recordings search its own row.
- Place the status selector below it at full phone width.
- Preserve the current selection sheet and immediate selection behavior.
- Keep the entire “Not Submitted” label visible with supported text scaling and Android Bold text. Leave the shared `Select` implementation unchanged.

**Recovery destinations**

- Keep the existing Home recovery banner.
- Mount the same `DurableRecoveryBanner` in the Record screen’s header.
- Make recovered work reachable from the microphone-permission screen without granting microphone access.
- Add “Recovered recordings” in Settings, linking to durable recovery.
- Rename the existing staff-vault entry and screen to “Staff sign-out recovery”; describe its separate purpose and use “device” instead of “tablet.”
- Reuse the existing stores, counts, routes and role gates. Do not migrate or combine recovery storage.

**Small consistency fixes**

- Make audio-download destination guidance platform-specific: Android folder/Downloads wording and iOS Files wording. Preserve the explanation that downloaded files survive sign-out and app removal.
- Add the existing Android clear-search control to Patients.
- Display readable Clinic Quality role labels, including “Support staff,” in visible and accessibility text. Retain owner/admin model diagnostics.

### PR 2 — Put completed notes first

**Findings:** F1, F9. **Estimate:** 2–3 days.

For completed recordings, use this order:

1. Patient title, processing status and compact identity context.
2. Unresolved metadata attention, quality warnings and partial-generation notices.
3. SOAP/Transcript switch, note heading and existing copy action.
4. Suggested Tasks.
5. Export actions.
6. Audio disclosure, collapsed initially.
7. Tools.

Implementation details:

- Keep client, species, visit date and available Patient ID readily visible. Put the remaining identity fields behind the existing disclosure pattern.
- Replace the ordinary edit-details card with a compact action that opens the existing metadata editor.
- Keep unresolved review/add-details cards prominent. Preserve attention deep links and scroll targets.
- Move ordinary Regenerate SOAP into Tools. Keep the contextual repair action on a partial-generation warning.
- Mount the existing audio player when its disclosure opens; preserve playback/download permissions, recorder-ownership guards and cancellation cleanup.
- Leave draft, failed, pending-metadata and processing remediation flows intact.

For SOAP sections:

- Replace singleton expansion state with independent section state.
- Start with Subjective expanded.
- Opening Objective, Assessment or Plan must leave other expanded sections open.
- Preserve section drafts across collapse/reopen, stable component identity during refetch, save feedback and every dirty/save-in-flight exit guard.
- Reset reading state when opening a different note.

**Acceptance:** an ordinary completed-note fixture shows Copy All and readable SOAP content without scrolling on the audited Pixel configuration. Attention notices may legitimately occupy space above the note.

### PR 3 — Explain templates and expose export completion

**Findings:** F7, F8. **Estimate:** 1–2 days.

**Template availability**

- Extend `useTemplates` to expose retry/refetch state.
- Thread error, retry and retrying state through Record, `PatientSlotCard` and `PatientForm`, including their memo/dependency wiring.
- Distinguish initial loading; available templates and the known selection/default; successful loading with no available templates; loading failure with Retry.
- Retain cached options and the selected template during a background refresh failure.
- If a saved selection is absent from the available list, explain that it is unavailable; do not silently clear or replace it.
- Use truthful “No template selected” wording when no selection is known. Preserve existing default preferences and template-driven form behavior.

**Export status**

- Show “Marked exported” near the completed-note heading and on completed `RecordingCard` rows.
- Reuse existing `isExported` data; server source already supplies it in list responses.
- Treat absent legacy values as unknown/unmarked, never as confirmed delivery.
- Update `RecordingCard`’s memo comparison so an export-state change renders immediately.
- After successful explicit marking, use the returned SOAP response and existing cache mechanisms to refresh the note, detail, recent rows and recording lists.
- Preserve error feedback when marking fails.
- Copying, opening a share sheet and cancelling a share must leave the export marker unchanged.

No human review status or export queue is introduced.

### PR 4 — Add read-only recovery audio preview

**Finding:** F5. **Estimate:** 2–3 days.

Add “Listen to preview” to each durable-recovery card, with one active preview at a time.

- Use the existing recovery offer and validate its current user, identifiers, local URI and durable path.
- Read at most the first **1 MiB**, bounded by the available complete-frame prefix.
- Reuse the ADTS parser and `writeFilePrefix` to create a temporary AAC preview containing complete frames.
- Reuse `useAudioPlayback`; offer Play/Pause and Stop, with playback limited to **60 seconds** or the available duration.
- Label the duration as a preview. Do not present it as the full recording.
- Use bounded preparation/loading deadlines and retryable error feedback.
- Do not fall back to loading or copying the whole source after a preview failure.

Preservation rules:

- Preview must not restore a draft, remove an offer, upload, purge, discard or modify source audio/manifests.
- Avoid the manifest bridge’s legacy-proof hydration path during preview; it can write metadata.
- Disable playback while the recorder owns the audio session, including paused recording.
- Stop and release preview on navigation away, backgrounding, app lock, account change, recorder ownership or selection of Restore/Discard.
- Reject late asynchronous results after cancellation or scope changes.
- Store derived previews in the existing transient audio area and delete them through existing safe cleanup functions.
- Keep Restore and Discard as separate explicit actions with their existing behavior.

### PR 5 — Add complete historical ordering and date filtering

**Finding:** F6. **Estimate:** 4–6 days across Connect and Mobile.

**Mobile controls**

- Add “Newest first” and “Oldest first”; default to Newest first.
- Add a Dates sheet with All dates, Today, Yesterday, Last 7 days and Custom range.
- Custom range contains From/Through native date controls and explicit Apply/Cancel.
- Keep status selection independent. Sort/date controls wrap below the full-width status selector.
- Show the active range and a clear-range action.
- Preserve user-selected filters during detail navigation. Retain existing one-shot `status=draft` link behavior.
- Keep preferences in screen state; reset them on account change.
- Recalculate relative presets on refocus/day changes.

**Complete results**

- Send dates and ordering to the server before pagination.
- Convert the server-draft query to pagination; fetch further applicable draft and non-draft pages until both sources are exhausted.
- Apply identical range rules to local drafts, then merge using existing identity and resume-location logic.
- Make regular rows and date-section order follow the selected direction.
- Put matching newly submitted, highlighted rows in a separately labelled “Just submitted” section; deduplicate them from ordinary date groups.
- Include sort and UTC bounds in query/retry keys. Cancel obsolete requests when filters change.
- Persist only the default unsearched, unfiltered, newest-first list variant. Preserve user-scoped cache isolation.
- Distinguish loading/error/partial-source states from an authoritative empty result.

## 3. API, types and compatibility

Extend the existing recording-list contract:

| Addition | Definition |
|---|---|
| `sortBy=activityAt` | Order by `COALESCE(submittedAt, createdAt)` |
| `activityFrom` | Optional inclusive UTC ISO timestamp |
| `activityBefore` | Optional exclusive UTC ISO timestamp |

Require both range bounds together and reject invalid or reversed ranges. Preserve existing list defaults, sort options and response envelopes.

Server implementation:

- Reuse the existing `activityAt` meaning already present in the worklist.
- Add a bounded ordered-ID query for the new legacy-list sort, then fetch the existing projection and restore ID order within the same repeatable-read transaction.
- Use `id ASC` as the timestamp tie-breaker.
- Apply the same date predicate to counts, keyword matching and semantic candidate preparation before ranking.
- Preserve organization, replacement, status, user and joined-patient constraints.
- Update shared query types, service-client forwarding and worklist schema/sort handling. Preserve the list schema’s existing extension relationship.
- Keep existing semantic relevance ordering when semantic search is selected.
- Plan no new database column, backfill or index migration. Capture the query plan against a representative synthetic dataset.

Mobile date semantics:

- Interpret selected days in the device timezone, matching existing row dates.
- Convert From to local midnight and Through to the following local midnight, then serialize both to UTC.
- Advance by calendar day, preserving DST behavior.
- New history requests use `activityAt`; older servers reject that sort. Show an unavailable/error state rather than silently dropping filters or falling back to unfiltered results.

Install only `@react-native-community/datetimepicker` through Expo. SDK 55 specifies **8.6.0**, matching the installed Expo compatibility manifest. Use Android’s imperative picker and the iOS component; update the lockfile and rebuild both platforms. Lazy-load the optional native module so older development clients fail gracefully. [Expo SDK 55 documentation](https://docs.expo.dev/versions/v55.0.0/sdk/date-time-picker/)

## 4. Verification and acceptance

Use executable tests for new decision logic and source guards for wiring. Reuse existing Node/Vitest infrastructure.

| Area | Required scenarios |
|---|---|
| Metadata | Populated conflict with zero applied fields; blank visit; PIMS-only details; whitespace; unchanged review-resolution gates |
| Detail/SOAP | Note-first layout; read-only viewer; attention deep link; partial note; transcript switching; multiple expanded sections; collapse/reopen with dirty text; save failure and save-in-flight exits |
| Recovery | Multiple offers; short recording; torn ADTS tail; missing/unreadable file; wrong user/path; timeout; late completion; active/paused recorder; background/lock; Restore/Discard after listening |
| Templates/export | Empty/loading/failure/cached-failure states; retry; unavailable selection; successful/failed export marking; immediate row update; copy/share cancellation leaves marker unchanged |
| History | More than two pages per source; both directions; tied timestamps; null submission fallback; combined search/status/date; local/server deduplication; cancellation; older-server rejection |
| Dates/cache | Single-day range; month/year boundaries; leap day; DST start/end; exact midnight boundaries; relative preset rollover; default-only persistence; account isolation |

For recovery tests, assert that source bytes, recovery offers, drafts, holds, tombstones and upload state remain unchanged after listening, cancellation and failure.

Run:

- Mobile typecheck, lint and complete Node suite, including existing clipboard, app-lock, expiry, draft-location, attention, font-scaling, layout and SOAP-edit guards.
- Connect focused schema/search/list/worklist tests, isolated PostgreSQL/RLS tests and `pnpm verify`.
- Local Android and iOS builds after adding the picker.
- Current-head required CI checks before merging.

Device acceptance uses synthetic data in the separate local-test app. Cover audited Pixel’s 1.15 font scale/Bold text, a 320 dp phone layout, supported larger text, dark mode, tablet rotation, Android Back and iOS back gestures. Keep production recovery untouched. Save new screenshots outside Git and reference them from implementation notes.

## 5. Rollout and completion

- Deliver five reviewable changes in order above. Earlier mobile improvements can ship independently.
- Deploy and verify additive history API before releasing Mobile history controls.
- Release picker through fresh Android/iOS binaries.
- Use existing monitoring for playback errors, recovery failures, rejected queries and crashes; keep clinical content, search text and local paths out of telemetry.
- Preserve existing clinical, upload, authentication and signing behavior.
- Completion requires every F1–F10 item to have implementation evidence, passing checks and a documented acceptance result.

**Estimated effort:** approximately **12–18 engineering days**, including integration and device verification.

Excluded: template builders, export queues, new review/signing systems, recording-engine rewrites and clinical-accuracy benchmarking. Planning only; no files or device state changed, and no tests were rerun. Main risks are audio ownership during preview and coordinated API/native-build rollout.

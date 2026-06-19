# Record-First AI-Label Audit, Monitoring & Reliability Plan

_Draft — 2026-06-18_

## Context

Staff report the **record-first** flow — record an appointment without filling patient
fields, let AI auto-label patient name, client name, species, breed, and appointment type
from the audio — "doesn't work most of the time." Feature is **activated** for the org
(`recordFirstEnabled` flag on; `record_first` capability present in `/auth/me`), so this
is an **extraction-quality / observability** problem, not a gating problem.

The audit + live PostHog data found the core issue: **the server-side extraction runs but
auto-fills nothing ~80% of the time.** The review card mostly *does* appear (so this is
not crashes/timeouts) — it just shows up with **zero fields filled in**, so staff retype
everything. Measured correction rate is **~80% vs the <5% target (~16× over)**. The fields
get demoted to suggestions (confidence gates 0.85/0.70, verbatim-name guard, multi-patient)
or the extraction model returns weak/empty output. To staff this is "doesn't work."

Goal: (1) explain why it fails, (2) make failures **measurable**, (3) make the flow
**more consistent** and make non-success **visible to staff** so a blank record is never
mistaken for a broken feature.

> **Repo scope note:** the extraction logic and most failure modes live in the **separate
> VetSOAP-Connect backend repo** — those changes cannot be made from this mobile repo and
> are listed as a coordinated server workstream.

---

## How the flow works today (audit map)

- **Gating** — `user.capabilities.includes('record_first')` from `/auth/me`
  (`app/(app)/(tabs)/record.tsx:348`, `recordings/[id].tsx:78`). Server emits capability
  only when org `recordFirstEnabled === true` AND `RECORD_FIRST_KILL_SWITCH !== '1'`.
- **Record UX** — fields become optional, form can start collapsed, hint "AI will fill
  blanks" (`PatientForm.tsx:144-148`, `PatientSlotCard.tsx:264`).
- **Upload** — `uploadSlot()` (`record.tsx:1459-1906`) → `createWithFile`/`createWithSegments`
  → `POST /api/recordings/{id}/confirm-upload`. Blank form fields sent as-is.
- **Extraction** — happens **server-side** after transcription (Connect repo +
  Trigger.dev worker). Timeout `METADATA_EXTRACTION_TIMEOUT_MS = 20_000`. Wrapped in
  try/catch → on any failure logs `AI metadata extraction failed (non-fatal)` and
  **continues** with `aiExtractedMetadata: null`. Confidence gates: names ≥0.85,
  species/breed/appt-type ≥0.70. Below gate, name not verbatim in transcript, or
  `multiplePatientsDetected` → field stays a *suggestion* (in `fields`, not `appliedFields`)
  → **not auto-filled**.
- **Result surfacing** — detail screen polls `GET /api/recordings/{id}` (5s→60s backoff,
  `[id].tsx:98-116`). Review/add/edit card all gate on `status === 'completed'`
  (`[id].tsx:511-528`). (`pending_metadata` status is a Google-Drive-import path,
  unrelated to record-first.)
- **Existing telemetry** — only `ai_metadata_review_shown{applied_field_count}` and
  `ai_metadata_review_resolved{action,corrected_field_count}` (user-side). No event for
  extraction attempted/succeeded/failed/demoted. No Sentry/`reportClientError` for it.

---

## Why it "fails most of the time" (root cause — confirmed by data)

The data overturns the original guess (silent null/no-card). The card mostly *shows*; it's
just **empty**. Ranked by measured impact:

1. **Extraction applies zero fields (DOMINANT).** In **66 of 83** review-shown events the
   AI auto-filled **0 fields** (`applied_field_count=0` = 79.5%). Card appears, every field
   blank → staff retype everything → "AI did nothing." This is the failure staff report.
2. **Server-side demotion is the mechanism.** Fields land in `fields` as *suggestions* but
   not `appliedFields` — confidence below gate (names ≥0.85, others ≥0.70), patient name not
   verbatim in transcript, or `multiplePatientsDetected`. Either gates are too strict for
   real clinic audio, or the extraction model returns low-confidence/empty output.
3. **No measurement of *why* each field was dropped.** `applied_field_count=0` is visible,
   but nothing records which gate (confidence vs verbatim vs multi-patient vs null) killed
   it — so tuning is blind.
4. **Separate upload-reliability issue:** 49 `create_draft` HTTP_500 + 12 `CREATE_DRAFT`
   server failures — recordings that never even reach extraction. Contributes to overall
   "doesn't work" but is a distinct backend bug.

### Live data (measured — PostHog project 391342, 2026-06-13 activation → 06-18)

| Metric | Value |
|---|---|
| Record-first starts (`recording_started_blank_fields`) | **105** (80 with all 4 fields blank) |
| Review cards shown (`ai_metadata_review_shown`) | **83** |
| **Cards with 0 fields auto-filled** | **66 / 83 = 79.5%** ← the core failure |
| Cards with ≥1 field applied | 17 (4-fields: 9, 3: 3, 5: 2, 2: 2, 1: 1) ¹ |
| Review resolved | 54 → **corrected 43 (80%)**, confirmed 11 (20%) |
| Avg fields corrected per corrected review | **2.84** |
| Correction rate vs runbook target | **~80% vs <5% → ~16× over** |
| `submit_failed` (distinct upload bug) | 99; top: `create_draft/HTTP_500` ×49 |

¹ Extraction covers **5** fields — `RecordingMetadataField` = patient name, client name, species,
**breed**, appointment type (`src/types/index.ts:82`) — so `applied_field_count` ranges 0–5. The
form shows **4** to staff (the "all 4 fields blank" count above); breed is auto-fill-only, which is
why the distribution includes a "5" bucket.

Activation confirmed 2026-06-13 (first events that day). `ai_metadata_extraction_observed`
(proposed event) = 0 → not yet deployed, as expected.

> **Bottom line:** the mobile flow works (cards render correctly); the **backend extraction
> is auto-applying almost nothing** (~80% zero-fill, ~80% correction). The fix is primarily
> server-side tuning + per-field *reason* telemetry; the mobile side needs the reason event
> and a clearer "AI couldn't read these — add them" UX.

---

## Plan

> The existing `ai_metadata_review_shown{applied_field_count}` event already proves the
> problem (66/83 zero-fill). Mobile work below makes the *zero-fill* and *why* queryable
> and dashboards/alerts it; the reliability fix itself is mostly server-side (Workstream C).

### Workstream A — Mobile observability (this repo)

1. **Add extraction-outcome event.** In `src/lib/analytics.ts` `AnalyticsEvent` union, add
   `ai_metadata_extraction_observed` with PHI-free props:
   `{ applied_field_count, suggested_field_count, extracted_field_count, multiple_patients_detected, had_metadata: boolean, blank_field_count_at_submit }`.
   Source `multiple_patients_detected` from `recording.aiExtractedMetadata?.multiplePatientsDetected`
   (field already on `AiExtractedMetadata` in `src/types/index.ts:101`, currently unused — this is
   its first consumer; no new server contract needed). `blank_field_count_at_submit` is not stored
   on the completed recording; derive it on render as `appliedFields.length` + count of
   `RecordingMetadataField`s still blank on the recording (a field blank at submit was either
   AI-applied → in `appliedFields`, or still blank now) — fire before any staff review-card edit so
   the count reflects submit state, not post-edit.
   Fire it **once per completed record-first recording** on the detail screen. **Do not** reuse the
   existing review-shown effect at `recordings/[id].tsx:360-379` as-is: that effect early-returns
   `if (!shouldShow || metadataReviewShownIdsRef.current.has(id)) return;`, so it never runs when no
   review card appears — which is exactly the `had_metadata=false` / no-card case this event must
   capture. Fire the observed event on completion **before** the `shouldShow` gate (or in a separate
   effect) with its **own** dedupe `Set` (not `metadataReviewShownIdsRef`, which is only populated
   inside the shouldShow path). Distinguishes the two failure shapes the data shows:
   `had_metadata=false` (no card) vs `applied=0, suggested>0` (card-but-empty, the dominant 80%).
2. **Add an extraction warning phase.** Add `ai_extract` to `ErrorPhase` (`analytics.ts`);
   when a completed record-first recording returns `aiExtractedMetadata: null` OR
   `applied_field_count=0` with blank patient name, fire
   `reportClientError({ phase: 'ai_extract', severity: 'warning', recordingId, ... })`
   (`src/api/telemetry.ts`) → lands in `client_telemetry` keyed by recording, giving an
   org-queryable zero-fill feed without waiting on Connect.
3. **PostHog dashboard + alert (no code).** Insight on `applied_field_count=0` rate over
   `ai_metadata_review_shown`, and `corrected/(corrected+confirmed)` correction rate;
   alert when zero-fill >40% or correction >15% over 24h. (Saved queries below.)
4. **Tests.** Add functional tests (not just structure-regex like
   `tests/record-first-phase4.test.mjs`): null-metadata → observed event `had_metadata=false`;
   suggestions-only → `applied=0, suggested>0`; happy path → applied counted.

### Workstream B — Mobile UX so non-success is visible (this repo)

5. **Surface "AI couldn't fill these" state.** When a completed record-first recording has
   blank patient name and no applied fields, show an explicit prompt (extend
   `MetadataReviewCard` "add" mode, `[id].tsx:516-521`) — "Captivet couldn't read the
   patient details from this recording. Add them here." Turns a silent blank into a clear,
   actionable state, eliminating most "it doesn't work" perception.
6. **Show suggestions even when below auto-fill confidence.** If `fields` has values not
   in `appliedFields`, present them as tappable suggestions in the add/review card so a
   low-confidence-but-correct guess still saves the vet typing.

### Workstream C — Connect backend (separate repo — PRIMARY fix; cannot edit here)

This is where the 80% zero-fill is caused and must be fixed.

7. **Per-field drop-reason telemetry.** For every record-first recording, log per field why
   it was *not* applied: `low_confidence(score) | not_verbatim | multi_patient | null_extraction | timeout`. Without this, tuning is guesswork. Feeds the authoritative dashboard.
8. **Tune the gates (root-cause fix).** The 0.85/0.70 confidence thresholds and the
   strict verbatim-name guard are the prime suspects for mass demotion on real clinic
   audio. Use #7 data to recalibrate: lower thresholds, relax verbatim to fuzzy/contains,
   and re-evaluate the multi-patient block. Target: pull zero-fill rate from ~80% toward
   the <5% correction goal.
9. **Alerting** on zero-fill rate, null-extraction rate, and timeout spikes (>20s) so a
   regression pages someone instead of staff noticing.
10. **Fix the `create_draft` HTTP_500** (49 events) — distinct upload-path server bug that
    blocks recordings before extraction even runs. Triage separately.

---

## Verification

- Unit/functional tests in Workstream A pass (`node --test tests/…`).
- Local E2E on a physical Android (emulator mic can't exercise the upload path — see
  CLAUDE.md): record-first with blank fields → completed → confirm
  `ai_metadata_extraction_observed` fires with correct counts in PostHog debug; force a
  null-metadata response (mock) → confirm `reportClientError` phase `ai_extract` lands in
  `client_telemetry`.
- **Success metric:** after Workstream C tuning, re-run the zero-fill query — target the
  `applied_field_count=0` rate down from **79.5%** and the correction rate down from **80%**
  toward **<5%**. This is the single number that says "it works now."
- Connect alert fires on a synthetic forced failure.

## Monitoring queries (PostHog project 391342, run now & post-fix)

```sql
-- Zero-fill rate (the core KPI). Today: 66/83 = 79.5%.
SELECT countIf(properties.applied_field_count = 0) AS zero_fill,
       count() AS shown,
       round(100.0 * countIf(properties.applied_field_count = 0) / count(), 1) AS pct
FROM events WHERE event = 'ai_metadata_review_shown' AND timestamp >= now() - INTERVAL 14 DAY;

-- Correction rate vs <5% target. Today: 43/54 = 80%.
SELECT properties.action AS action, count() AS c,
       round(avg(toFloat(properties.corrected_field_count)), 2) AS avg_corrected
FROM events WHERE event = 'ai_metadata_review_resolved' AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY action;

-- Upload-path 500s (distinct bug, Workstream C #10). Today: 49 create_draft/HTTP_500.
SELECT properties.error_phase AS phase, properties.error_code AS code, count() AS c
FROM events WHERE event = 'submit_failed' AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY phase, code ORDER BY c DESC;
```

> Note: a PostHog personal API key was pasted into chat during this audit — **rotate it**
> (PostHog → Settings → Personal API keys).

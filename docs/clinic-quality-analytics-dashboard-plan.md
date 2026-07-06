# Clinic Quality Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an all-role Clinic Quality section to the web and mobile dashboards without creating a new dashboard endpoint or storing PHI in the analytics payload.

**Architecture:** Extend the existing all-role `GET /api/organization/dashboard` response with one required `quality` object. The API computes the 30-day aggregates from existing `recordings`, `soap_notes`, `audit_logs`, and persisted `client_telemetry`; web consumes the shared core schema, while mobile parses only the `quality` envelope for rollout safety.

**Tech Stack:** Express + Prisma/Postgres raw SQL + Zod in `VetSOAP-Connect`; Expo Router + React Query + NativeWind + local Zod parsing in `VetSOAP-Mobile`.

---

## Scope And Guardrails

- Keep the existing endpoint: `GET /api/organization/dashboard`.
- Do not add a new dashboard endpoint or DB table in v1.
- Preserve existing `org`/`team` admin-only dashboard sections; only `quality` is all-role.
- Reuse the existing top-level `periodDays: 30`; do not add a second `quality.periodDays`.
- Do not add server-computed `topIssue` in v1. It is underdefined and would need product ranking rules; UI can emphasize non-zero metrics locally.
- `quality` must contain only counts, rates, durations, user display names, user ids, roles, and last recording timestamps. No patient/client names, transcript text, audio paths/keys, cost fields, or SOAP content.
- Use `Prisma.sql` / parameter binding for raw SQL. Do not use `$queryRawUnsafe`.

## Contract

Add these schemas in `VetSOAP-Connect/packages/core/src/schemas/dashboard.schema.ts` and export `QualitySummary`, `QualityProviderSummary`, and `DashboardQuality` inferred types:

```ts
const QualityRateSchema = z.number().nonnegative().nullable();

const QualitySummarySchema = z.object({
  completedRecordings: z.number().int().nonnegative(),
  averageRecordingLengthSeconds: z.number().int().nonnegative(),
  failedUploadAttempts: z.number().int().nonnegative(),
  silentAudioEvents: z.number().int().nonnegative(),
  reprocessCount: z.number().int().nonnegative(),
  reprocessRate: QualityRateSchema,
  soapEditedCount: z.number().int().nonnegative(),
  soapEditRate: QualityRateSchema,
  missingMetadataCount: z.number().int().nonnegative(),
  missingMetadataRate: QualityRateSchema,
  processingLatencyAvgSeconds: z.number().int().nonnegative().nullable(),
  processingLatencyP50Seconds: z.number().int().nonnegative().nullable(),
  processingLatencyP90Seconds: z.number().int().nonnegative().nullable(),
});

const QualityProviderSummarySchema = QualitySummarySchema.extend({
  userId: z.string().uuid(),
  fullName: z.string(),
  role: z.string(),
  lastRecordingAt: z.coerce.date().nullable(),
});

const DashboardQualitySchema = z.object({
  org: QualitySummarySchema,
  me: QualitySummarySchema,
  byProvider: z.array(QualityProviderSummarySchema),
});
```

Then add required `quality: DashboardQualitySchema` to `DashboardStatsSchema`.

Rounding rules:

- Durations and latency values are integer seconds.
- Rates are rounded to 4 decimal places.
- Rates are `null` when their denominator is zero.
- `reprocessRate` may exceed `1` because it counts reprocess actions per completed recording in the same window, and multiple reprocesses can happen for one recording.

## Metric Definitions

All SQL scopes must include `organization_id = ${organizationId}` and the 30-day `since` window. Recording-based metrics must require `recordings.replaced_at IS NULL`.

| Metric | Definition |
|---|---|
| `completedRecordings` | Count of completed recordings created in the window. |
| `averageRecordingLengthSeconds` | Rounded average `recordings.audio_duration_seconds` for completed recordings; `0` when there are no completed recordings. |
| `failedUploadAttempts` | Persisted `client_telemetry` rows in the window with `severity IN ('error', 'warning')` and phase in `('presign', 'r2_put', 'confirm', 'create_draft', 'patch_draft')`. Count only phases that Connect currently persists; do not include mobile-only labels such as `preflight` unless the server enum/route is updated separately. |
| `silentAudioEvents` | Count persisted `client_telemetry.phase = 'silent_check'` rows, plus recording rows in the window whose warning/failure text indicates silent or hard-to-hear audio: `quality_warnings` matching `silent`, `silence`, `quiet`, `low transcript density`, or `difficult to hear`, and `error_code = 'TRANSCRIPTION_FAILED'` with an error message mentioning silent audio. Count each server recording once per branch. |
| `reprocessCount` | Count `audit_logs` rows in the window where `action = 'recordings.reprocessed'`. Provider grouping uses `audit_logs.user_id` because that is the actor who requested the reprocess. |
| `reprocessRate` | `reprocessCount / completedRecordings`, rounded; `null` if `completedRecordings = 0`. |
| `soapEditedCount` | Count SOAP notes joined to non-replaced recordings in the window where any of `subjective`, `objective`, `assessment`, or `plan` JSON has `isEdited = true`. |
| `soapEditRate` | `soapEditedCount / soapNoteCountInWindow`, rounded; `null` if there are no SOAP notes in the window. |
| `missingMetadataCount` | Count non-draft, non-replaced recordings in the window where `status = 'pending_metadata'`, `trim(patient_name) = ''`, or `ai_extracted_metadata->>'review' = 'unconfirmed'`. |
| `missingMetadataRate` | `missingMetadataCount / nonDraftRecordingCountInWindow`, rounded; `null` if there are no non-draft recordings. |
| `processingLatency*Seconds` | `processing_completed_at - processing_started_at` for completed recordings with both timestamps. Use `avg`, `percentile_cont(0.5)`, and `percentile_cont(0.9)`; return `null` when there are no latency samples. |
| `lastRecordingAt` | Per-provider max `recordings.created_at` for non-replaced recordings in the window. |

`org` covers the full organization, including activity from users who are no longer active. `me` covers `req.user!.id`. `byProvider` includes active `users.is_active = true` users in the organization, including users with zero quality activity, sorted by `completedRecordings` desc then `fullName` asc. Do not compute `org` by summing active-provider rows only. Provider grouping uses `recordings.user_id` for recording/SOAP/latency/missing-metadata metrics, `client_telemetry.user_id` for client telemetry metrics, and `audit_logs.user_id` for reprocess actions.

## Tasks

### Task 1: Shared Dashboard Contract

**Files:**

- Modify: `VetSOAP-Connect/packages/core/src/schemas/dashboard.schema.ts`
- Modify: `VetSOAP-Connect/packages/core/src/__tests__/dashboard-stats.test.ts`
- Modify: `VetSOAP-Connect/packages/services/src/api/endpoints/organizations.ts`

- [x] Add `QualitySummarySchema`, `QualityProviderSummarySchema`, and `DashboardQualitySchema`.
- [x] Export `QualitySummary`, `QualityProviderSummary`, and `DashboardQuality` inferred types.
- [x] Add required `quality` to `DashboardStatsSchema`.
- [x] Update the schema comments that currently say only `org`/`team` vary by role: `quality` is always present for all authenticated roles.
- [x] Extend the full dashboard fixture with `quality` and assert the schema round-trips it without stripping fields.
- [x] Add a regression test that a payload missing `quality` is rejected.
- [x] Update the `getDashboardStats()` service-client comment so it does not imply all org-level data is admin-only.

### Task 2: Connect API Aggregation

**Files:**

- Modify: `VetSOAP-Connect/apps/api/src/routes/organization.ts`
- Modify: `VetSOAP-Connect/apps/api/src/routes/__tests__/organization-dashboard.test.ts`

- [x] Add `fetchDashboardQualityStats({ organizationId, userId, since })` near `fetchDashboardAttentionCounts`.
- [x] Keep the helper outside the existing `isAdmin` branch. Veterinarian and support staff callers must still receive `quality.org`, `quality.me`, and `quality.byProvider`.
- [x] Prefer one raw SQL query returning all provider activity rows plus one small active-user query if that keeps the code simple; do not add a materialized table or background job.
- [x] Bind all SQL parameters with `Prisma.sql`.
- [x] Merge `quality` into the existing `Promise.all` and response JSON.
- [x] Keep `Cache-Control: private, no-cache`.
- [x] Update dashboard route tests so the default `$queryRaw` mock covers the new quality query; avoid brittle call-order-only assertions where query text can identify the branch.
- [x] Add tests for veterinarian and `support_staff` receiving non-null quality org/me/provider data.
- [x] Add tests for org scoping, zero-denominator `null` rates, p50/p90 rounding, provider zero rows, and no quality payload PHI/cost fields.

### Task 3: Connect Web Dashboard

**Files:**

- Modify: `VetSOAP-Connect/apps/expo/app/(app)/index.tsx`

- [x] Reuse the existing dashboard React Query call; do not fetch a second endpoint.
- [x] Add a small local `QualityAnalyticsPanel` in this file.
- [x] Render the panel directly after the existing `Recent Recordings` card.
- [x] Show compact org metrics first, then "You", then provider rows.
- [x] Render for `owner`, `admin`, `veterinarian`, and `support_staff`.
- [x] Use existing `AppCard`, `AppStack`, `AppRow`, `AppBadge`, `AppIcon`, and local formatting helpers. No new chart dependency.
- [x] Empty state copy: `No clinic quality data yet.`

### Task 4: Mobile API And UI

**Files:**

- Create: `VetSOAP-Mobile/src/api/qualityAnalytics.ts`
- Create: `VetSOAP-Mobile/src/components/QualityAnalyticsCard.tsx`
- Modify: `VetSOAP-Mobile/src/constants/strings.ts`
- Modify: `VetSOAP-Mobile/app/(app)/(tabs)/index.tsx`
- Create: `VetSOAP-Mobile/tests/quality-analytics.test.mjs`

- [x] In `qualityAnalytics.ts`, call `apiClient.get<unknown>('/api/organization/dashboard')`.
- [x] Parse only `{ periodDays, quality }` with a local Zod envelope schema using `.passthrough()`. Do not parse `recentRecordings` or the full Connect dashboard schema on mobile.
- [x] Export a pure `parseDashboardQualityEnvelope()` helper for the Node test.
- [x] Return `quality: null` when the API lacks `quality` during rollout; malformed present `quality` should throw so bad server data is visible.
- [x] Add `QUALITY_ANALYTICS_COPY` to `src/constants/strings.ts` for title, empty, unavailable, retry, org, you, providers, and metric labels.
- [x] `QualityAnalyticsCard` should render one `Card`, not cards nested inside cards.
- [x] Use existing theme hooks and lucide icons already installed in mobile.
- [x] If rendering `lastRecordingAt`, guard `new Date(value)` with `isNaN(date.getTime())` before any `toLocaleDateString()`/Intl formatting.
- [x] Retry handlers must stay synchronous: `onPress={() => { refetch().catch(() => {}); }}`. Do not pass an async function directly to RN callbacks.
- [x] In Home, add a React Query call enabled by `!!user` and render after the `Recent Recordings` block.
- [x] Missing `quality` shows the unavailable state, not a crash.
- [x] No `console.error` unless gated by `__DEV__`.

### Task 5: Verification

Run focused checks first, then the broader package checks.

Connect:

```bash
pnpm --filter @captivet/core test -- dashboard-stats
pnpm --filter @captivet/api test -- organization-dashboard
pnpm --filter @captivet/expo typecheck
pnpm typecheck
```

Mobile:

```bash
node --test tests/quality-analytics.test.mjs
npm test
npm run typecheck
npm run lint
```

Manual smoke:

- Web owner/admin: Clinic Quality appears under Recent Recordings with org, you, and provider rows.
- Web veterinarian/support_staff: same section appears; existing `org` and `team` dashboard cards remain hidden as before.
- Mobile with new API: card appears under Recent Recordings.
- Mobile against an API response without `quality`: card shows unavailable/retry state and Home does not crash.

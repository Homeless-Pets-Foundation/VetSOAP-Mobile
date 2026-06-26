# Mobile implementation — Reprocess transcription + SOAP with selectable models (Steps 1–7)

**Repo:** `VetSOAP-Mobile` (this repo). **Branch:** `feat/reprocess-model-selection`.
**Spec:** `docs/redo-transcription-soap-model-selection-plan-2026-06-22.md` (the full contract + code
for every step lives there; this doc is the execution checklist + build/test plan + the backend
dependency status). **Connect backend doc:** `docs/redo-transcription-soap-CONNECT-backend-impl-2026-06-23.md`.

## Backend dependency status (read first)

Mobile is **functionally blocked on Connect backend items 1–3, 5, 6**, which live in Connect
**PR #365 (`feat/reprocess-model-selection`)** — **OPEN, NOT merged, NOT deployed to prod**
`api.captivet.com` as of 2026-06-24. CI all green; reviewed by Codex over 7 passes with outstanding
P1/P2 findings (RLS on `recording_cost_history`, force-retranscribe on completed rows, preserve
overrides across retries, usage reports read the ledger, round audio duration, fail-closed billing).

**Implication for testing:** against current prod, `GET /api/organization/ai-models` 404s →
`getOrgAiModels()` rejects → `hasSelectableModels` gate hides the reprocess card. This is the
designed graceful-degrade path (rule 1 / no crash), but it means **full end-to-end reprocess cannot
be exercised until #365 merges + deploys.** Until then mobile testing covers: no regression, detail
screen loads, card correctly hidden, unit tests, typecheck, doctor. E2E (pickers → reprocess →
stepper → completed) is verified once the backend ships, or against a Connect dev server running the
PR branch.

This mobile branch is safe to land independently: the card only appears once the backend returns a
real models payload, so shipping it ahead of the backend shows nothing to users (no half-feature).

## Steps (all code in the spec — section references below)

| Step | File | What | Spec § |
|---|---|---|---|
| 1 | `src/types/index.ts` | `AiModelOption`, `AiModelCategory`, `OrgAiModels` | Step 1 |
| 2 | `src/api/recordings.ts` + `src/lib/aiModels.ts` | `getOrgAiModels()`, `reprocessRecording()`; RN-free helper (`normalizeOrgAiModels`, `hasSelectableModels`, `getCurrentModelLabel`) | Step 2 |
| 3 | `app/(app)/(tabs)/recordings/[id].tsx` | `['orgAiModels']` query, gated `enabled: !!user && canRecordAppointments(user?.role)` | Step 3 |
| 4 | `src/components/ReprocessSheet.tsx` | inline-expandable `Card` (ExportSheet pattern), 2 pickers, mutation mirroring `regenerateMutation` | Step 4 |
| 5 | `app/(app)/(tabs)/recordings/[id].tsx` | render card after audio player, top-level, gated `(completed‖failed) && audioFileUrl && aiModels && hasSelectableModels`; pass `onReprocessStarted` resetting `pollingStartedAtRef` | Step 5 |
| 6 | `src/constants/strings.ts` | `REPROCESS_MODELS_COPY` | Step 6 |
| 7 | `src/lib/analytics.ts` | `recording_reprocessed` event (model/provider ids only, no PHI) | Step 7 |
| test | `tests/ai-models.test.mjs` | transpile-and-import unit tests for `aiModels.ts` | Verification |

## Crash-rule compliance (CLAUDE.md)

- Rule 2/4: all RN callbacks sync; `Haptics.*`/`invalidateQueries` get `.catch(() => {})`.
- Rule 10: `normalizeOrgAiModels` shape-guards the response (no Zod needed).
- Rule 1: query error / 404 → card hidden, no throw.
- UI gotcha: `confirm: 'Reprocess '` trailing space (Android single-word clip); SOAP picker `scrollable`.
- Role gate `canRecordAppointments` (role-only), **not** `canEdit` (author-gated) — non-author vet must reach it.
- `aiModels.ts` is RN-free, `import type` from `'../types'` only (so `.mjs` tests load it).

## Verification plan

1. `node --test tests/ai-models.test.mjs` (or repo test runner) — all green.
2. `npx tsc --noEmit` — clean.
3. `npx expo-doctor` — clean (pre-build hook).
4. Build APK: `cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease --console=plain`.
5. Emulator (prod backend, card hidden expected): install, sign in, open a completed recording →
   no crash, detail renders, **no reprocess card** (backend 404 → gate hides). Confirm graceful.
6. E2E (deferred to backend deploy): completed recording in an org with ≥2 options → card shows,
   pickers default to org defaults, "Currently: …" reflects `costBreakdown`, reprocess → status
   flips non-terminal immediately (202 seed) → stepper → completed; double-tap → card gone; foreign-
   language recording → transcription picker hidden, pinned `nova-3`; `400 INVALID_MODEL` /
   `409 MISSING_PROVIDER_KEY` → onError Alert, no crash.

## Not in scope (per spec §Skipped)

SOAP-only re-run picker, pre-submit cost estimate, per-section Gemini model, per-recording model
memory, distinct "Reprocessing…" stepper label, Zod-parsing the models response.

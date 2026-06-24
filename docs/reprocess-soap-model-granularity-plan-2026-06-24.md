# Reprocess — SOAP model-level selection (granularity upgrade)

Follow-up to the merged reprocess feature (Connect PR #365, mobile branch `feat/reprocess-model-selection`). Four issues raised 2026-06-24:

1. **Title** "Reprocess recording" → "Reprocess Recording" — DONE (mobile `REPROCESS_MODELS_COPY.sheetTitle`).
2. **Select the specific SOAP model**, not just the provider (Gemini 3.1 Pro / 3.5 Flash / GLM-5.2 …). — this plan.
3. **"Currently:" confusion** — it shows the recording's LAST-USED model (`costBreakdown.modelUsed`), not the org default. Decision: relabel to **"Last used:"** (mobile-only). The picker default already = org default.
4. **"Z.ai (GLM-5.2)" label** → should read provider/model split. Subsumed by #2: once the picker is model-level, the SOAP option labels become model names ("GLM-5.2", "Gemini 3.1 Pro"); the provider-blob label disappears.

Decisions (confirmed with owner 2026-06-24): SOAP picker shows **all models of every enabled provider** (key + allow-list filtered), flat chip list. Relabel "Last used:". Build **both** repos.

## Contract change

`GET /api/organization/ai-models` — SOAP category becomes **model-level**:
```jsonc
"soap": {
  "default": "glm-5.2",                 // org's RESOLVED current SOAP model (concrete id)
  "options": [                          // every model of each enabled provider
    { "id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash" },
    { "id": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro" },
    { "id": "glm-5.2", "label": "GLM-5.2" }
    // …all GEMINI_MODEL_OPTIONS for gemini if keyed; ZAI/ANTHROPIC/OPENAI per key
  ]
}
```
`POST /api/recordings/:id/reprocess` — body `soapModel` (concrete id) **replaces** `soapProvider`. Server derives provider from which model enum contains the id. Transcription unchanged (already model-level).

Mobile `OrgAiModels` shape unchanged (`{default, options[]}`) — only the *values* shift provider→model, so `normalizeOrgAiModels`/`hasSelectableModels`/`getCurrentModelLabel` all keep working. `reprocessRecording` sends `{transcriptionModelId, soapModel}`.

## Connect (VetSOAP-Connect) — branch off `origin/main`

Model option source (`packages/core/src/schemas/soap-models.schema.ts`): `GEMINI_MODEL_OPTIONS`, `ZAI_MODEL_OPTIONS`, `ANTHROPIC_MODEL_OPTIONS`, `OPENAI_MODEL_OPTIONS` (each `{id,name,…}`). Provider→options map. `ZAIModelSchema=['glm-5.2']`; gemini ids incl. `gemini-3.5-flash`, `gemini-3.1-pro-preview`, etc.

1. **Migration** `recording_cost`… add `reprocess_soap_model TEXT` (sibling of `reprocess_soap_provider`, `schema.prisma:532-537`) so a reprocess's model survives retry/recovery. RLS: table already covered.
2. **`ai-models` endpoint** (`apps/api/src/routes/organization.ts:2766`): replace SOAP provider-mapping with: for each provider in `SOAP_PROVIDER_OPTIONS` that is allow-listed AND `hasService(provider)`, push its `*_MODEL_OPTIONS` as `{id:model.id,label:model.name}`. Default = resolve org's current concrete SOAP model: non-gemini → `settings.soapModel ?? providerRecommendedModel`; gemini → org gemini default (recommended `gemini-3.5-flash`) — must be one of the emitted options, else first.
3. **Reprocess endpoint** (`recordings.ts:3206` ReprocessSchema, `:3220` handler): `soapModel` optional; derive `soapProvider` from model enum membership; validate model ∈ enabled provider's options (allow-list + key) → `400 INVALID_MODEL`; persist `reprocessSoapModel` (`:3363`); pass `soapModel` in job payload (`:3405`) + retry path (`:1716`). `ensureCanProcessRecordings` still gets derived provider (`:119`).
4. **Job** (`apps/jobs/src/jobs/process-recording.ts`): `ProcessRecordingInput` (`:159`) add `soapModel: z.string().optional()`. At model resolution (`:416-420`): `const overrideModel = payload.soapModel; const effModel = overrideModel ?? soapModel; const effGemini = overrideModel ? undefined : geminiSoapModels;` → `createLLMProvider(provider, key, fb, {model: effModel})` + `llmOptions = effGemini ? {geminiSoapModels: effGemini} : {}`. Forces the chosen model for ALL sections (gemini incl., bypassing per-section). Carry `reprocessSoapModel` in recovery reconstruction (`:283-294`).
5. **Tests**: route — model option expansion, default resolution, `soapModel` validation/derivation, bad model → 400. job — `soapModel` override wins for gemini + non-gemini.

## Mobile (this repo)

- `REPROCESS_MODELS_COPY`: `sheetTitle` DONE; `currentPrefix: 'Last used: '`.
- `src/api/recordings.ts` `reprocessRecording`: send `{transcriptionModelId, soapModel}` (rename `soapProvider`→`soapModel`).
- `ReprocessSheet.tsx`: rename local `soapProvider`→`soapModel`; `soapLabel` already "SOAP note model"; analytics `recording_reprocessed` prop `soap_provider`→`soap_model` (+ `soap_model_changed`).
- `analytics.ts`: update event props.
- No new types; options are still `{id,label}`.
- aiModels.ts unchanged.

## Sequence / deploy

Backend lands + deploys first (mobile reads the new option shape; old provider-shape still renders but with provider chips). Mobile contract (`soapModel`) requires the backend reprocess endpoint to accept it — ship backend, then mobile. Mobile degrades gracefully if endpoint missing (gate hides card).

## Verification

Connect: unit tests + `pnpm typecheck`/lint + `migrate:check`. Mobile: `node --test`, `tsc`, expo-doctor, APK build, phone E2E (pick Gemini 3.1 Pro → reprocess → completes → "Last used: Gemini 3.1 Pro"; pick GLM-5.2 → completes).

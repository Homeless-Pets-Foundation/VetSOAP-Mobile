# Connect backend implementation — Reprocess transcription + SOAP with selectable models

**Repo:** `VetSOAP-Connect` (`~/Projects/VetSOAP-Connect`). This doc lives in the **mobile** repo so
it travels with the mobile plan (`redo-transcription-soap-model-selection-plan-2026-06-22.md`), but
**all code below is written in VetSOAP-Connect.** Every snippet was derived from verified source
(file:line anchors are real as of 2026-06-23).

**This is the BLOCKER work** — mobile (plan Steps 1–7) cannot ship until items 1–3, 5, 6 land and
deploy. Build + deploy this first.

## Path correction (carry back to the mobile plan)

The mobile plan says `GET /api/organizations/ai-models` (plural). The org router is mounted at
**`/api/organization`** (singular) — `app.use('/api/organization', organizationRouter)`. Use
**`GET /api/organization/ai-models`**. The reprocess endpoint stays on the recordings router:
`POST /api/recordings/:id/reprocess`.

## Confirmed facts this build relies on

- **Full BYOK, no platform fallback** (`credential-status.ts:155-161`: "every org must supply its own
  keys… Platform Gemini/Deepgram keys are never consulted"). So Deepgram IS gated by a single
  `ApiKey{ service: 'deepgram' }`; each SOAP provider by its own `ApiKey{ service: <provider> }`.
  Usable = `apiKeys.some(k => k.service === svc && !!k.encryptedKey)`.
- `RecordingStatus` enum (`schema.prisma:23-34`): `draft, uploading, uploaded, transcribing,
  transcribed, generating, retry_scheduled, completed, failed, pending_metadata`. `'uploaded'` is the
  job's allowed entry status (guard `process-recording.ts:507-536` accepts `uploaded|failed|
  retry_scheduled → transcribing`).
- Audio R2 key is stored in `recording.audioFileUrl`; segments in `recording.audioSegmentKeys`
  (`String[]`), normalized for the trigger via `getRetrySegmentKeys()` (`recordings.ts:589`).
- Job trigger pattern (`recordings.ts:1505-1542`): `tasks.trigger('process-recording', payload,
  { idempotencyKey })` then `prisma.recording.update({ data: { triggerJobId: triggerResult.id } })`.
  `triggerJobId` exists (`schema.prisma:525`).
- The job already honors `orgSettings.defaultDeepgramModel` (`process-recording.ts:348-350`); the
  SOAP provider is read from `orgSettings.soapProvider` at `:298`. Both must accept a payload override.
- Org settings live in a JSON column parsed by `OrganizationSettingsSchema` (`organization.schema.ts:182-273`)
  → **the allow-list fields need NO DB migration** (only `RecordingCostHistory` does).

## Deploy order

1. **Migrate** `RecordingCostHistory` (item 6) — `pnpm --filter @captivet/database run migrate:dev --name recording_cost_history`.
2. **Deploy jobs** (item 3 + 6 ledger write). Backward-compatible: new payload fields are optional, so
   in-flight confirm-upload/retry payloads (which omit them) still work.
3. **Deploy api** (items 1, 2, 4). New routes; item 4 is an isolated behavior fix.
4. **Then** ship mobile.

Items 1–3, 5, 6 block mobile. Item 4 (regen-path default) and item 7 (retention docs) do not.

---

## Item 5 — Allow-list fields (no migration; do this first, items 1/2 reference it)

`packages/core/src/schemas/organization.schema.ts` — add two optional fields to
`OrganizationSettingsSchema` (after `soapProvider`, ~`:187`). `null`/absent ⇒ "all enabled".

```ts
// inside OrganizationSettingsSchema = z.object({ ... })
  defaultDeepgramModel: DeepgramModelSchema.default('nova-3-medical'),
  soapProvider: SoapProviderSchema.default('gemini'),
  // NEW — per-org allow-lists. Absent/empty handling: treat `undefined` as "all".
  allowedDeepgramModels: z.array(DeepgramModelSchema).optional(),
  allowedSoapProviders: z.array(SoapProviderSchema).optional(),
```

No prisma change — `organization.settings` is JSON; `OrganizationSettingsSchema.parse()` already gates
reads. (Surfacing these in the web settings UI is separate Connect-web work, out of scope here; the
fields default to "all" so reprocess works before that UI exists.)

---

## Item 1 — `GET /api/organization/ai-models`

`apps/api/src/routes/organization.ts` (the `organizationRouter`). Mirror the recordings router's
middleware import. **Role-gate with `requireVeterinarian`** (matches mobile's `canRecordAppointments`
and the reprocess endpoint); no billing gate on a config read.

```ts
import { requireVeterinarian } from '../middleware/auth';
import {
  OrganizationSettingsSchema,
  DEEPGRAM_MODEL_OPTIONS,
  SOAP_PROVIDER_OPTIONS,
} from '@captivet/core';
import { readSoapModelForProvider } from '@captivet/services/server';   // same barrel recordings.ts:72 uses

router.get('/ai-models', requireVeterinarian, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organizationId },
      select: {
        settings: true,
        apiKeys: { where: { isActive: true }, select: { service: true, encryptedKey: true } },
      },
    });
    if (!org) { res.status(404).json({ error: 'Organization not found' }); return; }

    const settings = OrganizationSettingsSchema.parse(org.settings ?? {});
    const settingsRecord = settings as unknown as Record<string, unknown>;
    const hasService = (svc: string) =>
      org.apiKeys.some((k) => k.service === svc && !!k.encryptedKey);

    // Transcription: single 'deepgram' BYOK key gates BOTH nova models; then allow-list.
    const allowedDeepgram = settings.allowedDeepgramModels ?? null;
    const transcriptionOptions = hasService('deepgram')
      ? DEEPGRAM_MODEL_OPTIONS
          .filter((o) => !allowedDeepgram || allowedDeepgram.includes(o.id))
          .map((o) => ({ id: o.id, label: o.name }))
      : [];

    // SOAP: per-provider key; gemini is usable on key alone, non-gemini also needs a resolvable model.
    const allowedSoap = settings.allowedSoapProviders ?? null;
    const soapOptions = SOAP_PROVIDER_OPTIONS
      .filter((o) => !allowedSoap || allowedSoap.includes(o.id))
      .filter((o) =>
        hasService(o.id) &&
        (o.id === 'gemini' || readSoapModelForProvider(o.id, settingsRecord) !== undefined))
      .map((o) => ({ id: o.id, label: o.name }));

    // default = configured default if still offered, else first option, else null.
    const pickDefault = (preferred: string, opts: { id: string }[]) =>
      opts.some((o) => o.id === preferred) ? preferred : (opts[0]?.id ?? null);

    res.json({
      transcription: {
        default: pickDefault(settings.defaultDeepgramModel ?? 'nova-3-medical', transcriptionOptions),
        options: transcriptionOptions,
      },
      soap: {
        default: pickDefault(settings.soapProvider ?? 'gemini', soapOptions),
        options: soapOptions,
      },
    });
  } catch (err) { next(err); }
});
```

Matches the mobile `OrgAiModels` shape (`{ transcription, soap }: { default, options[] }`).
`readSoapModelForProvider` is imported from **`@captivet/services/server`** — the same barrel
`recordings.ts:72` already pulls it from (defined in
`packages/services/src/organizations/server/merge-settings.ts:259`).

---

## Item 2 — `POST /api/recordings/:id/reprocess`

`apps/api/src/routes/recordings.ts`. Add near the `regenerate-soap` / `retry` handlers. Schema +
imports at top of file:

```ts
import { DeepgramModelSchema, SoapProviderSchema, OrganizationSettingsSchema } from '@captivet/core';
import { readSoapModelForProvider } from '@captivet/services/server';
import type { RecordingStatus } from '@captivet/database';   // re-exports the Prisma enum (see recover-stuck-recordings.ts:3)

const ReprocessSchema = z
  .object({
    transcriptionModelId: DeepgramModelSchema.optional(),
    soapProvider: SoapProviderSchema.optional(),
  })
  .strict();
```

Handler — the 8 ordered steps from the plan's §0b, auth FIRST via middleware:

```ts
router.post(
  '/:id/reprocess',
  requireVeterinarian,        // 1. authorize before any resource/state work
  requireActiveBilling,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 2. parse body (.strict)
      const parsed = ReprocessSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
        return;
      }

      // 3. org-scoped load (no IDOR)
      const recording = await prisma.recording.findFirst({
        where: { id: req.params.id, organizationId: req.user!.organizationId },
      });
      if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }

      // org settings + keys (mirrors regenerate-soap :3238-3250)
      const [org, apiKeys] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: req.user!.organizationId },
          select: { settings: true },
        }),
        prisma.apiKey.findMany({
          where: { organizationId: req.user!.organizationId, isActive: true },
        }),
      ]);
      const settings = OrganizationSettingsSchema.parse(org?.settings ?? {});
      const settingsRecord = settings as unknown as Record<string, unknown>;
      const hasService = (svc: string) =>
        apiKeys.some((k) => k.service === svc && !!k.encryptedKey);

      const transcriptionModelId =
        parsed.data.transcriptionModelId ?? settings.defaultDeepgramModel ?? 'nova-3-medical';
      const soapProvider = parsed.data.soapProvider ?? settings.soapProvider ?? 'gemini';

      // 4. validate against allow-list — fail closed
      const allowedDeepgram = settings.allowedDeepgramModels ?? null;
      const allowedSoap = settings.allowedSoapProviders ?? null;
      if (
        (allowedDeepgram && !allowedDeepgram.includes(transcriptionModelId)) ||
        (allowedSoap && !allowedSoap.includes(soapProvider))
      ) {
        res.status(400).json({
          error: 'That model is not available for your organization.',
          code: 'INVALID_MODEL',
        });
        return;
      }

      // 5. provider-key + model-resolution check (no silent fallback)
      if (!hasService('deepgram')) {
        res.status(409).json({
          error: 'No Deepgram API key configured. Add one in Settings → API Keys.',
          code: 'MISSING_PROVIDER_KEY',
        });
        return;
      }
      const soapModelResolves =
        soapProvider === 'gemini' ||
        readSoapModelForProvider(soapProvider, settingsRecord) !== undefined;
      if (!hasService(soapProvider) || !soapModelResolves) {
        res.status(409).json({
          error: `No usable ${soapProvider} configuration. Check Settings → API Keys.`,
          code: 'MISSING_PROVIDER_KEY',
        });
        return;
      }

      // 6. audio gate (re-transcription needs the source audio, not a transcript)
      if (!recording.audioFileUrl) {
        res.status(409).json({ error: 'Recording has no audio to reprocess.', code: 'NO_AUDIO' });
        return;
      }

      // 7. atomic claim + capture prior terminal status (txn). The conditional updateMany is the
      //    gate: count===1 ⇒ we won; two concurrent reprocess calls cannot both claim.
      const claim = await prisma.$transaction(async (tx) => {
        const current = await tx.recording.findUnique({
          where: { id: recording.id },
          select: { status: true },
        });
        const { count } = await tx.recording.updateMany({
          where: { id: recording.id, status: { in: ['completed', 'failed'] } },
          data: { status: 'uploaded', processingStartedAt: null },
        });
        return { count, prior: current?.status };
      });
      if (claim.count !== 1) {
        res.status(409).json({
          error: 'Recording is already being processed.',
          code: 'ALREADY_PROCESSING',
        });
        return;
      }
      const priorStatus = claim.prior as RecordingStatus;   // 'completed' | 'failed'

      // 8. trigger with a FRESH idempotency key (reusing one dedupe-drops the job). Full payload
      //    reconstructed from the row + the two overrides. Roll back to the captured prior status on
      //    enqueue failure — NEVER blanket 'failed' (a 'completed' row still has a valid SOAP note).
      try {
        const triggerResult = await tasks.trigger(
          'process-recording',
          {
            recordingId: recording.id,
            organizationId: req.user!.organizationId,
            audioFileKey: recording.audioFileUrl,
            segmentKeys: getRetrySegmentKeys(recording.audioSegmentKeys),
            patientName: recording.patientName,
            clientName: recording.clientName ?? undefined,
            species: recording.species ?? undefined,
            breed: recording.breed ?? undefined,
            appointmentType: recording.appointmentType ?? undefined,
            templateId: recording.templateId ?? undefined,
            foreignLanguage: recording.foreignLanguage,
            transcriptionModelId,
            soapProvider,
          },
          { idempotencyKey: `process-${recording.id}-reprocess-${Date.now()}` },
        );
        await prisma.recording.update({
          where: { id: recording.id },
          data: { triggerJobId: triggerResult.id },
        });
      } catch (enqueueErr) {
        await prisma.recording
          .update({ where: { id: recording.id }, data: { status: priorStatus } })
          .catch(() => {});
        throw enqueueErr;   // → 5xx via the route error handler
      }

      // 9. respond 202 + the updated recording (mobile seeds its cache; poller starts, no refetch race)
      const updated = await prisma.recording.findUnique({ where: { id: recording.id } });
      res.status(202).json(updated);
    } catch (err) {
      next(err);
    }
  },
);
```

Notes:
- `getRetrySegmentKeys` already exists in this file (`:589`) — reuse, don't re-implement.
- The in-txn `findUnique` reads `prior` under the same read-committed snapshot as the conditional
  update; `count===1` guarantees `prior ∈ {completed, failed}`.
- `processingStartedAt: null` clears the stale timestamp from the prior run (optional but tidy; the
  job sets it again at its Step-1 guard).

---

## Item 3 — Extend the `process-recording` job

`apps/jobs/src/jobs/process-recording.ts`.

**(a) Input schema** (`ProcessRecordingInput`, `:156-168`) — add two optional fields + imports:

```ts
import { DeepgramModelSchema, SoapProviderSchema } from '@captivet/core';

const ProcessRecordingInput = z.object({
  // …existing fields…
  foreignLanguage: z.boolean().default(false),
  transcriptionModelId: DeepgramModelSchema.optional(),   // NEW
  soapProvider: SoapProviderSchema.optional(),            // NEW
});
```

**(b) SOAP provider** (`:298`) — let the payload override the org default:

```ts
// was: soapProvider = orgSettings.soapProvider ?? 'gemini';
soapProvider = payload.soapProvider ?? orgSettings.soapProvider ?? 'gemini';
```

This flows through the existing BYOK key check (`:298-328`, `MISSING_LLM_KEY`) and SOAP resolution
(`:366-371`) unchanged — so a chosen-but-keyless provider still fails closed there too (defense in
depth behind the endpoint's item-2 step-5 check).

**(c) Deepgram model** (`:348-350`) — payload override wins, even over the language default:

```ts
const deepgramModel =
  payload.transcriptionModelId
  ?? (foreignLanguage ? 'nova-3' : (orgSettings.defaultDeepgramModel ?? 'nova-3-medical'));
const deepgramLanguage = foreignLanguage ? 'multi' : 'en';
```

⚠️ **Edge to decide (not blocking):** `deepgramLanguage` stays `'multi'` for `foreignLanguage`
recordings. If a user overrides to `nova-3-medical` on a foreign-language recording, Deepgram may
reject `nova-3-medical + multi`. Either (a) mobile hides the transcription picker when
`recording.foreignLanguage` (simplest), or (b) the job clamps to `'nova-3'` when `foreignLanguage`.
Recommend (a) — leave the job honoring the explicit choice. Flag for the mobile side.

No guard change (`:507-536` already allows `uploaded → transcribing`).

---

## Item 4 — Honor `defaultDeepgramModel` in the regen path (non-blocker)

`apps/api/src/routes/recordings.ts:3643-3645` still hardcodes by language. For consistency with the
job:

```ts
// was: recording.foreignLanguage ? 'nova-3' : 'nova-3-medical'
const regenDeepgramModel = recording.foreignLanguage
  ? 'nova-3'
  : (orgSettingsForRegen.defaultDeepgramModel ?? existingNote?.transcriptionModel ?? 'nova-3-medical');
```

Isolated; ship anytime. Not required for reprocess (reprocess runs through the job, which already
honors the default).

---

## Item 6 — `RecordingCostHistory` ledger (REQUIRED; paid action)

**Model** — `packages/database/prisma/schema.prisma` (mirror `RecordingEmbedding` `:600-621`):

```prisma
model RecordingCostHistory {
  id String @id @default(uuid())

  recordingId String    @map("recording_id")
  recording   Recording @relation(fields: [recordingId], references: [id], onDelete: Cascade)

  organizationId String       @map("organization_id")
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  transcriptionModel     String? @map("transcription_model")
  soapModel              String? @map("soap_model")
  transcriptionCostCents Int     @default(0) @map("transcription_cost_cents")
  generationCostCents    Int     @default(0) @map("generation_cost_cents")
  totalCostCents         Int     @default(0) @map("total_cost_cents")

  createdAt DateTime @default(now()) @map("created_at")

  @@index([organizationId, createdAt])
  @@index([recordingId])
  @@map("recording_cost_history")
}
```

Add back-relations:
- `Recording` model: `recordingCostHistory RecordingCostHistory[]`
- `Organization` model: `recordingCostHistory RecordingCostHistory[]`

**Migration:** `pnpm --filter @captivet/database run migrate:dev --name recording_cost_history`
(creates `prisma/migrations/<ts>_recording_cost_history/migration.sql`). Deploy with `migrate:deploy`.

**Write the ledger row** in the job, inside the existing SoapNote upsert `$transaction`
(`process-recording.ts:~1407-1438`), right after `tx.soapNote.upsert(...)`:

```ts
await tx.recordingCostHistory.create({
  data: {
    recording: { connect: { id: recordingId } },
    organization: { connect: { id: organizationId } },
    transcriptionModel,                    // already in scope (cost fields block)
    soapModel: soapContent.modelUsed,
    transcriptionCostCents,
    generationCostCents,
    totalCostCents,
  },
});
```

Every run (initial + each reprocess) appends a row; usage/billing reports read the ledger, not just
the latest `SoapNote`. This is what makes repeated paid reprocessing auditable — ship before enabling
the feature.

---

## Item 7 — Audio retention (docs only)

Reprocess needs the source audio in R2 (`recording.audioFileUrl`). If lifecycle GC removed it, the
job 404s on download → `failed`. The endpoint's `audioFileUrl` gate (item 2 step 6) is necessary but
not sufficient (the column can be set while the object is gone). Document the retention window in the
Connect ops/runbook so "reprocess an old recording" failures read as expected, not a bug. No code.

---

## Tests (Connect)

- **Route unit** (`apps/api/src/routes/__tests__/`, mirror `organization-settings.test.ts` /
  `api-keys-validate.test.ts` express-app pattern):
  - `ai-models`: org with deepgram + gemini keys → both categories populated; no deepgram key →
    transcription `options: []`, `default: null`; allow-list narrows; default filtered-out → first
    option; non-vet role → 403.
  - `reprocess`: happy path → 202 + status `'uploaded'`; bad model → 400 `INVALID_MODEL`; missing key
    → 409 `MISSING_PROVIDER_KEY`; no audio → 409 `NO_AUDIO`; recording already `transcribing` → 409
    `ALREADY_PROCESSING`; non-author vet → allowed; enqueue-throws → status rolled back to prior.
- **Job** (`apps/jobs/src/jobs/__tests__/`, mirror `security-regressions.test.ts`): payload
  `transcriptionModelId`/`soapProvider` override the org defaults; omitted → falls back to defaults
  (backward-compat); ledger row created per run.
- `pnpm --filter @captivet/database run migrate:check` validates the migration against the shadow DB.

---

## Carry back to the mobile plan

1. **Path:** `/api/organization/ai-models` (singular), not `/api/organizations/...`. Fix Step 0a,
   Step 2 (`getOrgAiModels`), Step 3 note, Backend item 1.
2. **Foreign-language transcription override:** hide the transcription picker when
   `recording.foreignLanguage` (item 3 edge), OR accept the documented Deepgram-rejection risk.
3. Error codes mobile should branch on: `400 INVALID_MODEL`, `409 MISSING_PROVIDER_KEY`,
   `409 NO_AUDIO`, `409 ALREADY_PROCESSING`. (`REPROCESS_MODELS_COPY` already covers `invalidModel`;
   the others fall through to the generic failure Alert — acceptable.)

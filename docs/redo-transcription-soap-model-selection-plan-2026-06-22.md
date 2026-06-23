# Redo Transcription + SOAP with selectable AI models — recording detail screen

## Context

Goal: on an existing recording, let the user **re-run transcription AND SOAP-note
generation**, choosing a **transcription model** and a **SOAP-note model**. Each picker
**defaults to the organization's configured default** and offers **only the models the
organization has enabled**. Server re-validates the chosen values (client lists are a
convenience, not the trust boundary).

This is a **cross-repo** feature. Backend = `VetSOAP-Connect` (TS monorepo at
`~/Projects/VetSOAP-Connect`; `apps/api`, `apps/jobs`, `packages/core`, `packages/database`).
Mobile = this repo. Both hit prod API `api.captivet.com`. The contract below was read from
Connect source (real file:line refs) and **hardened against a 4-lens adversarial review**
(architecture, mobile state/races, backend feasibility, mobile UI). The backend pieces are
**net-new and block mobile** — see §"Backend (Connect) work required".

### Scope decisions locked to the stated goal (review push-back rejected)

The review argued three reversals; all **rejected** because they contradict the explicit goal —
noted here so they're on record, not silently ignored:

- **Keep the combined "re-transcribe + regenerate SOAP" flow as primary.** Review wanted
  SOAP-only-regen (cheaper) as the headline. Goal says redo **both**. SOAP-only stays a documented
  follow-up (§Skipped).
- **Default each picker to the org default, not the recording's last-used model.** Goal: "default
  … whatever the organization's default model is listed as." Last-used shown as a muted hint only.
- **Ship on mobile.** Review called it web-first power-user scope creep. Goal targets this mobile
  app. Mobile it is.

### What exists today

**Mobile** (`VetSOAP-Mobile`):

- `recordingsApi.regenerateSoap(id, { templateId })` → `POST /api/recordings/{id}/regenerate-soap`
  (`src/api/recordings.ts`); body = `templateId` only, **no model param**. Wired via
  `confirmRegenerate()` (`app/(app)/(tabs)/recordings/[id].tsx:241-263`), confirm `:325-340`,
  button `:1017-1028` (gated on `recordingPermissions.canEdit`), partial-SOAP card `:950-954`.
  Its mutation `onSuccess` does `queryClient.removeQueries({ queryKey: ['soapNote', id] })` +
  `invalidateQueries(['recording', id])` (`:243-252`) — **copy this exactly** (the review caught
  that omitting `removeQueries` leaves the stale SOAP on screen during reprocess).
- `recordingsApi.retry(id)` → `POST /api/recordings/{id}/retry`, no params.
- `Recording.costBreakdown` (`src/types/index.ts:18-24`) carries **read-only** `modelUsed`
  (SOAP — may be a provider id *or* a model string), `transcriptionModel`, `modelsUsed`.
- Status polling (`src/api/recordings.ts:104-126`): `refetchInterval` returns `false` once status
  is terminal; auto-polls while status ∈ `['uploading','uploaded','transcribing','transcribed',
  'generating']`, backoff 5s→60s, stops after 30 min. `ProcessingStepper.tsx` renders steps. **Note
  `'uploaded'` is a polled, non-terminal status** — this matters for the status-reset choice below.
- `/auth/me` (`src/auth/AuthProvider.tsx:805`) maps `User` with `capabilities?: string[]`
  (`src/types/index.ts:207`); mobile's `User` type has **no `organization` field** — it does not
  currently capture `organization.settings` even though the server sends it.
- **Role helper already exists:** `canRecordAppointments(user?.role)`
  (`src/lib/recordingPermissions.ts`) = exactly `{owner, admin, veterinarian}`, **role-only, not
  author-gated** — matches the server's `requireVeterinarian`. (Used by the suggested-tasks plan
  for the same reason.) `recordingPermissions.canEdit` is `isPrivileged || (veterinarian &&
  isAuthor)` — **author-gated**, so it wrongly hides the action from a non-author vet. Use
  `canRecordAppointments`, **not** `canEdit`.
- House sheet pattern = **inline-expandable `Card`**, not a modal. `ExportSheet.tsx` toggles an
  internal `useState` and renders a `Card` inline; there is **no bottom-sheet/modal library** in
  the repo. `ReprocessSheet` must follow this (no `visible`/`onClose` modal props, no new dep).
- `SegmentedControl` (`src/components/ui/SegmentedControl.tsx`) takes `options: {label,value}[]`
  and has a `scrollable` prop; default is `flex-wrap` (4 long provider labels truncate/wrap on
  narrow Android — pass `scrollable` for the SOAP picker).

**Backend** (`VetSOAP-Connect`) — model config **partially exists; re-transcription does not**:

- **SOAP = provider-based, per-org configurable ✓.** `org.settings.soapProvider`
  (`packages/core/src/schemas/organization.schema.ts:187`, enum
  `SoapProviderSchema = ['gemini','openai','anthropic','z_ai']` `:47`, default `'gemini'`).
  User-facing list `SOAP_PROVIDER_OPTIONS` (`:47-57`, has `name`). Concrete model resolved
  **server-side**: `readSoapModelForProvider(provider, settings)`
  (`packages/core/.../merge-settings.ts:259-269`) reads `org.settings.soapModel` for non-Gemini
  (validated per provider) and **returns `undefined` if unset/invalid**; Gemini uses per-section
  `soapModels`. Regen resolution at `apps/api/src/routes/recordings.ts:3248-3329` (`:3326`).
  → **Mobile picks the provider; backend resolves the model.** "SOAP note model" in the UI = provider.
- **Transcription = Deepgram; default exists but is NOT honored ✗.**
  `org.settings.defaultDeepgramModel` (`organization.schema.ts:186`, enum
  `['nova-3-medical','nova-3']` `:24`, default `'nova-3-medical'`), list `DEEPGRAM_MODEL_OPTIONS`
  (`:32-45`). The pipeline **hardcodes by language** and never reads the org default:
  `foreignLanguage ? 'nova-3' : 'nova-3-medical'` (`recordings.ts:3644-3645`, and the job at
  `apps/jobs/src/jobs/process-recording.ts` ~`:348-350`).
- **`/auth/me` returns the full org settings blob** (`apps/api/src/routes/auth.ts:252-280`,
  `organization.settings`) — defaults are on the wire; mobile just doesn't read them.
- **No endpoint re-transcribes a completed recording.** `regenerate-soap` reuses the existing
  transcript (gate "must already have a transcript" → 409, `recordings.ts:3218-3224`; body
  `{ templateId?, section?, detailLevel? }` `:3070-3086`; guard `requireVeterinarian +
  requireActiveBilling` `:3193-3196`). `retry` (`:1583`, gates `:1598-1609`) only accepts
  `failed`/`retry_scheduled`/stale-`uploaded` and takes no params.
- **The real transcription engine** is the `process-recording` trigger.dev job
  (`apps/jobs/src/jobs/process-recording.ts`): downloads audio from R2 → Deepgram → SOAP → costs.
  Its Step-1 status guard (`~:507-536`) atomically transitions **only**
  `['uploaded','failed','retry_scheduled'] → 'transcribing'`; a `'completed'` recording **fails the
  guard and the job silently returns `{ skipped: true }`**. It checks BYOK provider keys exist
  before transcription/SOAP (`~:267-328`) → `PipelineError('MISSING_LLM_KEY')` → `failed` if absent.

### The gaps (why this needs backend work, and the non-obvious traps)

1. **Re-transcription of a completed recording is net-new.** Neither `retry` nor `process-recording`
   accepts a `completed` recording. **Trap (from review):** resetting status to `'transcribing'`
   then re-triggering the job makes the job's guard find 0 rows (status not in its allowed set) →
   silent `{ skipped: true }` → recording hangs. **Resolution:** the reprocess endpoint resets
   status to **`'uploaded'`** (which IS in the job's allowed set *and* is a polled non-terminal
   status on mobile), then triggers the job with model overrides; the job legitimately does
   `uploaded → transcribing`. No job-guard change needed.
2. **Status-flip race (critical).** A bare `204` + `invalidateQueries(['recording', id])` refetches
   *before* the backend has flipped status → mobile sees `'completed'` → poller stays off → the run
   happens silently and the user stares at the old note. **Resolution:** endpoint writes
   `status='uploaded'` **synchronously before responding** and returns **`202` + the updated
   `Recording`**; mobile seeds the cache with `setQueryData(['recording', id], updated)` so polling
   starts immediately on the known non-terminal status. (This reverses an earlier "204" choice.)
3. **Options are global, not per-org-restricted.** `DEEPGRAM_MODEL_OPTIONS` (2) / `SOAP_PROVIDER_OPTIONS`
   (4) are global; only the *default* is per-org. The goal says "only the models the org has
   enabled," so a per-org **allow-list is REQUIRED** to actually meet the goal (promoted from
   "optional" — see Backend item 5), **and** options must be filtered to providers the org has a
   **BYOK key** for (else the UI offers a provider whose job will fail late — Backend item 1).
4. **Provider chosen but unusable.** If the picked provider has no key, or `readSoapModelForProvider`
   returns `undefined`, the job fails late with a generic error. **Resolution:** validate at the
   endpoint and **fail closed with `409 MISSING_PROVIDER_KEY`** before triggering (Backend item 2).
5. **Concurrency.** Two reprocess taps can enqueue two jobs; the second silently no-ops (loses the
   user's second choice). **Resolution:** the endpoint's `status ∈ {completed,failed}` gate rejects
   the second call with `409` while the first is in flight (Backend item 2), and the mobile entry
   gate hides the button once status goes non-terminal (Step 5).
6. **Cost/audit overwrite.** Re-running overwrites `SoapNote` cost fields, erasing the prior run's
   cost from history. **Resolution:** append-only `RecordingCostHistory` (Backend item 6, recommended).
7. **Audio retention.** Reprocess needs the source audio in R2; if lifecycle GC removed it, the job
   404s → recording `failed`. Gate on `audioFileUrl` (necessary but not sufficient); document the
   window (Backend item 7).

### Decisions

- **One combined flow.** Re-transcription always cascades to SOAP regen. UI = single inline
  **Reprocess** card, two pickers (transcription model, SOAP provider). Submit re-transcribes → SOAP.
- **Defaults = org defaults** (per goal). Last-used (`costBreakdown`) shown as a muted "Currently: …".
- **SOAP "model" = provider**; backend resolves the concrete model.
- **Role gate = `canRecordAppointments(user?.role)`** (role-only owner/admin/vet, matches server
  `requireVeterinarian`) — **not** `canEdit` (author-gated).
- **Inline `Card`, not a modal** (house pattern). **No new dependency.**

## Step 0 — Contract (RESOLVED against Connect source; backend pieces are NEW)

### 0a. Model options + defaults — `GET /api/organizations/ai-models` (NEW, Backend item 1)

Org-scoped, auth-gated. Derives from the global constants + org settings, **filtered to providers
the org has a BYOK key for**, **narrowed by the per-org allow-list** (Backend item 5). Maps
`name`→`label`. Returns:

```json
{
  "transcription": {
    "default": "nova-3-medical",
    "options": [
      { "id": "nova-3-medical", "label": "Nova 3 Medical" },
      { "id": "nova-3",         "label": "Nova 3" }
    ]
  },
  "soap": {
    "default": "gemini",
    "options": [
      { "id": "gemini",    "label": "Gemini (Google)" },
      { "id": "anthropic", "label": "Claude (Anthropic)" }
    ]
  }
}
```

- `transcription.default` = `org.settings.defaultDeepgramModel`; `soap.default` =
  `org.settings.soapProvider`. **If the default provider has no key / isn't allow-listed, set
  `default` to the first available option** so the UI never pre-selects an unusable value.
- `options` excludes providers without a configured BYOK key and anything outside the allow-list.
  An empty/one-item category renders read-only or hidden on mobile (Step 4).
- `default` is always one of `options[].id` (server guarantee; mobile re-checks defensively).
- React-query cacheable, org-stable. Kept off `/auth/me` to preserve its lean cached-profile
  fallback (rule 1) and because the option lists + key/allow-list filtering aren't in `org.settings`.

### 0b. Reprocess endpoint — `POST /api/recordings/{id}/reprocess` (NEW, Backend item 2)

Body `.strict()`: `{ "transcriptionModelId": "nova-3", "soapProvider": "anthropic" }` (both
optional → org default; mobile always sends both). The handler MUST, in order:

1. **Authorize first, before any resource-specific work:** `requireVeterinarian +
   requireActiveBilling` (same as `regenerate-soap`). Running auth ahead of the load/status/audio
   and model/provider-key checks means an unauthorized same-org user gets a uniform authorization
   failure and **cannot probe recording state or AI-provider config** from differing
   404/409/400 responses.
2. Load the recording **org-scoped** (`where: { id, organizationId: req.user.organizationId }`) →
   404 if not found (copy `regenerate-soap` `recordings.ts:3206-3224`; no IDOR).
3. Validate `transcriptionModelId` ∈ `DeepgramModelSchema` and `soapProvider` ∈ `SoapProviderSchema`
   **and** against the org allow-list → **`400 INVALID_MODEL`**. Fail-closed; never trust the client.
4. Verify the chosen provider has a BYOK key, and that `readSoapModelForProvider(soapProvider,
   settings)` (or Gemini's `soapModels`) resolves a model → **`409 MISSING_PROVIDER_KEY`** if not.
   No silent fallback.
5. Require `recording.audioFileUrl` present → `409` if missing (re-transcription needs source
   audio — NOT a transcript; differs from `regenerate-soap`).
6. **Atomically claim the recording — this is the gate, not a prior read.** Issue a single
   conditional update: `UPDATE recordings SET status='uploaded' WHERE id=:id AND organizationId=:org
   AND status IN ('completed','failed')` and require **exactly one affected row**. If zero rows, the
   recording is already mid-pipeline (a concurrent reprocess won the claim, or it's processing) →
   **`409`**. This makes the status check and the write a single atomic step, so two concurrent
   `POST /reprocess` calls cannot both pass and enqueue duplicate jobs (a read-then-write gate
   would race). `'uploaded'` is in the job's allowed-transition set and is polled non-terminal on
   mobile.
7. **Trigger `process-recording`** with `{ transcriptionModelId, soapProvider }` overrides **inside
   a try/catch**. If the Trigger.dev enqueue throws/times out **after** the status write, **roll
   back**: restore `status` to its prior terminal value (or set `'failed'` with an error code) so
   the recording is never stranded in a non-terminal `'uploaded'` state with no job running (which
   mobile would poll as active until the 30-min stale timeout). Then surface a `5xx` to the client.
8. **Respond `202` with the updated `Recording`** (so mobile seeds its cache and polling starts
   without a refetch race). The job then runs `uploaded → transcribing → generating → completed`,
   uses the chosen models (NOT the language hardcode), and writes them into
   `costBreakdown`/`SoapNote.transcriptionModel` + `modelUsed`.

## Step 1 — Types (`src/types/index.ts`)

```ts
export interface AiModelOption { id: string; label: string; }
export interface AiModelCategory { default: string | null; options: AiModelOption[]; }
export interface OrgAiModels { transcription: AiModelCategory; soap: AiModelCategory; }
```

## Step 2 — API methods (`src/api/recordings.ts`) + helper (`src/lib/aiModels.ts`)

```ts
async getOrgAiModels(): Promise<OrgAiModels> {
  const res = await apiClient.get<OrgAiModels>('/api/organizations/ai-models');
  return normalizeOrgAiModels(res);   // shape guard, src/lib/aiModels.ts
},

async reprocessRecording(
  recordingId: string,
  models: { transcriptionModelId?: string; soapProvider?: string }
): Promise<Recording> {                 // 202 returns the updated Recording (seeds the cache)
  recordingIdSchema.parse(recordingId);   // recordingIdSchema from src/lib/validation.ts:28
  return apiClient.post<Recording>(`/api/recordings/${recordingId}/reprocess`, models);
},
```

`src/lib/aiModels.ts` is **RN-free** and uses **`import type`** from `'../types'` only, so the
`.mjs` transpile-and-import tests can load it (mirrors `recording-permissions.test.mjs`; a value
import from `'../types'` would pull RN deps into the vm and break it):

```ts
// src/lib/aiModels.ts — no React Native imports; type-only import from '../types'.
import type { OrgAiModels, AiModelCategory, AiModelOption } from '../types';

function normalizeCategory(raw: unknown): AiModelCategory {
  const c = (raw ?? {}) as { default?: unknown; options?: unknown };
  const options: AiModelOption[] = Array.isArray(c.options)
    ? c.options.filter((o): o is AiModelOption =>
        !!o && typeof (o as any).id === 'string' && typeof (o as any).label === 'string')
    : [];
  const def =
    typeof c.default === 'string' && options.some((o) => o.id === c.default)
      ? (c.default as string)
      : (options[0]?.id ?? null);
  return { default: def, options };
}

export function normalizeOrgAiModels(raw: unknown): OrgAiModels {
  const r = (raw ?? {}) as { transcription?: unknown; soap?: unknown };
  return { transcription: normalizeCategory(r.transcription), soap: normalizeCategory(r.soap) };
}

// Both categories must be usable AND at least one must offer a real choice. Requiring a usable
// default in BOTH prevents the combined reprocess flow from rendering for an org that has, e.g.,
// multiple transcription models but zero usable SOAP providers (after BYOK/allow-list filtering) —
// which would initialize the missing selection to null and submit an unusable request the backend
// would reject.
export function hasSelectableModels(m: OrgAiModels): boolean {
  const transcriptionUsable = m.transcription.options.length >= 1 && m.transcription.default != null;
  const soapUsable = m.soap.options.length >= 1 && m.soap.default != null;
  const anyChoice = m.transcription.options.length > 1 || m.soap.options.length > 1;
  return transcriptionUsable && soapUsable && anyChoice;
}

// "Currently: …" label. costBreakdown values may be a raw id or a model string not in options —
// fall back to the raw value so the subline never renders blank.
export function getCurrentModelLabel(currentId: string | null | undefined, cat: AiModelCategory): string {
  if (!currentId) return '';
  return cat.options.find((o) => o.id === currentId)?.label ?? currentId;
}
```

## Step 3 — Models query (recording detail screen)

```ts
const { data: aiModels } = useQuery({
  queryKey: ['orgAiModels'],
  queryFn: () => recordingsApi.getOrgAiModels(),
  staleTime: 1000 * 60 * 30,
  refetchOnMount: 'always',   // pick up org config changes when reopening a recording
  enabled: !!user && canRecordAppointments(user?.role),   // only roles that can reprocess
});
```

**Gate the fetch by reprocess permission, not just `!!user`.** The models response is filtered by
configured provider keys + allow-list, so it leaks the org's AI-provider configuration; without the
role gate, any signed-in user who opens a recording detail (including roles for which the action is
hidden) would still fetch that metadata. The server's `GET /api/organizations/ai-models` MUST
enforce the **same role** server-side — the client gate is convenience, not the trust boundary.

Flat org-level key, deliberately **not** under `['recording', id]`, so the reprocess
`invalidate`/`setQueryData` on `['recording', id]` (Step 4) leaves the model list cached. If the
query is `undefined`/errors, the entry gate stays hidden (acceptable; no crash).

## Step 4 — Component `src/components/ReprocessSheet.tsx`

**Inline-expandable `Card`** (mirrors `ExportSheet.tsx`), **not** a modal. Owns its expand state.
Pure selection logic stays in `src/lib/aiModels.ts`.

```ts
interface ReprocessSheetProps {
  recordingId: string;
  models: OrgAiModels;
  canManage: boolean;                          // canRecordAppointments(user?.role)
  currentTranscriptionModel?: string | null;   // costBreakdown.transcriptionModel
  currentSoapModel?: string | null;            // costBreakdown.modelUsed
}
```

Behavior:

- Internal `const [expanded, setExpanded] = useState(false)`. Collapsed = the
  "Reprocess with different models" trigger row; expanded = the two pickers + Reprocess/Cancel.
  No `visible`/`onClose` props (house pattern).
- If `!canManage`, render nothing.
- Local state `transcriptionModelId` / `soapProvider` initialized to
  `models.transcription.default` / `models.soap.default` (org defaults — **not** the `current*`
  props, which are display-only via `getCurrentModelLabel`).
- Per category: `options.length > 1` → `SegmentedControl` (**pass `scrollable` for the SOAP
  picker** — 4 long provider labels wrap/truncate on narrow Android otherwise; transcription's 2
  short labels are fine unscrolled). `=== 1` → read-only label. `=== 0` → hide row.
- Muted "Currently: `{getCurrentModelLabel(currentX, models.X)}`" subline when present.
- Body copy states this **replaces the current transcript and SOAP note and runs new processing
  (new cost)** (no cost estimate — §Skipped).
- Mutation mirrors `regenerateMutation` (`[id].tsx:241-252`) **exactly**, incl. the stale-SOAP
  removal and cache seed:

```ts
const mutation = useMutation({
  mutationFn: () => recordingsApi.reprocessRecording(recordingId, { transcriptionModelId, soapProvider }),
  onSuccess: (updated) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    // Drop caches tied to the OLD run: the stale SOAP note AND the suggested-tasks list (those
    // tasks belong to the previous SOAP note; leaving them cached lets a fast reprocess re-enable
    // the disabled tasks query with obsolete Accept/Dismiss rows for the new note).
    queryClient.removeQueries({ queryKey: ['soapNote', recordingId] });
    queryClient.removeQueries({ queryKey: ['recordingTasks', recordingId] });
    queryClient.setQueryData(['recording', recordingId], updated);   // seed non-terminal status → poller starts, no race
    // Invalidate the detail AND the list, mirroring regenerateMutation — without the list
    // invalidation, navigating back shows the recording as "completed" until the list's normal
    // stale/refetch cycle. invalidateQueries returns a Promise: .catch() it (rule 4, no
    // fire-and-forget) since onSuccess is not awaited.
    queryClient.invalidateQueries({ queryKey: ['recording', recordingId] }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
    setExpanded(false);
    trackEvent({ name: 'recording_reprocessed', props: { /* Step 7 */ } });
  },
  onError: (error) => {
    if (error instanceof ApiError && error.code === 'MFA_REQUIRED') return;
    Alert.alert(REPROCESS_MODELS_COPY.sheetTitle,
      error instanceof ApiError ? error.message : REPROCESS_MODELS_COPY.failure);
  },
});
```

- Reprocess button: `disabled={mutation.isPending}`, `loading={mutation.isPending}`. `onClose`/
  Cancel = synchronous `setExpanded(false)`. All RN callbacks are sync wrappers (rules 2/4).
- Reprocessing a recording does **not** touch local `draftStorage` notes (drafts are for unsent
  recordings; a completed recording's local draft, if any, is left as-is).

## Step 5 — Wire into detail screen (`app/(app)/(tabs)/recordings/[id].tsx`)

- Render `ReprocessSheet` **role-gated on `canRecordAppointments(user?.role)`** and only when
  `(recording.status === 'completed' || recording.status === 'failed') && !!recording.audioFileUrl
  && aiModels && hasSelectableModels(aiModels)`. (`ReprocessSheet` self-hides via `canManage`; the
  status/audio/`hasSelectableModels` checks live at the call site.) Once status goes non-terminal
  after submit, this gate hides the action — closing the double-tap window.
- **Placement — do NOT nest it in the completed-only SOAP branch.** The existing Regenerate-SOAP
  button lives inside the `status === 'completed'` SOAP-note block (`:1017-1028`); a `failed`
  recording renders only the failed card, so a reprocess entry there would be **unreachable for the
  explicitly-supported `failed`-with-audio case**. Instead, render the entry in a container shown
  for **both** `completed` and `failed` (e.g. its own card directly under the patient-info/audio
  section, gated by the condition above), so both statuses can reach it. It does not need to sit
  beside Regenerate-SOAP.
- **No new polling code** — the `202` body seeds `status='uploaded'`, the existing poller
  (`recordings.ts:104-126`) + `ProcessingStepper` take over (`uploaded → transcribing → generating
  → completed`; `PROCESSING_STEP_LABELS` `strings.ts:1-14` cover these).
- `user`/`recordingPermissions` already in scope (`useAuth()` `:84`); import
  `canRecordAppointments` from `src/lib/recordingPermissions.ts`.

## Step 6 — Strings (`src/constants/strings.ts`)

Add next to `REGENERATE_SOAP_COPY` (`:261-266`):

```ts
export const REPROCESS_MODELS_COPY = {
  entryButton: 'Reprocess with different models',
  sheetTitle: 'Reprocess recording',
  sheetBody:
    'Choose the transcription and SOAP models, then reprocess. This replaces the current ' +
    'transcript and SOAP note and runs new processing.',
  transcriptionLabel: 'Transcription model',
  soapLabel: 'SOAP note model',
  currentPrefix: 'Currently: ',
  confirm: 'Reprocess ',   // trailing space: prevents Android single-word clipping in flex-row (CLAUDE.md UI gotcha)
  cancel: 'Cancel',
  failure: 'Could not start reprocessing. Please try again.',
  invalidModel: 'That model is not available for your organization.',
} as const;
```

## Step 7 — Analytics (optional, light)

Add to `AnalyticsEvent` in `src/lib/analytics.ts` (beside `soap_regenerated` `:121`). **No PHI** —
model/provider ids only:

```ts
| { name: 'recording_reprocessed'; props: {
    recording_id: string;
    transcription_model: string;
    soap_provider: string;
    transcription_model_changed: boolean;
    soap_provider_changed: boolean;
  } }
```

## Verification

- **Unit** (`tests/ai-models.test.mjs`, transpile-and-import, mirror `recording-permissions.test.mjs`):
  `normalizeOrgAiModels` (null body; missing category; non-array `options`; option missing
  `id`/`label`; `default` not in `options` → first option; empty options → `default:null`),
  `hasSelectableModels` (0/1 → false, 2+ → true; mixed), `getCurrentModelLabel` (null → '';
  id in options → label; id absent → raw id).
- **Typecheck** `npx tsc --noEmit`; **`npx expo-doctor`** before any build.
- **Manual** (emulator per CLAUDE.md WSL2, or `preview-simulator`):
  - Completed recording, org with ≥2 options in a category → action shows; pickers pre-select org
    defaults; "Currently: …" reflects `costBreakdown`; SOAP picker (4 providers) scrolls, no truncation.
  - Change both → Reprocess → card collapses, **status immediately shows non-terminal and the
    stepper starts** (no stale "completed" gap — the 202 body seeded it), old SOAP disappears
    (removeQueries), advances to completed; reopen → transcript/SOAP + `costBreakdown` reflect choices.
  - Tap Reprocess, then immediately try again → action is gone (status non-terminal) — no double job.
  - Org/category with one option → read-only; with provider missing a key → that provider absent
    from options. `failed`-with-audio → action shown; in-progress or no `audioFileUrl` → hidden.
  - **Non-author vet** → action **shows** and works (role-only gate). `support_staff` → hidden.
  - Force `400 INVALID_MODEL` / `409 MISSING_PROVIDER_KEY` → `onError` Alert, no crash.
- **Cross-check on web:** after a mobile reprocess, reload on web — transcript/SOAP + model
  attribution match.

## Backend (Connect) work required (separate repo — BLOCKS mobile)

1. **`GET /api/organizations/ai-models`** (NEW) — `{ transcription, soap }` `{ default, options[] }`
   from `DEEPGRAM_MODEL_OPTIONS`/`SOAP_PROVIDER_OPTIONS` + org defaults (`organization.schema.ts:32-57,
   186-187`), **filtered to providers with a BYOK key** (query the `apiKey` table) and the per-org
   allow-list (item 5). Map `name`→`label`. If the org default is filtered out, set `default` to the
   first remaining option.
2. **`POST /api/recordings/{id}/reprocess`** (NEW) — implement the 8 ordered steps in §0b, in this
   order: **`requireVeterinarian + requireActiveBilling` FIRST** (uniform auth failure, no state
   probing); org-scoped load; validate `DeepgramModelSchema`/`SoapProviderSchema` + allow-list
   (`400`); **provider-key + model resolution check (`409 MISSING_PROVIDER_KEY`)**; `audioFileUrl`
   gate (`409`); **atomic conditional claim** — single `UPDATE … SET status='uploaded' WHERE id=:id
   AND organizationId=:org AND status IN ('completed','failed')` requiring exactly one affected row
   (`409` if zero — prevents the duplicate-job race); trigger `process-recording` with overrides
   **in a try/catch that rolls the status back on enqueue failure**; respond **`202` + updated
   `Recording`**.
3. **Extend the `process-recording` job** (`apps/jobs/src/jobs/process-recording.ts`) to accept
   optional `{ transcriptionModelId, soapProvider }` in its input schema and **use them** in place
   of the language hardcode (`~:348-350`) and the org-default provider. Its existing Step-1 guard
   already allows `uploaded → transcribing`, so no guard change is needed (this is why the endpoint
   resets to `'uploaded'`, not `'transcribing'`).
4. **Honor `org.settings.defaultDeepgramModel`** in the transcription path generally (currently
   ignored, `recordings.ts:3644-3645`) so a no-override reprocess still respects the org default.
5. **Per-org allow-list (REQUIRED to meet the goal, not optional).** Add
   `allowedDeepgramModels?: DeepgramModel[]` + `allowedSoapProviders?: SoapProvider[]` to
   `OrganizationSettings` (`null` = all). Narrow item 1's `options` and item 2's validation to them.
   Without this, every org sees the full global set and the goal's "only the models the org has
   enabled" is **not** met. Mobile needs **zero change** when this ships.
6. **(REQUIRED) Cost-history audit trail.** This feature intentionally creates additional *paid* AI
   runs, and each reprocess **overwrites** the `SoapNote`/model cost fields — so without a ledger,
   usage/billing reports silently lose the prior run's cost attribution. Add an append-only
   `RecordingCostHistory` row per run (`recordingId, transcriptionModel, soapModel,
   transcriptionCostCents, generationCostCents, createdAt`); reports read the ledger, not just the
   latest `SoapNote`. Ship this **before** enabling repeated reprocessing, not as a follow-up.
7. **Document audio retention.** Reprocess requires the source audio in R2; if lifecycle GC removed
   it, the job 404s → recording `failed`. The `audioFileUrl` gate is necessary but not sufficient —
   state the retention window so "reprocess old recording" failures are expected, not a bug.

Until items 1–3, 5, and 6 exist, mobile work is blocked (1–3 = function, 5 = meets the goal,
6 = billing integrity for a paid action).

## Skipped (YAGNI — add when asked)

- **SOAP-only re-run with a provider picker** (regen from the *existing* transcript, no
  re-transcription — cheaper/faster, likely the more common need). Cheap follow-up: thread optional
  `soapProvider` into `regenerate-soap` (`recordings.ts:3070-3086`) + one picker on the existing
  Regenerate-SOAP confirm. Out of scope — goal is redo **both**.
- **Pre-submit cost estimate / high-cost re-confirm.** No estimate endpoint; `costBreakdown` is
  post-hoc. Body copy warns of new cost; add an estimate endpoint + confirm if billing disputes appear.
- **Per-section Gemini model selection** (`soapModels`). Mobile picks the provider only.
- **Per-recording model memory.** Defaults to org default each time (locked to the goal).
- **A distinct "Reprocessing…" stepper label** vs initial "Transcribing…". Same backend statuses
  drive both; add a `ProcessingStepper` mode prop only if users find the reused labels confusing.
- **Zod-parsing the models response** — `normalizeOrgAiModels` shape guard (rule 10) suffices.

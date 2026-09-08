# Mobile plan — make the reprocess remedy reachable on a permanent failure

**Status:** proposal, not started. Written 2026-09-07 against Mobile `main` @ `2e3afd2` (1.13.20).
**Companion:** VetSOAP-Connect PR #668 (`feat/web-reprocess-remedy`), which fixed the web half.

---

## Context

A Gemini appointment recording over one hour is rejected by Google. CaptiVet turns that
into a permanent failure whose message names the remedy: *reprocess with Deepgram Nova 3
Medical*. Connect PR #666 made that message actionable; PR #668 made web able to act on it.

Mobile already has more reprocess machinery than web did — `ReprocessSheet`,
`getOrgAiModels`, `reprocessRecording`, `hasVisibleReprocessModelChoice`. That is precisely
why the gap is easy to miss: **the pieces exist, and they still do not deliver the remedy on
the failure this was built for.**

Nothing here is a wire-contract change. Every server endpoint this plan uses is already live
and already called by Mobile today.

---

## What is actually wrong, with evidence

### 1. The remedy message is never shown to the vet

`app/(app)/(tabs)/recordings/[id].tsx:1546-1585` renders a generic body and puts
`recording.errorMessage` behind a clipboard button:

```
'Something went wrong while generating this note. Retry processing, or copy the details for support.'
```

That is a deliberate decision — the comment at `:1575` says raw server text is
"technical/PHI-adjacent" — and it should **stay** deliberate. But the consequence is that the
one-hour rejection's carefully-written remedy sentence reaches nobody on Mobile, and the
generic copy that replaces it instructs the vet to **"Retry processing"**, which is exactly
the action that cannot work here.

### 2. Retry is the primary action and is a guaranteed no-op

`:1559-1569` renders Retry as `variant="primary"`. `POST /:id/retry` deliberately preserves
`processingTranscriptionModel`, and that pin beats the job payload in
`resolveRecordingTranscriptionRun`. For a failure *caused by* the pinned model, Retry
re-submits the same model and reproduces the identical failure. Mobile has no notion of a
permanent error code, so it cannot tell.

### 3. Reprocess is in a different part of the screen entirely

`canReprocess` (`:1097-1106`) is a generic `completed | failed` gate, and the entry point is a
Tools-row chip at `:1789-1798` with the sheet rendered at `:1809-1823` — structurally
unrelated to the failure card at `:1546`. A vet looking at "Processing Failed" is not led to
it.

### 4. The picker opens on the model that just failed

`src/components/ReprocessSheet.tsx:50-53` initialises both selections to the **org defaults**.
For the motivating case — a Gemini-default org that hit the ceiling — the picker opens on
Gemini, and one confirm reproduces the permanent failure. This is the P1 Codex raised against
Connect #668, and it is the half that lives here.

### 5. Foreign-language forces `nova-3` even for Gemini

`ReprocessSheet.tsx:51` pins `FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL` for **every**
foreign-language recording. The server (`recordings.ts`) only rewrites a selection that
derives to **deepgram** — `language='multi'` is what rejects `nova-3-medical` — and leaves a
Gemini selection untouched. So a Gemini-only org with no Deepgram key gets its SOAP remedy
redirected onto a provider it cannot use, failing with `MISSING_PROVIDER_KEY`. Web had this
identical bug; it was fixed in #668 and the fix should be ported verbatim.

---

## What Connect now provides that Mobile can consume

Already deployed, no Mobile release required to *exist*:

- **`AUDIO_TOO_LONG`** — a new persisted `RecordingErrorCode`, split out of `INVALID_AUDIO`
  precisely because `INVALID_AUDIO` is *also* raised by four pre-provider checks (empty file,
  >250MB, failed magic-byte validation, ffmpeg concat failure) where no model change can help.
  Mobile types `errorCode` as `string | null` (`src/types/index.ts:62`) and branches on it
  nowhere today, so consuming it is additive and safe.
- **`GET /api/organization/ai-models`** and **`POST /:id/reprocess`** — unchanged, already used.

---

## Proposed changes

### Step 1 — Port the selection helpers (`src/lib/aiModels.ts`)

Mirror `packages/core/src/logic/ai-model-selection.ts`. Keep `normalizeOrgAiModels` — Mobile
has no Zod at this boundary and Rule 10 shape-guarding is a Mobile house rule, unlike Connect.

Add:

- `pickRemedyModel(category, { excludeModelId? })` — first option that is **not** the excluded
  id (defaulting to the category default), falling back to the default when no alternative
  exists.
- `hasReprocessRemedyForCategory(models, category, { recordingForeignLanguage?, requireDistinctProvider? })`
  — requires **both** categories usable, then either `>1` option or, when
  `requireDistinctProvider`, `>1` distinct **provider**.
- `remedyRequiresDistinctProvider(errorCode)` — true for `/^(MISSING|INVALID)_.*KEY$/`.

The distinct-provider rule is not defensive padding: `/ai-models` gates on key **presence**,
not validity, so one invalid Gemini key still lists every Gemini model and each fails on that
same key. Deepgram's two models are the same case.

Mobile needs its own provider derivation for that check — Connect uses
`deriveSoapProviderFromModel` / `deriveRecordingTranscriptionProviderFromModel` from
`@captivet/core`, which Mobile cannot import. Check whether an equivalent already exists in
`src/lib/`; if not, a prefix/lookup map over the option ids is sufficient and should carry a
comment naming the Connect functions as its source of truth.

### Step 2 — Permanent-failure knowledge (`src/lib/recordingRetryState.ts`)

The module exists but carries no notion of a permanent failure: it exports only
`RecordingRetryPresentation = 'hidden' | 'retry' | 'audio_unavailable'` and
`getRecordingRetryPresentation`, all three states about whether the audio is still
there. Add, mirroring Connect's `recording-retry.ts`:

- `RECORDING_PERMANENT_ERROR_CODES` (14 codes, including the new `AUDIO_TOO_LONG`)
- `isRecordingPermanentFailure(errorCode)`
- `getRecordingFailureRemedyCategory(errorCode)` → `'transcription' | 'soap' | null`

`INVALID_AUDIO` must map to `null` — see the reasoning above. Only `AUDIO_TOO_LONG` and the
six key codes get a category.

Then `getRecordingFailureAction(recording, models)` → `'retry' | 'reprocess' | 'reprocess_blocked'`,
alongside — **not inside** — `getRecordingRetryPresentation`. Same reasoning as Connect: that
function answers "which card renders", this answers "which action leads", and it must stay
sync/data-only. Return `'retry'` whenever models are absent so a failed secondary query never
strands the vet without an action.

### Step 3 — Lead the failure card with the remedy (`recordings/[id].tsx:1546-1585`)

Keep the card, the generic body, and the copy-details button exactly as they are — the
PHI-adjacency decision stands.

Branch only the action row on `getRecordingFailureAction`:

- `'reprocess'` → primary **"Choose a different model"**, opening `ReprocessSheet` inline;
  demote Retry to `variant="secondary"`. Do not remove Retry: it is the only action that
  survives a stale or failed `ai-models` read.
- `'reprocess_blocked'` → keep Retry, plus one muted line naming the missing category. Gate a
  Settings pointer on the same role check the API Keys screen uses; a veterinarian who cannot
  add keys should be told to ask an admin.
- `'retry'` → today's markup, untouched.

**Also add one sentence of specific copy for `AUDIO_TOO_LONG`** — a new `ERROR_COPY` entry
naming the one-hour limit and Deepgram Nova 3 Medical. This is the only place the remedy can
reach a Mobile vet, and writing it as our own constant rather than surfacing
`recording.errorMessage` respects the PHI decision while still delivering the instruction.

### Step 4 — Fix `ReprocessSheet` (`src/components/ReprocessSheet.tsx`)

- Accept `remedyCategory?: 'transcription' | 'soap' | null`. Initialise **that** category via
  `pickRemedyModel` and leave the other on its org default.
- Replace the unconditional foreign-language pin with a `normalizeForForeignLanguage` helper
  that rewrites a selection **only** when it derives to Deepgram, and filter the picker
  options the same way so a non-Deepgram alternative stays visible.
- Update the foreign-language explanatory copy: Deepgram transcription runs on Nova 3, rather
  than implying all transcription does.

### Step 5 — DROPPED (verified 2026-09-07)

This step said to invalidate the `ai-models` query from Mobile's API-keys screen. **Mobile
has no API-keys screen** — key management is web-only, and nothing under `src/api/` or
`app/` touches `ApiKey`. The existing query already carries `refetchOnMount: 'always'`
with a 30-minute `staleTime`, so returning to the screen refetches anyway.

Note the key is **`['orgAiModels']`** (`app/(app)/(tabs)/recordings/[id].tsx:291`), a flat
string — not web's `['organization', 'ai-models']`. Reuse the existing query; do not add a
second one under a different key.

### Step 6 — Tests (`tests/*.test.mjs`, transpile-and-import convention)

`src/lib/aiModels.ts` is already written type-import-only so it loads in that harness; keep
`recordingRetryState.ts` the same way.

- `pickRemedyModel` returns a non-default alternative, and falls back when none exists.
- `hasReprocessRemedyForCategory`: both-categories-usable; per-category independence; the
  distinct-provider case (two Gemini models → false; Gemini + Anthropic → true; Deepgram's
  two models → false).
- `getRecordingFailureAction` truth table: `AUDIO_TOO_LONG` → `'reprocess'`; `INVALID_AUDIO`
  → `'retry'`; `retry_scheduled` + `AUDIO_TOO_LONG` → `'retry'` (status gate wins, the
  reprocess claim only accepts `completed|failed`); `models == null` → `'retry'`; foreign
  language with only Deepgram options → `'reprocess_blocked'`.
- Source-regex wiring assertions in the house style: the failure card references
  `getRecordingFailureAction`; `ReprocessSheet` no longer contains the unconditional
  foreign-language pin.

---

## Contract and release notes

- **No server change and no shape change.** Both endpoints are live today.
- **`AUDIO_TOO_LONG` is already shipping from Connect.** Until this Mobile release lands,
  Mobile treats it as an unknown string, exactly as it treats every other error code — the
  failure card renders as it does now. No installed client breaks; they simply do not get the
  remedy.
- **Version:** ordinary feature release off 1.13.20. `.aab` builds use the **production** EAS
  profile unless stated otherwise.
- **Cross-repo note:** Connect's `CLAUDE.md`/`AGENTS.md` currently record this divergence as
  the one intentional gap in the `ai-model-selection.ts` ↔ `aiModels.ts` mirror. **Update
  that note in Connect when this ships**, or it will read as a permanent exception rather
  than a closed one.

---

## Explicitly not in scope

- A standalone reprocess entry for **completed** recordings. Mobile already has one via the
  Tools row; only the failure path is being fixed here.
- Surfacing raw `recording.errorMessage` on screen. The clipboard-only decision stands.
- Any change to `/retry`'s pin-preserving behaviour. That is deliberate on the server and is
  what makes an explicit reprocess the correct remedy rather than a silent provider swap.

---

## Decision — Mobile-owned copy (open question closed 2026-09-07)

Step 3 uses a Mobile-owned `ERROR_COPY` entry, not an allowlist of server messages
safe to render verbatim. **Mobile's own house rule already settles this.**
`src/lib/errorCopy.ts` opens:

> branch ONLY on ApiError status/code and error type — never pattern-match server
> message text (Monitoring rules). Raw detail belongs behind a "Copy details for
> support" action, not on screen.

An allowlist is server-message rendering with a permission list bolted on; it would
be the first exception to that rule, and the exception would sit on a PHI-adjacent
string. Branching on `errorCode` and rendering our own sentence is the shape
`friendlyErrorMessage` already uses for every other error on the platform, so the new
entry is ordinary rather than novel.

The cost is a duplicated sentence — Connect writes the one-hour remedy into
`errorMessage`, Mobile writes its own. That is real but small and one-directional: if
the ceiling ever moves, the Connect message and this constant both need editing, and
`MAX_GEMINI_AUDIO_SECONDS` is documented as not-to-be-raised anyway.

---

## Prod evidence — this is latent, not live (checked 2026-09-07)

Against the production database:

- **No organization has Gemini appointment transcription.** Nineteen of twenty orgs
  have `settings.defaultRecordingTranscriptionModel` unset; Beyond Pets Animal
  Hospital has `nova-3-medical`. `allowedRecordingTranscriptionModels` is null on
  every row, and the legacy allow-list keeps `gemini-3.5-transcribe` blocked until
  that key explicitly permits it.
- **`AUDIO_TOO_LONG` has exactly one raise site** — `packages/services/src/transcription/gemini.ts:610`.
  It is Gemini-only and cannot be produced by any other path.
- **`processing_transcription_model` is null on all 3,570 recordings**, so no row has
  ever carried the pin that makes `/retry` a no-op.
- Currently-failed recordings carry `TRANSCRIPTION_FAILED` (44), `MISSING_AUDIO` (10),
  and one each of `GENERATION_FAILED`, `MAX_RETRIES_EXCEEDED`, `DOWNLOAD_FAILED` —
  **none** of them model-remediable.

So the gap this plan closes cannot fire today, on Mobile or on web. It arms the moment
someone enables Gemini appointment transcription for an org.

**Therefore the release gate is free:** do not add `gemini-3.5-transcribe` to any
org's `allowedRecordingTranscriptionModels` (or set it as
`defaultRecordingTranscriptionModel`) until this Mobile release is in the stores. That
single precondition closes the exposure at zero cost and takes the schedule pressure
off the work below.

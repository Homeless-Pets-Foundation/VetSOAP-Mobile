# VetSOAP-Mobile Plan: Harden Against Orphan Draft Recordings

## Context

Production users report seeing TWO recording rows per visit — a `draft` ("Not Submitted") and a `completed` — for nearly every submission on 2026-04-16 (see VetSOAP-Connect screenshots). The mobile architecture is supposed to *promote* the draft in place on Submit by passing `existingRecordingId`, but orphans are leaking into production.

The server-side backstop is already implemented in VetSOAP-Connect (`apps/api/src/routes/recordings.ts` confirm-upload now marks any matching draft as `replacedAt` + `replacedByRecordingId` when the sibling upload confirms, and the list endpoint hides `replacedAt != null` rows and `status='draft'` by default). That fix will clean up ANY orphan the mobile app produces from now on — including pre-fix deployed APKs still in the field.

**However**, the mobile code should still be hardened:
1. To reduce noise in `Recording` table and analytics.
2. To stop depending on fire-and-forget deletes in race-handling paths.
3. To verify our own release (v1.10.0) contains the race guards shipped in commits `4d5bc24`, `93af768`, `30c6f43`, `397f109`.

## Root Cause Summary

Code audit (full report below) confirms the architecture is correct post-commit `397f109` (14 Apr) and the race guards landed `4d5bc24` / `93af768` (15 Apr). Duplicates still reach prod because:

### 1. Race-handling paths delete with fire-and-forget

In `app/(app)/(tabs)/record.tsx`:

- `uploadSlot()` Tier 3 fallback (line 810):
  ```ts
  recordingsApi.delete(serverDraftId).catch(() => {});
  useExistingDraft = false;
  ```
  `delete` is not awaited. Upload proceeds. If the delete fails (network, 5xx, token refresh mid-flight), the stale draft persists in DB while a fresh upload row is created.

- `autoSaveDraft()` post-create race guard (line 927):
  ```ts
  if (submitIntentSlotIdsRef.current.has(slot.id) || completedUploadSlotIdsRef.current.has(slot.id)) {
    recordingsApi.delete(serverId).catch(() => {});
    ...
    return;
  }
  ```
  Same pattern. When the race is detected (user submitted before autoSaveDraft finished creating the server row), we fire-and-forget a delete. Any transient failure leaves an orphan.

### 2. Eager server-draft creation on Finish widens the race window

`autoSaveDraft` runs on every `Finish` tap (via the `recorder.state === 'stopped'` effect), synchronously triggering `recordingsApi.create(..., { isDraft: true })`. On warm cellular connections this is 200-500ms; on bad networks, multiple seconds. The user can tap `Submit` within that window, which means `uploadSlot` reads `slot.serverDraftId === null`, proceeds down the fresh-create branch, and creates a second recording. The post-hoc race guards then attempt to clean up via fire-and-forget deletes.

### 3. In-flight users on older APKs

v1.10.0 is the current package.json version. If the build that was promoted to production predates `397f109` / `4d5bc24` / `93af768` (14-15 Apr 2026), the race guards and stash round-trip fix are simply not installed on user devices — even if HEAD looks correct. **Verifying the production EAS build number is step zero.**

## Recommended Plan

Three-part: verify the deployed build, harden the race-handling paths, reduce the race window. Each part independently reduces orphan creation; combined with the server-side `replacedAt` backstop, duplicates should stop reaching users entirely.

### Part 1 — Verify the deployed build (REQUIRED, START HERE)

Before changing code, confirm what's actually in users' hands. One of the first three fixes below may already be shipping; the duplicates may be from an older EAS build still in production.

```bash
# From /home/philgood/Projects/VetSOAP-Mobile
eas build:list --platform android --limit 5 --non-interactive
eas channel:view production --non-interactive   # show current runtime + update bundle commit
```

Compare the `gitCommitHash` of the production build/channel against commits `397f109`, `4d5bc24`, `93af768`, `30c6f43`. If any are missing from the production APK, the fix is "publish a new build" — not a code change.

### Part 2 — Make race-handling deletes durable (code change)

Replace fire-and-forget `recordingsApi.delete(...)` in the three race-handling sites with a bounded retry via a new helper. Orphans are much rarer when the cleanup survives a transient network blip.

**New helper** — `src/lib/retryableCleanup.ts`:

```ts
import { recordingsApi } from '@/api/recordings';

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000, 5_000];

export async function deleteRecordingWithRetry(
  recordingId: string,
  attempts = DEFAULT_ATTEMPTS
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await recordingsApi.delete(recordingId);
      return true;
    } catch (err) {
      if (__DEV__) console.warn('[cleanup] delete retry', i, recordingId, err);
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[i] ?? 5_000));
      }
    }
  }
  return false;
}
```

**Sites to update** in `app/(app)/(tabs)/record.tsx`:

| Line | Current | Replace with |
|------|---------|-------------|
| 810 | `recordingsApi.delete(serverDraftId).catch(() => {});` | `deleteRecordingWithRetry(serverDraftId).catch(() => {});` |
| 911 | `recordingsApi.delete(slot.serverDraftId).catch(() => {});` | same |
| 927 | `recordingsApi.delete(serverId).catch(() => {});` | same |

Still async / non-blocking (we don't want upload to wait on delete), but now survives a single transient failure.

### Part 3 — Close the race window (code change)

The cleanest long-term fix: **don't create a server draft row until we know we need one**. A draft row is only useful when:
- The user navigates away without submitting (so it should appear on Home as "Not Submitted"), OR
- The user stashes the session (server draft persists across devices).

In the "Finish → Submit immediately" flow, the draft row has a lifetime of milliseconds and exists only to be promoted. If we defer server-draft creation by a few hundred ms — enough for `uploadSlot` to check-and-debounce — the race disappears in the common path.

**Proposed change** in `autoSaveDraft` (`record.tsx:873-948`): split into two phases.

```ts
// Phase 1: always-run (local draft).
const draftSlotId = await draftStorage.saveDraft(slot);
dispatch({ type: 'SET_DRAFT_IDS', slotId: slot.id, draftSlotId, serverDraftId: slot.serverDraftId ?? null });

// Phase 2: server draft creation — debounced. If the user submits within
// DEBOUNCE_MS, uploadSlot aborts this phase and takes the fresh-create path
// without ever writing a draft row. Stash / app-background / nav-away all
// flush the debounce synchronously so they still produce a server draft.
scheduleServerDraftCreation(slot.id, DEBOUNCE_MS);
```

Where `scheduleServerDraftCreation` is a new ref-managed scheduler (`src/hooks/useDraftDebouncer.ts` or inline in record.tsx) that:

- Starts a timer per slot id.
- On `submitIntentSlotIdsRef.add(slotId)` or `completedUploadSlotIdsRef.add(slotId)` → **cancels** the timer (no server draft is ever created for that slot's current finish).
- On `stashSession`, `AppState → 'background'`, or nav-away → **flushes** immediately (draft is created synchronously).
- Timer fires → runs the existing server-draft code path (Phase 2 of the current `autoSaveDraft`).

Suggested `DEBOUNCE_MS = 800`. Fast enough that the "Not Submitted" card appears promptly on Home if the user walks away, short enough that normal Submit traffic never races.

This is a meaningful refactor — gate it behind a feature flag (`EXPO_PUBLIC_DRAFT_DEBOUNCE=true`) so you can A/B and roll back quickly.

### Part 4 — Optional: emit PostHog event on race-guard fires

Already using PostHog in the web app; the mobile app sends events through `src/lib/posthog.ts` (if wired). Add three events:

- `mobile.draft.race_guard.post_autosave` — fired at record.tsx:927 when post-create guard trips
- `mobile.draft.tier3_fallback` — fired at record.tsx:810 when patch fails
- `mobile.draft.delete_failed_after_retry` — fired from `deleteRecordingWithRetry` when all 3 attempts fail

Gives us a prod signal to verify the fix lands. Target: after Part 2 ships, `mobile.draft.delete_failed_after_retry` trends toward zero.

## Critical Files

| File | Change |
|------|--------|
| `src/lib/retryableCleanup.ts` | **New** — `deleteRecordingWithRetry` helper |
| `app/(app)/(tabs)/record.tsx` lines 810, 911, 927 | Replace three `recordingsApi.delete(...).catch(() => {})` with retried version |
| `app/(app)/(tabs)/record.tsx` lines 873-948 | Refactor `autoSaveDraft` to debounce server-draft creation |
| `src/hooks/useDraftDebouncer.ts` (or inline) | **New** — per-slot timer with cancel/flush |
| `src/lib/posthog.ts` (if present) | Three new event names |
| `app.config.ts` / `.env` | `EXPO_PUBLIC_DRAFT_DEBOUNCE` flag (if adopting Part 3) |

No changes needed in: `src/types/stash.ts`, `src/lib/stashAudioManager.ts`, `src/hooks/useStashedSessions.ts`, `src/api/recordings.ts` — all Rule 24 sites and API helpers are already correct per the audit.

## Verification

### Reproducing the bug locally (pre-fix baseline)

1. WSL2 emulator setup per `CLAUDE.md` → "Emulator Testing (WSL2)".
2. Because emulator mic lacks peaks, silent-audio guard (`hasSilentAudioOnly`) blocks Submit. Use a physical Android device for end-to-end.
3. Physical device: record a visit, tap Finish, tap Submit within 400ms → inspect `Recording` table via `railway connect postgres` → confirm 2 rows (draft + uploading/completed) with the patientName.

### Post-fix verification

1. Apply Part 2 (retry helper). Repeat the 400ms-submit test. Expect: transient network blip in middle of delete (throttle via Android dev settings → airplane mode toggle) → orphan still eventually disappears because retry #2 or #3 succeeds.
2. Apply Part 3 (debounce). Repeat. Expect: ZERO draft rows written to server for the happy-path Submit. Verify via PostHog `recording_created` events — count of `isDraft=true` drops dramatically.
3. Regression: still works for
   - Finish → navigate away → "Not Submitted" appears on Home (debounce flushed)
   - Finish → Save for Later → Resume from another device → Submit (server draft used as `existingRecordingId`)
   - Offline Finish → online later → stash flushes draft creation
   - `cleanupOrphaned` sweep on Record mount still clears pre-fix orphans

### Production signals

- PostHog `mobile.draft.delete_failed_after_retry` count (should trend to ~0 after Part 2).
- Server-side query: `SELECT COUNT(*) FROM "recordings" WHERE status='draft' AND created_at > NOW() - INTERVAL '7 days' AND "replaced_at" IS NULL;` — new-draft orphan rate. Expect flat-zero after both fixes ship.
- User-reported duplicate sightings on `app.captivet.com` Records page.

## Not in Scope

- Changing the server-side promotion API (`existingRecordingId` path) — already correct on the server and mobile honors it.
- Migrating away from the "draft-save-on-finish" UX — that's a product decision, this plan preserves it.
- The VetSOAP-Connect web client — doesn't use drafts at all (confirmed by grep).

## What Was Shipped (2026-04-16)

Both Parts 2 and 3 landed. Part 4 (PostHog) deferred — not requested.

### Part 2 — Retry hardening

- `src/lib/retryableCleanup.ts` — new file with `deleteRecordingWithRetry(recordingId, attempts = 3)`. Backoff: 500ms / 2s / 5s.
- `app/(app)/(tabs)/record.tsx` — three fire-and-forget `recordingsApi.delete(...)` sites (Tier 3 fallback at old line 810, post-patch cleanup at old line 911, post-create race guard at old line 927) now call `deleteRecordingWithRetry(...)`.

### Part 3 — Debounced server-draft creation

- `src/config.ts` — new `DRAFT_DEBOUNCE_MS` export, parsed from `EXPO_PUBLIC_DRAFT_DEBOUNCE_MS`. Default 0 (legacy immediate behavior). Clamped 0-10000ms.
- `app/(app)/(tabs)/record.tsx`:
  - New `pendingDraftTimersRef` — per-slot `setTimeout` handles.
  - New `cancelScheduledDraft(slotId)` — clears + removes one pending timer.
  - Unmount effect clears all pending timers.
  - `markSubmitIntent` now cancels pending timers for the submitted slot.
  - `autoSaveDraft` split: Phase 1 (local) always runs; Phase 2 scheduled via `scheduleDraftSync`.
  - New `syncServerDraft(slotId, draftSlotId)` — extracted Phase 2 network logic, reads latest slot from `sessionRef`.
  - New `scheduleDraftSync(slotId, draftSlotId)` — coalesces timers, re-checks race guards at fire time.
  - New `flushScheduledDraft(slotId)` — synchronously runs a pending timer's work.
  - `executeStash` flushes all pending timers before `stashSession(session)` to preserve serverDraftId in stash payloads.

### Rollout

To activate the debounce in production:
```
eas secret:push --scope project --force   # with EXPO_PUBLIC_DRAFT_DEBOUNCE_MS=800 in .env
```
Recommended first roll: internal build, confirm "Not Submitted" cards still appear on Home after Finish (delayed ~800ms) and after Save for Later (immediate via flush). Then preview → production.

To disable (quick rollback without a rebuild):
```
eas secret:delete EXPO_PUBLIC_DRAFT_DEBOUNCE_MS
```
Redeploy — `DRAFT_DEBOUNCE_MS` falls to 0, code runs legacy immediate-sync behavior.

### Validation

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (3 pre-existing warnings unrelated to this change).
- Physical-device verification still recommended per the "Post-fix verification" section above.

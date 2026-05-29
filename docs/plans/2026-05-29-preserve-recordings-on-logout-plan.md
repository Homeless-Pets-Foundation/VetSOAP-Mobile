# Plan: Preserve recordings on logout + pre-logout guard + status-aware eviction

**Repo:** VetSOAP-Mobile (React Native / Expo tablet app).
**Date:** 2026-05-29
**Status:** Audited (code-verified). Replaces the original logout-wipe-removal draft.

## Context

A vet's recording ("Lela bug") was lost: a server-side `draft` existed with no audio, and the local audio was destroyed before upload. Root cause: **logout wipes all local recordings.** `performPhiCleanup()` (`src/auth/AuthProvider.tsx:330-349`) deletes all local drafts, stashes, and their audio, and runs on **every** logout path — explicit Sign Out (`handleSignOut`, call at `:1087`) and **involuntary** logout (token-refresh failure / session expiry / post-update device re-validation) via the `onAuthStateChange` `SIGNED_OUT` handler (call at `:1358`).

The wipe was an at-rest PHI precaution. **Owner decision:** veterinary medicine is not under HIPAA; these recordings carry no security concern, so preservation beats wiping. At-rest encryption is out of scope.

### Intended outcome
1. Local recordings (drafts + stashes + audio) **survive all logouts**, stay per-user scoped on disk, reappear when that user signs back in.
2. A **pre-logout guard** on explicit Sign Out warns when un-sent recordings (drafts **or** stashes) exist, so the vet can go submit them.
3. A **status-aware 30-day eviction** sweep bounds disk growth on shared tablets without silently destroying clinical data.

## Audit findings (corrections to the original draft)

Verified by code read. Direction was correct and **safe** — per-user scoping confirmed, so removing the wipe does **not** leak recordings across users. Corrections:

- **`secureStorage.clearAll()` runs in TWO paths, not one.** Original cited only `handleSignOut:1074`. It also runs in the involuntary `SIGNED_OUT` handler (`AuthProvider.tsx:1361`). `clearAll()` unconditionally deletes `RECOVERY_INTENT` (`src/lib/secureStorage.ts:156`). Fix at the keyset (exclude the key) to cover both paths; the "re-save after clear" idea would miss the involuntary path.
- **Per-user scoping verified.** Drafts: `documentDirectory/drafts/{userId}/{slotId}/` + SecureStore keys `captivet_draft_{userId}_*` (`draftStorage.ts:160-191`). Stashes: `documentDirectory/stashed-audio/{userId}/` + `captivet_stash_{userId}_*` (`stashStorage.ts:18-28`, `stashAudioManager.ts:12-31`). `clearAll()` / `clearAllStashes()` / `deleteAllStashedAudio()` are all **current-user-only**; `setUserId(null)` only re-scopes, deletes nothing. No cross-user leak from removing the wipe.
- **Upload-success cleanup confirmed** at `record.tsx:1786-1795`: deletes segment files, then `draftStorage.deleteDraft(slot.id)` + `recoveryIntent.clearForDraftSlot(slot.id)`. Successfully-uploaded recordings are already gone locally — eviction targets only leftover (unsent or straggler) recordings.
- **`pendingSync` is server-row-only**, not R2 upload (`draftStorage.ts:590,660`). Do not treat `pendingSync` as "uploaded".
- **Documentation drift:** `cleanupOrphaned` (`draftStorage.ts:794-849`) is **defined but never called** (zero call sites). CLAUDE.md claims it "runs on Record tab mount" — it does not. Wire it as part of this work.
- **CLAUDE.md rules 8 + 13 contradict this plan.** Rule 8 mandates the PHI wipe-before-auth-clear. This plan reverses it intentionally. Must update those rules or a future dev re-adds the wipe.

## Changes

### 1. Stop deleting recordings on logout — `src/auth/AuthProvider.tsx`
- Replace `performPhiCleanup` (`:330-349`) with `clearTransientCaches()` that **drops** the three recording-destroying calls: `draftStorage.clearAll()`, `stashStorage.clearAllStashes()`, `stashAudioManager.deleteAllStashedAudio()`.
- **Keep** the genuinely-transient cleanup it already does: `audioTempFiles.cleanupAll()`, `clearPeakCache()`, `audioEditorBridge.clear()`, `clearClipboard()`. For `cleanupAudioCache()`: verify its target dir; keep only if it is a scratch/cache dir that cannot touch `documentDirectory/drafts/**` or `stashed-audio/**` — drop if unsure.
- Update **both** call sites (`:1087`, `:1358`) to call `clearTransientCaches()`.

### 2. Preserve recovery intent across both logout paths — `src/lib/secureStorage.ts`
- Remove the `KEYS.RECOVERY_INTENT` deletion from `clearAll()` (`:156`). This single change covers explicit and involuntary logout (both go through `clearAll()`). `DEVICE_ID` stays preserved as today.
- `recoveryIntent` is still cleared at the right moments by `recoveryIntent.clear()` / `clearForDraftSlot()` (post-submit, `record.tsx:1795`).

### 3. Pre-logout guard (drafts + stashes) — `app/(app)/(tabs)/settings.tsx`
- In `handleSignOut` (`:68`), before `signOut()`, count un-sent recordings:
  - Drafts: `draftStorage.listDrafts()` → keep those with `segments.length > 0` and on-disk audio present.
  - Stashes: query `stashStorage` for the current user's stashed sessions (a stash = a deliberately-parked unsent recording).
- If `unsentCount > 0`, `Alert.alert` (existing pattern): "You have N recording(s) on this device not yet sent for SOAP notes. They'll stay on this device — sign out anyway?"
  - **[Review unsent]** → navigate to Home/Record; do not sign out.
  - **[Sign Out]** → proceed (recordings preserved).
  - **[Cancel]** → dismiss.
- `unsentCount === 0` → keep the current simple confirm.

### 4. Status-aware 30-day eviction — `src/lib/draftStorage.ts` (+ stash equivalent), wired on Record/Home mount
Bounds disk growth. **Never silently destroys clinical data.** Uses `savedAt` (`DraftMetadata.savedAt`, `draftStorage.ts:32`,`585`) for age. Statuses from `RecordingStatus` (`src/types/index.ts:1-10`); per-recording status via `recordingsApi.get(serverDraftId)` (`src/api/recordings.ts:226`).

Policy per recording older than `maxAgeDays = 30`:
- **Server-confirmed uploaded** (`serverDraftId` set AND `recordingsApi.get(id).status` ∉ `{draft, failed}`): redundant local copy → **delete** local audio + metadata (and clear stash). Safe, no warning needed.
- **Un-sent** (no `serverDraftId`, or server still `draft`/unreachable): **warn-first, then delete.**
  - Heads-up window from `warnAgeDays = 23`: surface a persistent "unsent, expires in N days" indicator so the vet can submit.
  - At ≥30 days: on next Record/Home mount, show an `Alert` listing expiring unsent recordings with **[Submit now]** / **[Delete]** before removal — delete only after the user acknowledges. Satisfies "30-day delete, but warn first."
- **Offline:** skip the uploaded-confirm branch (cannot verify status) and defer; never delete a recording whose uploaded-state is unverifiable. Unsent recordings (no `serverDraftId`) need no network to classify.

Implementation:
- Add `evictExpired({ maxAgeDays, warnAgeDays }, getStatus, deleteServerDraft)` to `draftStorage.ts`; mirror for stashes (`stashStorage` + `stashAudioManager`), reusing stash `savedAt` and `serverDraftId` (rule 20).
- **Wire `cleanupOrphaned`** (currently uncalled, `:794`) AND the new `evictExpired` on Record/Home mount, after `setUserId` (rule 13 ordering). Reuse `recordingsApi.delete` for server-row removal and `recordingsApi.get` for status.

### 5. Update project docs — `CLAUDE.md`
- **Rule 8** ("sign-out awaits PHI cleanup before clearing auth"): rewrite to reflect that logout now clears **transient caches only** and intentionally **preserves** drafts/stashes/recovery-intent; per-user scoping (rule 13) protects shared tablets, not deletion.
- **Rule 13** / Draft-Save section: correct the false claim that `cleanupOrphaned` runs on Record mount → state it (and `evictExpired`) are now actually wired there; document the 30-day status-aware eviction + warn-first policy.

## Files
- `src/auth/AuthProvider.tsx` — `performPhiCleanup` → `clearTransientCaches`; update calls at `:1087`,`:1358`.
- `src/lib/secureStorage.ts` — drop `RECOVERY_INTENT` from `clearAll()` (`:156`).
- `app/(app)/(tabs)/settings.tsx` — unsent guard (drafts + stashes) in `handleSignOut` (`:68`).
- `src/lib/draftStorage.ts` — add `evictExpired`; wire `evictExpired` + existing `cleanupOrphaned`.
- `src/lib/stashStorage.ts` / `src/lib/stashAudioManager.ts` — stash-side eviction + unsent count for the guard.
- Record/Home mount (`app/(app)/(tabs)/record.tsx` and/or home) — invoke `cleanupOrphaned` + `evictExpired` after `setUserId`.
- `CLAUDE.md` — update rules 8, 13 + Draft-Save section.
- Reused (no change): `recordingsApi.get/list/delete` (`src/api/recordings.ts`), `recoveryIntent` (`src/lib/recoveryIntent.ts`), `mergeDraftRecordings` (`src/lib/draftRecordings.ts`).

## Verification
- **Static:** typecheck / lint / test (`package.json` scripts). No type breakage from the cleanup refactor.
- **Unit (add):**
  - `clearTransientCaches` does **not** call `draftStorage.clearAll` / `stashStorage.clearAllStashes` / `stashAudioManager.deleteAllStashedAudio`.
  - `clearAll()` no longer deletes `RECOVERY_INTENT`; still deletes tokens/session; still preserves `DEVICE_ID`.
  - Unsent count = drafts with on-disk segments + current-user stashes; ignores draft with no audio.
  - `evictExpired`: a 31-day uploaded-confirmed draft is deleted; a 31-day unsent draft is queued-for-warning, not silently deleted; a 10-day draft untouched; offline → uploaded-confirm branch skipped.
- **Manual (dev build, two users, one device):**
  1. User A records, does not submit → local draft exists.
  2. Involuntary logout (expire/revoke token) → next launch: A's draft present; recovery intent survived → auto-resume/listed on Home.
  3. A taps Sign Out with an unsent draft AND a stash → guard shows count = both → Sign Out → sign back in as A → both present + submittable → submit → SOAP generates; local draft deleted.
  4. Sign in as B → does not see A's recordings; back to A → A's return.
  5. Eviction: back-date a draft `savedAt` >30d. Uploaded-confirmed → swept silently. Unsent → warn alert with Submit/Delete; nothing deleted until acknowledged.
- **Regression:** `audioTempFiles`/peak/clipboard still cleared on logout; successful upload still deletes local draft (`record.tsx:1786-1795`).

## Out of scope (per decision)
- At-rest encryption of local audio (no security concern for vet recordings).
- "Lela bug" historical recovery — predates this fix; only recoverable from the physical tablet if the file still exists.

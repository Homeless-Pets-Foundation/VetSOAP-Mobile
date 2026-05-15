# Plan: Fix Draft-Audio Wipe on Re-save Failure (1.11.9 Regression)

**Date:** 2026-05-15
**Affected build:** 1.11.9 (Android, internal track DRAFT, versionCode 56, shipped 2026-05-13)
**Regression introduced by:** `3c5adf2` — *fix(record): false-positive silent flag + orphan-draft prevention*
**Reporter:** User on Pixel 10 Pro XL — draft chip flips from "On this device" to "Not on this device" hours after save, eventually entry disappears entirely from Home.

---

## Context

User reports that local drafts on Pixel 10 Pro XL (build 1.11.9, shipped 2026-05-13) flip
from "On this device" to "Not on this device" hours after save, and eventually the entry
disappears entirely from the Home list. Reproduces independent of the Android system
update the user mentioned (the user also observed it the previous day, pre-update).

The behavior is a data-loss regression introduced by commit `3c5adf2` — *fix(record):
false-positive silent flag + orphan-draft prevention*. That commit added two things:

1. A new throw inside `saveDraft` at `src/lib/draftStorage.ts:445-449` that fires when
   **every** source segment fails to copy (intended to prevent the empty-segment
   server-row orphan).
2. A `priorValidSave` flag computed up-front at `src/lib/draftStorage.ts:378-381` plus
   a `prior_valid_save` telemetry property emitted at line 118, with the author
   commenting at line 374-376 about the catch path being able to "potentially wipe"
   a previously valid draft.

The author wired the telemetry but **did not** wire the guard. The catch block at
`src/lib/draftStorage.ts:481-486` still calls `safeDeleteDirectory(dir)`
unconditionally:

```typescript
} catch (error) {
  // Clean up partially-copied files on failure
  safeDeleteDirectory(dir);
  emitDraftFailure('draft_save_failed', error);
  throw error;
}
```

So when `saveDraft` is invoked a second time on an already-saved slot and the new
copies all fail — typical when the slot's `segments[i].uri` still points at
recorder temp files that Android has since purged — the catch destroys the entire
draft directory, including audio from the prior successful save.

### Sequence that reproduces the user's report

| t | event | result |
|---|---|---|
| T0 | User taps Finish. `autoSaveDraft` (`app/(app)/(tabs)/record.tsx:1657-1701`) → `saveDraft` succeeds. | Audio at `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a`, metadata in SecureStore. UI: "On this device". |
| T1 | User backgrounds the app. `persistSessionDraftsForBackground` (`record.tsx:728-740`) re-runs `autoSaveDraft` for every slot with segments. Or `pendingDraftSlotIdRef` fires the effect at `record.tsx:1748-1761`. | Re-save attempt. |
| T2 | Source URIs in `slot.segments[i].uri` (recorder temp files) have been purged by Android cache cleanup / OS update / FFmpeg temp wipe. | `fileExists(segment.uri) === false` for every segment. |
| T3 | `saveDraft` records `failureReasons = ['source_missing', ...]`. Hits the all-failed guard at line 445 → throws. | Catch at line 481 → `safeDeleteDirectory(dir)`. Prior `seg_N.m4a` files destroyed. |
| T4 | User reopens app. `listDrafts()` returns metadata (still in SecureStore, untouched). Home renders the draft card. `isDraftResumable()` (`src/lib/draftRecordings.ts:12-14`) sees missing files → returns false. `buildDraftResumeMap` omits this draft. `RecordingCard.tsx:144` renders `DraftLocationChip` with `isOnDevice={false}`. | UI: "Not on this device". |
| T5 | User opens Record tab. `cleanupOrphaned` (`record.tsx:2181-2196`) runs once per user. `anyMissing` branch (`draftStorage.ts:644-649`) catches the orphan and calls `deleteDraft` → metadata deleted, server draft row deleted. | Entry gone from Home list. |

### Files involved (read-only, for context)

- `src/lib/draftStorage.ts` — `saveDraft` (lines 364-487), `cleanupOrphaned` (630-675), `priorValidSave` (378-381).
- `app/(app)/(tabs)/record.tsx` — `autoSaveDraft` (1657-1701), background persist (728-740), pending-draft effect (1748-1761), cleanupOrphaned trigger (2181-2196).
- `src/lib/fileOps.ts` — `safeDeleteDirectory`, `fileExists`, `ensureDirectory` (full file is 64 lines).
- `src/lib/draftRecordings.ts` — `isDraftResumable` predicate (12-14).
- `src/components/RecordingCard.tsx` — `DraftLocationChip` rendering (20-38, 144).

---

## Fix

One surgical change in `src/lib/draftStorage.ts` at lines 481-486.

```typescript
} catch (error) {
  // Preserve audio from any pre-existing complete-on-disk draft. The catch
  // used to wipe `dir` unconditionally, which destroys the prior successful
  // save when this re-save fails — typical when slot.segments[i].uri points
  // at recorder temp files that Android cache-cleanup, an OS update, or an
  // FFmpeg-split sweep has since purged. priorValidSave is computed at
  // line 378 for exactly this guard; 3c5adf2 wired it into telemetry only.
  if (!priorValidSave) {
    safeDeleteDirectory(dir);
  }
  emitDraftFailure('draft_save_failed', error);
  throw error;
}
```

That is the entire fix. Three lines added, nothing removed, no refactor.

### Why this is enough

- `priorValidSave === true` requires `existing.segments.every(s => fileExists(s.uri))`. If we reach the catch with that flag set, there is by construction a complete on-disk draft to protect.
- When `priorValidSave === false` (first-time save, partial prior save, or fresh dir) the catch still wipes — identical to current behavior, so the original empty-segment-orphan prevention from 3c5adf2 is unchanged.
- The thrown error still bubbles to `autoSaveDraft`'s outer catch (`record.tsx:1683-1697`), which still `captureException`s and skips the Phase 2 server-sync. Observability is preserved.
- The PostHog `draft_save_segment_copy_failed` events with `prior_valid_save: true` were already shipping in 1.11.9 — they are the fleet-wide signal that retroactively proves this guard would have helped. Post-deploy, `draft_orphan_sweep.deleted` should drop while `draft_save_segment_copy_failed` continues to fire (the trigger isn't fixed, only the data-loss consequence).

---

## Files to modify

| File | Change |
|---|---|
| `src/lib/draftStorage.ts` | Wrap line 483 in `if (!priorValidSave)`. Add a 3-line comment above explaining why. |

Nothing else.

---

## Verification

1. **Dev-build smoke test on Pixel 10 Pro XL** (serial `57171FDCQ007B1`, per `devices_testing.md` memory):
   - Build local APK: `npx expo run:android --variant release` (or use EAS preview if local doesn't sign).
   - Record a single-patient draft, tap **Finish**. Confirm "On this device" chip on Home.
   - Force the trigger: clear recorder temp files behind the app's back —
     `adb.exe shell run-as com.captivet.mobile rm -rf /data/data/com.captivet.mobile/cache`.
     (Alternative: kill the app and re-launch — RAM session state is gone, so this won't repro;
     the dev needs the slot's segments to still point at now-missing temp files.)
   - Background the app via Home button (`adb.exe shell input keyevent 3`). Wait 2 seconds. Foreground.
   - Open the Record tab to trigger `cleanupOrphaned`.
   - **Expected with fix:** chip still says "On this device", tapping the draft card resumes recording with audio intact, `cleanupOrphaned` does not delete the entry.
   - **Expected without fix (current 1.11.9):** chip flips to "Not on this device", then card disappears on Record-tab mount.

2. **Unit-ish jest check** (optional but cheap): in `src/lib/__tests__/draftStorage.test.ts` (create
   if absent), seed a draft via `saveDraft` with mocked `ExpoFile`/`fileExists` returning true, then
   re-run `saveDraft` with `fileExists` mocked to return false for sources. Assert that
   `safeDeleteDirectory` is **not** called and that the original `seg_0.m4a` "file" survives the throw.

3. **PostHog confirmation post-deploy** (1.11.10 hotfix):
   - `draft_save_segment_copy_failed` events with `prior_valid_save: true` should still fire (trigger unfixed).
   - `draft_orphan_sweep` events with `deleted > 0` should drop substantially.
   - The Sentry `auto_save_draft` exception rate should be approximately unchanged
     (the catch still throws, autoSaveDraft still captures).

4. **No regression on the empty-segment-orphan path that 3c5adf2 fixed:** induce a fresh
   first-time save where every source URI is invalid (no prior draft). Catch fires with
   `priorValidSave === false`, `safeDeleteDirectory` runs, dir cleaned, empty-segment metadata
   never written. Identical to current 1.11.9 behavior.

---

## User's specific recording — recovery status

Confirmed by user clarification:
- **Build:** 1.11.9 (matches the regression window).
- **State observed:** "Card still listed, chip changed" — i.e. SecureStore metadata intact, audio dir destroyed. Exact mid-stage of the sequence above.
- **Trigger:** "Backgrounded/swipe-closed the app" — pins the re-save to `persistSessionDraftsForBackground` (record.tsx:728-740) firing on AppState `active → background` with `slot.segments[i].uri` already stale.

**The lost audio is not recoverable.** `safeDeleteDirectory` (`fileOps.ts:21-28`) calls `new Directory(uri).delete()` which is a hard filesystem delete with no trash. The server draft row for that recording (created by Phase 2 server-sync) holds only the form metadata — audio is uploaded only on **Submit**, which never happened. Nothing to restore from either end. The Record-tab `cleanupOrphaned` (record.tsx:2181-2196) will sweep the orphan metadata on the next visit; once the fix lands, the user should manually open the Record tab to clear the dead entry from Home (or we can ship a one-shot "Discard stale draft" affordance — not blocking for this hotfix).

If the lost recording's PIMS form data (patient/client name, species, etc.) is enough to identify the visit and the user can re-record the patient, that's the only path forward. The fix below prevents the **next** draft from going the same way.

---

## Follow-ups (out of scope, separate PR)

These eliminate the underlying *trigger* (stale source URIs) instead of just preventing the
data loss. Recommend tracking as a follow-up issue rather than bundling with the hotfix.

- **Promote slot segment URIs to draft copies after successful `saveDraft`.** Today, after
  saveDraft copies audio to `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a`, the
  in-memory `slot.segments[i].uri` still points at the original recorder output. A new
  reducer action (e.g. `PROMOTE_SEGMENTS_TO_DRAFT`) plus a dispatch from `autoSaveDraft`
  after `saveDraft` resolves would re-point those URIs so future re-saves no longer depend
  on the recorder temp file surviving. Touches `useMultiPatientSession.ts`, the
  `SessionAction` union in `src/types/multiPatient.ts`, and `record.tsx:1660-1672`.
- **Atomic-rename in `saveDraft`.** Write copies to `seg_N.m4a.tmp`, then atomic-rename to
  `seg_N.m4a`. Cleanup paths only ever delete `.tmp` files. Removes the catch-block-needs-to-clean
  rationale entirely. The 1.11.9 telemetry comment at line 117 already calls this out as
  the canonical fix; the hotfix above is the surgical interim.

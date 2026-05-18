# Plan: PROMOTE_SEGMENTS_TO_DRAFT — re-point slot URIs after `saveDraft` succeeds

**Date:** 2026-05-17
**Target release:** 1.11.12 (decoupled from 1.11.11 R2 upload-resilience PR)
**Sentry fingerprint:** REACT-NATIVE-8 — `Draft storage: all N segment copies failed (copy_threw)`
**Status of related work shipped:** 1.11.10 (PR #46) gated `saveDraft`'s wipe-on-resave deletion; 1.11.10+ events now carry enriched `freeDiskMb` + per-segment errno tags. This plan addresses the *trigger*, not the side effect.

---

## Context

RN-8 fires when `draftStorage.saveDraft(slot)` (`src/lib/draftStorage.ts:411-445`) loops over `slot.segments[i].uri` and every `new ExpoFile(segment.uri).copy(...)` throws `copy_threw`. The 1.11.10 hotfix stopped the catch block from wiping the prior valid on-disk draft, so a recurring failure no longer destroys data — but the failure itself still fires on every re-save attempt and the slot still cannot be promoted to a draft from session state alone.

The 1.11.10 enriched `failureReasons` (`PROMOTE_SEGMENTS_TO_DRAFT` is the follow-up cited in `sentry-open-followups`) is expected to confirm what we already suspect: the source URIs in `slot.segments[]` point at recorder temp files that Android cache-cleanup has since purged (`fileExists(segment.uri)` returns false → `failureReasons.push('source_missing')`). The `dest_missing_after_copy` and `ENOSPC` paths are also possible, but `source_missing` is the dominant trigger we have evidence for from 1.11.9.

The root issue: **the reducer never updates `slot.segments[].uri` to point at the durable draft copies after `saveDraft` succeeds.** Every subsequent autoSaveDraft re-reads the same recorder-temp URIs from session state. As soon as the OS purges them, every re-save loop fails.

## Root cause walkthrough

1. `expo-audio` records into `documentDirectory/.../recorder.../seg_N.m4a` — a *cache-adjacent* path.
2. `SAVE_AUDIO` reducer action (`src/hooks/useMultiPatientSession.ts`) puts that URI into `slot.segments[].uri`.
3. On Finish, `autoSaveDraft` (`app/(app)/(tabs)/record.tsx:1657`) calls `draftStorage.saveDraft(slot)`. `saveDraft` copies each `slot.segments[i].uri` to a durable `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a` (line 418).
4. `saveDraft` returns the `draftSlotId`. The caller dispatches `SET_DRAFT_IDS` — which sets `serverDraftId` / `draftSlotId` on the slot but **leaves `slot.segments[].uri` pointing at the original recorder path**.
5. Hours later, Android cache-cleanup or "Free up space" reaps the recorder dir. The draft on disk is intact. Session state is not.
6. User taps Continue / autoSaveDraft re-fires (debounced sync; Finish → Continue → Finish; pause-resume). `saveDraft` loops over `slot.segments[].uri` — files are gone — every `copy_threw` (or `source_missing`) → RN-8.

The session state should be re-pointed at the durable draft copies the moment `saveDraft` succeeds. From that point on, `slot.segments[].uri` is canonical and survives OS cleanup.

## Proposed change

### 1. New reducer action

`src/types/multiPatient.ts`:

```ts
export type SessionAction =
  | …existing…
  | {
      type: 'PROMOTE_SEGMENTS_TO_DRAFT';
      slotId: string;
      segments: AudioSegment[];
    };
```

Use the existing `AudioSegment` type alias (also from `src/types/multiPatient.ts`) rather than inlining the shape — a future schema change (e.g. adding a sample-rate field to `AudioSegment`) then flows into the action payload automatically instead of needing a coordinated edit. Reducer in `src/hooks/useMultiPatientSession.ts` replaces `slot.segments` with the provided array. Length and per-segment `duration` must match the existing array exactly — defense-in-depth assertion logs (`__DEV__` only) on mismatch so a future refactor that drops a segment doesn't silently bypass the guard. The reducer must not touch `audioState`, `recorderBoundToSlotId`, `uploadStatus`, or any other slot field — promotion is URI-only.

### 2. `saveDraft` returns the promoted segments

`src/lib/draftStorage.ts:364`:

```ts
async saveDraft(slot: PatientSlot): Promise<{
  draftSlotId: string;
  promotedSegments: AudioSegment[];
}>
```

`promotedSegments` is the `draftSegments` array already constructed at line 437 — it already has the durable `destUri`, the `duration` carried through, and the optional `peakMetering`. The shape change is mechanical: today the function returns `slot.id` (a string); change to return an object. Same rationale for `AudioSegment`: if the type grows fields, this signature absorbs the change for free.

Caller updates (one site — `autoSaveDraft` in `record.tsx:1662`) — destructure `{ draftSlotId, promotedSegments }`. Callers in `tests/security-mfa.test.mjs` and any other indirect consumers must be audited via grep.

### 3. autoSaveDraft dispatches the promotion

After successful `saveDraft`, dispatch *both* actions in order — first `PROMOTE_SEGMENTS_TO_DRAFT` (URI rewrite), then `SET_DRAFT_IDS` (draft linkage). Order matters because subsequent reads from `sessionRef.current` should see the new URIs *before* any downstream side effect (e.g. `scheduleDraftSync` snapshotting the slot for the server PATCH) runs.

```ts
import type { AudioSegment } from '../../../src/types/multiPatient';

const { draftSlotId, promotedSegments }: { draftSlotId: string; promotedSegments: AudioSegment[] } =
  await draftStorage.saveDraft(slot);

if (promotedSegments.length === slot.segments.length) {
  dispatch({
    type: 'PROMOTE_SEGMENTS_TO_DRAFT',
    slotId: slot.id,
    segments: promotedSegments,
  });
} else if (__DEV__) {
  console.warn('[Record] segment-count mismatch in autoSaveDraft promotion',
    { input: slot.segments.length, promoted: promotedSegments.length });
}

dispatch({ type: 'SET_DRAFT_IDS', slotId: slot.id, draftSlotId, serverDraftId: slot.serverDraftId ?? null });
```

The length-guard is a belt-and-suspenders check: a partial-success `saveDraft` (some segments copied, some didn't) would arrive with `promotedSegments.length < slot.segments.length`. Promoting only some URIs would leave the slot with a mix of durable and recorder-temp paths — exactly the state we're trying to eliminate. On mismatch, skip the promotion entirely; the prior 1.11.10 wipe-guard keeps the on-disk draft intact, and the next successful `saveDraft` (after the user re-records the failed segment) will land all-or-nothing.

### 4. Side-effects to audit

After promotion, the recorder-temp source files at the *old* URIs become unused. Today they get cleaned up by:

- `discardSlot` / `resetSession` — `FileSystem.deleteAsync` per old URI. After promotion, those URIs are gone from state, so the cleanup loop will operate on the durable draft copies. **This is a regression** — discarding a slot post-promotion must NOT delete the durable copies (the user might have stashed the session between promotion and discard; the stash payload still references the same files).

  Fix: `discardSlot` already runs `safeDeleteFile(segment.uri)` per current segment. Post-promotion, those URIs are draft paths — and the draft is owned by `draftStorage` after `saveDraft` succeeds. **The cleanup loop must skip URIs under `documentDirectory/drafts/`**; `draftStorage.deleteDraft(slotId)` (which the existing discard flow already calls via `deleteLocalSlotDraft`) is the authoritative deleter for those.

  Concrete change: in any spot that calls `safeDeleteFile(segment.uri)` for a slot whose draft is still owned by `draftStorage`, gate the call on `!segment.uri.includes('/drafts/')`. Or — cleaner — let `discardSlot` rely entirely on `deleteLocalSlotDraft` once promotion has happened (track via `slot.draftSlotId !== null`).

- `uploadSlot` post-success cleanup — currently deletes `slot.segments[].uri` after the server confirms (`app/(app)/(tabs)/record.tsx`, around `completedUploadSlotIdsRef`). Post-promotion, that loop will delete the durable draft copies, which is *correct*: post-upload, both the local draft and the durable audio are no longer needed; `draftStorage.deleteDraft(slotId)` already handles the metadata side. No change needed, but verify by walking the cleanup code.

- `stashAudioManager.moveSegmentsToStashDir` — copies segment URIs into the stash dir. Already URI-agnostic (works with any local `file://`). No change.

- Audio editor bridge — reads `slot.segments[].uri` for trim/edit. Already URI-agnostic. No change.

## Tests

Following the established pattern in `tests/security-mfa.test.mjs` and `tests/r2-upload-resilience.test.mjs`:

1. **`tests/promote-segments-to-draft.test.mjs`** — text-based regression assertions:
   - `multiPatient.ts` exports `PROMOTE_SEGMENTS_TO_DRAFT` in the `SessionAction` union with the expected shape.
   - `useMultiPatientSession.ts` reducer handles `PROMOTE_SEGMENTS_TO_DRAFT` and replaces only `slot.segments` (no other slot field touched).
   - `draftStorage.saveDraft` returns `{ draftSlotId, promotedSegments }` shape; `promotedSegments` derives from `draftSegments`.
   - `record.tsx` `autoSaveDraft` dispatches `PROMOTE_SEGMENTS_TO_DRAFT` before `SET_DRAFT_IDS`, gated on length match.
   - Discard / cleanup loop skips URIs under `documentDirectory/drafts/` OR uses `deleteLocalSlotDraft` exclusively for promoted slots.

2. **Reducer executable test** — load `useMultiPatientSession.ts` reducer via `loadTsModule` and assert PROMOTE behavior end-to-end with synthetic state. (The reducer is pure and has no React imports; should load cleanly.)

3. **Manual repro on Pixel 10 Pro XL** (the device that surfaced RN-8):
   - Record + Finish a single slot.
   - Force-stop the app.
   - Manually delete the recorder dir under `documentDirectory/recorder/` via `adb shell run-as com.captivet.mobile rm -rf <path>`.
   - Re-launch, open the slot from Home, tap Continue, record a new segment, tap Finish.
   - On 1.11.11 and earlier: autoSaveDraft throws `copy_threw` for the original segments. On 1.11.12: re-save succeeds because the original segments' URIs already point at durable draft paths, untouched by the recorder-dir delete.

## Rollout

Ship on 1.11.12 after 1.11.11 (R2 resilience, PR #48) has soaked for ≥ 2 days with no RN-7 / RN-4 regression. Mark RN-8 `resolvedInNextRelease` to `1.11.12` once the build is on the EAS submit queue — Sentry will auto-reopen if the issue fires on any release after that, so any new copy_threw event (e.g. ENOSPC, EPERM) post-1.11.12 will surface as a fresh signal rather than getting batched into the closed ticket.

## Out of scope (later, separate work)

- **Atomic `.tmp` writes in `saveDraft`.** The canonical defense against partial-copy data loss is to write to `seg_N.m4a.tmp` and rename to `seg_N.m4a` only after all copies succeed. Would let us drop the wipe-on-resave guard entirely. Larger change; needs its own plan after PROMOTE_SEGMENTS_TO_DRAFT has measurable effect.
- **Recorder writing directly to the draft dir.** Skips the copy step entirely. Requires audit of `useAudioRecorder` start path, segment-handoff between record/edit, and the cleanup-on-discard semantics. Larger refactor; deferred until the simpler URI-promotion approach has clear data showing it's insufficient.

## Risks

- **The wrong segment array gets dispatched.** Mitigated by the length-equality guard + the `__DEV__` warn on mismatch. Worst case: the dispatch is skipped and behavior matches 1.11.11.
- **A future refactor calls `saveDraft` outside `autoSaveDraft` and forgets to dispatch the promotion.** Mitigated by the regression test asserting the dispatch happens in `autoSaveDraft`. A grep for `draftStorage.saveDraft(` should return exactly one production call site after this change.
- **`discardSlot` deletes a durable draft copy.** Mitigated by the cleanup-gate change described in §4. The regression test asserts the gate exists.

## Rollback

Single-file revert: `git revert <PROMOTE_SEGMENTS_TO_DRAFT commit>` reverts the reducer, `saveDraft` signature, `autoSaveDraft` dispatch, and the discard-gate together. No state migration needed because the reducer change is additive (the new action type is unused after revert; the type union accepts the old shape). Drafts written under 1.11.12 carry durable URIs; reverting to 1.11.11 still reads them correctly because `documentDirectory/drafts/...` paths are valid `file://` URIs that `expo-audio` and `expo-file-system` handle identically to recorder-temp paths.

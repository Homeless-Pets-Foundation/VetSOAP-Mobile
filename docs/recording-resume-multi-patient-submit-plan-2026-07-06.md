# Fix Recording Resume and Multi-Patient Audio Submit

## Summary

- Root cause: durable recordings finish with `slot.durable` set and `slot.segments = []`, but the UI and `handleContinueRecording()` only allow continuation for legacy `segments[]`.
- Native durable recorder already supports appending to an existing native manifest; JS clears the durable refs on `resetWithoutDelete()` after `Finish`, so there is no public hook method to reattach and resume that file later.
- The multi-patient "no audio submitted" failure means the server row existed without `audioFileUrl`, so the fix should prove mobile reached the durable `createWithFile(...)` and `confirm-upload` path for every submitted patient.

## Key Changes

- Add a `resumeDurable(...)` method to `useAudioRecorder`.
  - Inputs: `userId`, `slotId`, and the current `DurableSlotRef`.
  - It requires `state === 'idle'`, native durable availability, and a native manifest under that `userId`/`recordingId`.
  - It seeds the JS timer and peak from the slot's existing `durationMs`/`peakDb`, calls native `durableRecorder.resume({ userId, recordingId })`, then updates sample rate, bitrate, duration, and peak from the returned manifest.
  - It must not fall back to expo-audio for an existing durable slot; mixing a new `.m4a` segment with the durable `.aac` pointer would recreate the broken empty-audio state.
  - It must not delete, reset, or discard durable files when resume fails. Leave the slot stopped; if normal submit still has a native manifest or `recoveredAudioUri`, the user can submit as-is.

- Update `record.tsx` continuation flow.
  - Remove the current durable-blocking alert in `handleContinueRecording()`.
  - Route stopped durable continuation through `startRecordingForSlot(slotId)` instead of a separate one-off path, so the existing pending-start queue still works when another patient owns the recorder.
  - Inside `startRecordingForSlot`, branch existing durable slots before the fresh-durable branch: require `isDurableCaptureEnabled()`, run the same low-storage gate as fresh durable capture, write `durableActiveStore.setActive(...)` through the existing bounded helper, call `recorder.resumeDurable({ userId, slotId, durable: startSlot.durable })`, then set `audioState` to `recording`.
  - `handleContinueRecording()` should still dispatch `CONTINUE_RECORDING` and preserve `draftSlotId`/`serverDraftId`; the later submit should promote the same draft row instead of creating a duplicate.
  - On durable resume failure, clear the active durable breadcrumb, unbind the recorder, set the slot back to `stopped`, and show a non-PHI message. Do not leave the slot in the `idle` state created by `CONTINUE_RECORDING`.
  - Do not call `deleteSlotDraft()` or discard native durable files from the continue path. Only call `deleteOrphanServerRecording(slot)` for stale `pendingConfirm` rows, then let `CONTINUE_RECORDING` clear `pendingConfirm` in state.
  - Keep uploaded, edited-manifest, and support-staff `recoveredAudioUri` durable recordings non-appendable; show a submit-as-is/start-over message.
  - If the native manifest is missing and there is no `recoveredAudioUri`, do not delete anything; keep the existing submit error path ("recording needs an app update/audio not found") so support can recover from disk if possible.

- Fix patient switching behavior.
  - Add one shared `selectPatientIndex(index)` helper used by both `PatientTabStrip.onSelectIndex` and `FlatList.onMomentumScrollEnd`.
  - If leaving a recording slot, capture the old `recorderBoundToSlotId`, start the existing async pause/stop-fallback flow for that slot, and set the active index immediately so tab taps stay responsive.
  - Keep the existing stop fallback when pause fails, so native failures still save the partial audio and do not leave a hidden active owner.

- Update `PatientSlotCard`.
  - Show the stopped-state `Continue Recording` action for durable slots.
  - Keep `Edit Recording` hidden for durable AAC files unless/until durable editing is supported.
  - Keep `Delete & Start Over` available.

- Tighten multi-patient submit handling.
  - Confirm every slot selected by `Submit All` has either `segments.length > 0` or `slot.durable`.
  - Add a guarded diagnostic path when `uploadSlot()` returns `null` for a slot that submit filtering selected, logging only non-PHI fields: slot index, `hasDurable`, segment count, audio state, `hasServerDraft`, and `hasPendingConfirm`.
  - Keep durable upload on `createWithFile(..., 'audio/aac')`, not `createWithSegments([])`.
  - Preserve and retry `pendingConfirm` inside durable upload retries so a completed R2 upload cannot strand a server row with no confirmed `audioFileUrl`; continuation still clears stale `pendingConfirm` before appending new audio.

## Test Plan

- Update `tests/durable-recorder-plan.test.mjs`.
  - Replace the "durable Continue blocked" assertion with "durable stopped slot shows Continue Recording".
  - Assert `handleContinueRecording()` no longer returns early for `slot.durable`.
  - Assert existing durable slots in `startRecordingForSlot()` call `recorder.resumeDurable(...)` before the fresh-durable start branch.
  - Assert `useAudioRecorder` exposes `resumeDurable()` and calls native `durableRecorder.resume` without falling through to expo-audio.
  - Assert `resumeDurable()` seeds elapsed duration and durable peak from the existing `DurableSlotRef` before appending.
  - Assert multi-patient submit includes durable slots and does not call segment upload with `[]`.
  - Assert `PatientTabStrip.onSelectIndex` uses the same pause-on-leave helper as swipe navigation.
  - Assert durable upload persists/uses `pendingConfirm` and calls `confirmUpload` through `createWithFile`.

- Run:
  - `node --test tests/durable-recorder-plan.test.mjs`
  - `node --test tests/durable-draft-roundtrip.test.mjs`
  - `node --test tests/durable-draft-resumable.test.mjs`
  - `npm run typecheck`

- Manual verification:
  - Single patient: record -> Finish -> Continue Recording -> record more -> Finish -> Submit.
  - Multi-patient: record patient 1 -> Finish -> patient 2 -> record -> Finish -> return patient 1 -> Continue Recording -> Finish -> Submit All.
  - Multi-patient active switch: while patient 1 is recording, tap and swipe to patient 2; patient 1 should pause, return with `Resume`, and continue cleanly.
  - Confirm both submitted patients get audio and neither receives "no audio submitted".
  - Legacy non-durable segment flow still shows Continue Recording and submits unchanged.

## Assumptions

- Affected builds have durable capture enabled; legacy segment recordings already have continuation UI.
- Button copy stays consistent with the app: stopped recordings use `Continue Recording`, paused recordings use `Resume`.
- Durable edited/uploaded files and support-staff recovered AAC copies remain non-appendable to avoid corrupting edited audio, already-confirmed uploads, or files without a native manifest.

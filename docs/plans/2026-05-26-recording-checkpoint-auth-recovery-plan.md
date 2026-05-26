# Active Recording Checkpointing and Silent Auth Recovery Plan

## Summary

Implement recommendations 3 and 5 as a single hardening pass:

- Add 5-minute active-recording checkpoints so completed audio is periodically converted into durable draft segments instead of living only inside one native recorder session.
- Add a silent auth/MFA recovery path so local draft recovery happens internally, with no PHI rendered until auth and MFA are complete.
- Prioritize preserving captured audio over continuing to record while locked. Background JS timers are unreliable, so v1 checkpoints while active, keeps the screen awake during recording, and flushes on background transitions. True locked-screen recurring checkpoints require a later native background recorder service.

## Implementation Changes

### Recording Checkpointing

- In `app/(app)/(tabs)/record.tsx`, add:
  - `RECORDING_CHECKPOINT_MS = 5 * 60 * 1000`
  - `CHECKPOINT_RESTART_DELAY_MS = 250`
  - `BACKGROUND_FLUSH_MIN_MS = 30_000`
- Track checkpoint rollover with refs for timer, in-flight status, restart slot, reason, and segment start time.
- When a slot is actively recording, schedule a 5-minute timer. On fire, verify the same slot is still recording, capture PHI-free telemetry, call `recorder.stop()`, and let the existing stopped-state effect save the segment.
- Extend the stopped-state capture effect so checkpoint stops save through the same `saveAudio()` and `draftStorage.saveDraft()` path, then restart recording for the same slot when safe.
- On `active -> inactive/background`, flush the current segment if it has run for at least 30 seconds. If the app is no longer active, defer restart until foreground return.
- Keep the screen awake with a recording-scoped keep-awake tag while recording or waiting to auto-resume.
- Capture PHI-free checkpoint events and breadcrumbs for requested, saved, background flush, and restart-failed states.

### Silent Auth/MFA Recovery

- Add a PHI-free recovery marker that stores only user id, draft slot id, route intent, saved timestamp, and reason.
- Write/update this marker after local draft persistence succeeds.
- Clear the marker when the associated local draft is deleted after upload, discard, or explicit cleanup.
- In auth startup and MFA completion, scan recovery intent and local draft existence after the user id is known but before PHI can render.
- Expose a pending recovery draft id through auth context and gate the authenticated layout while the scan is running.
- After auth/MFA completes, route to `/(tabs)/record?draftSlotId=<id>` so the existing `loadDraft` validation restores the recording.

## Public Interfaces And Types

- Add internal recovery intent types:
  - `RecoveryIntent`
  - `RecoveryIntentReason = 'checkpoint' | 'background_flush' | 'draft_finish'`
- Add auth context fields:
  - `localRecoveryState`
  - `pendingRecoveryDraftSlotId`
  - `consumePendingRecoveryDraftSlotId()`
- No server API or schema changes are required.

## Test Plan

- Verify text/static tests cover:
  - 5-minute checkpoint constants and timer scheduling.
  - Checkpoint rollover saves through `saveAudio()` and restarts the same slot.
  - Background transition uses the same checkpoint path.
  - Recovery intent stores no PHI fields and is cleared by draft deletion paths.
  - MFA-required auth does not clear recovery state and MFA completion returns to recovered drafts.
- Manual device testing:
  - Record past 5 minutes and confirm segment count increases while recording continues.
  - Lock/background during recording and confirm captured audio before background is preserved.
  - Force-close after a checkpoint, relaunch, complete auth/MFA, and confirm the draft loads.
  - Submit a recovered draft and confirm it promotes the existing draft without duplicate server rows.

## Assumptions And Defaults

- Use a 5-minute checkpoint interval.
- Save this plan under `docs/plans`.
- Silent recovery is the default: recover local drafts internally and show no PHI until auth and MFA complete.
- v1 does not promise continuous locked-screen recording with 5-minute background checkpoints because Expo/RN JS timers are not reliable while backgrounded.

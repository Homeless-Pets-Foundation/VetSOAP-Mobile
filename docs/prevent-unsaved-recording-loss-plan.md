# Prevent Unsaved Recording Loss Across Android and iOS

## Summary

The Peter Ellis recording was lost because the Android app process exited while the appointment audio still lived only inside the live `expo-audio` recorder/session state. It had not yet been stopped, saved as a draft, stashed, or uploaded. The immediate Android trigger was Google Play automatic protection/licensing code disconnecting from Play services and terminating the process (for example, `System.exit`).

This is the canonical implementation plan. The historical AAC storage analysis is preserved in `docs/durable-recorder-aac-storage-plan.md`, but implement from this file.

This plan prevents the same class of loss in two layers:

1. Remove the Android licensing/protection path that can terminate Captivet during recording.
2. Replace live-recorder-only durability with a native, cross-platform durable recorder that streams audio continuously to one growing app-private **ADTS AAC** file and recovers it after process death.

The durability mechanism is continuous capture-to-disk, not periodic save. A low-level capture pipeline reads small microphone buffers, immediately encodes them as AAC-LC ADTS frames, and appends them to `audio.aac`. A process kill loses only the audio still inside app-owned capture/encoder buffers, which must stay capped below 250 ms. A native commit marker drives UI/progress, but recovery uses the parser-derived complete ADTS prefix as the source of truth.

The recovery guarantee is: after capture has produced any complete ADTS frame, any app crash, process kill, Play-services restart, OS reclaim, OEM kill, or tablet lock/background transition leaves the on-disk file recoverable through its last complete ADTS frame. This plan does not protect against app data clear, uninstall, physical storage failure, physical device loss, or power loss before the OS flushes cached writes.

A critical anti-regression rule: the app must never stop/restart the microphone or encoder on a timer to achieve durability. User pause, slot switch, Finish, and OS interruption may deliberately release the microphone after flushing; uninterrupted active recording must remain one continuous capture pipeline.

References:

- Google Play Integrity / automatic protection: https://developer.android.com/google/play/integrity
- Android foreground service microphone requirements: https://developer.android.com/about/versions/14/changes/fgs-types-required
- Android Doze and App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby
- Android `AudioRecord`: https://developer.android.com/reference/android/media/AudioRecord
- Android `MediaCodec`: https://developer.android.com/reference/android/media/MediaCodec
- Apple background modes: https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes
- Apple `AVAudioEngine`: https://developer.apple.com/documentation/avfaudio/avaudioengine
- Apple backup exclusion guidance: https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey

## Phase 1: Android Hotfix

- Disable Google Play automatic protection for Captivet's Android app in Play Console App Integrity for every production/internal testing track that can reach clinic tablets. Do not rely on client-side Play licensing code that can terminate the app process. Captivet should continue relying on Supabase auth, server auth, and the existing `X-Device-Id` session binding/revocation model.
- Treat every already-installed protected APK as still vulnerable. Disabling protection in Play Console is not complete until a replacement build has been served and installed on clinic tablets. Ship a hotfix version after disabling protection, verify the installed package on target tablets is the unprotected served artifact, and use deployment tracking, a minimum-version gate, or clinic update instructions so production devices do not keep running the old PairIP-protected APK.
- Add a server-enforced minimum-version floor as a Phase 1 deliverable, not an optional mitigation. The app has no force-update/min-version mechanism today, and shared clinic tablets do not reliably auto-update, so "clinic update instructions" alone leave an unbounded window. The API already returns `401`/`428` device codes; add a min-version response (for example `426 Upgrade Required`) that the client honors by blocking new recording on builds below the durable-capable floor. State explicitly in rollout tracking that **until a device runs a durable-capable, flag-on build, the Peter Ellis loss class is unmitigated** — in-progress audio still lives only in live recorder state (`record.tsx` deliberately keeps the recorder running until Finish), so Phase 1 removes one kill cause but does not add recovery. Quantify and track the fleet still on non-durable builds.
- The minimum-version floor's client contract (so it enforces without bricking devices or stranding audio):
  - it gates ONLY the start-new-recording capability (and Resume→Continue, which appends new audio); the generic upload path for already-captured local audio (presign, R2 upload, `confirmUpload` of existing `segments[]`/durable recordings) MUST stay reachable on sub-floor builds, or the floor itself strands un-uploaded recordings (the loss class relocated from process-kill to forced-block; Rules 8/13). (A pre-durable sub-floor build has no `listRecoverableSessions`/`getStatus`/`purgeAfterUpload`; those durable-only ops are covered by the Rollout flag-off carve-out, which applies to durable-capable builds.) If the floor is ever raised ABOVE an already-durable build, recovery/listing/review/upload/discard/purge of existing durable manifests stay reachable on that sub-floor-but-durable build (mirroring the flag-off carve-out); only NEW capture and Resume→Continue are gated, so existing durable audio is always uploadable.
  - evaluation point and offline fail-direction: the client caches the floor from normal API responses; record-start consults the CACHED floor synchronously (no new network round-trip on the offline-first record path). Known-below-floor → block start with update-required copy even offline; floor unknown (device never reached the server) → fail open (allow) so a never-synced device is not bricked. If any record-start network check is ever added, it carries a Rule 24 `withTimeout` watchdog so a hang cannot block recording.
  - the `426` is handled by a dedicated `ApiClient` branch (not the generic `buildErrorMessage` fallthrough, which today would show "Something went wrong" and block nothing): terminal-non-auth — no token refresh, no sign-out, no retry (distinct from the `401 DEVICE_REVOKED` force-sign-out path and the Rule 16/22 refresh/retry loops) — surfacing update-required messaging and the typed code the record path reads to gate.
- Keep Play Integrity, if needed later, as a server-adjudicated API check only. The mobile client may request an integrity token, but the backend decides access. The client must never call `System.exit`, kill itself, discard local recordings, or block local recovery because Play services is unavailable.
- Add a release-artifact verification step before promoting any Android build:
  - inspect the Play-served artifact, not the locally-built AAB, because Google Play automatic protection is injected after upload
  - inspect served APK permissions/class names for `com.android.vending.CHECK_LICENSE`, `com.pairip.licensecheck`, and PairIP/licensing classes
  - fail the release if fatal licensing code is still present
  - run a tablet logcat smoke test while forcing Play Store/Play services restarts and verify no `LicenseClient`/PairIP fatal exit occurs
  - if no licensing/protection code is found, do not assume Phase 1 resolved the loss; re-investigate OS reclaim, OOM, OEM battery killer behavior, or another native crash. Phase 2's durable recorder remains the actual guarantee regardless of kill cause.
- Add a lightweight startup breadcrumb with only non-PHI process/session state: app version, process start time, user ID hash, and whether the previous process exited while recording. Extend it in Phase 2 with durable recording ID, slot ID, and whether recovery was offered.

## Durable Recorder Architecture

### Capture Pipeline

- Add a local Expo native module at `modules/captivet-durable-recorder`, with Android and iOS implementations. It replaces `expo-audio` for all recording capture. `expo-audio` may remain only for playback paths that do not affect recording durability.
- Use low-level streaming capture APIs:
  - Android: `AudioRecord` reads small PCM buffers on a dedicated capture thread, then feeds `MediaCodec` AAC-LC (`audio/mp4a-latm`).
  - iOS: `AVAudioEngine` input buffers feed `AVAudioConverter`/Audio Converter AAC-LC.
- The canonical durable file is one growing `audio.aac` ADTS file under the per-user durable recording directory:
  - shipping fail-safe default profile: AAC-LC, ADTS, 16 kHz, mono, 48 kbps. The 16 kHz rate is harmless for ASR (Deepgram/Whisper resample to 16 kHz regardless), but 48 kbps is the safe bitrate floor for the target environment (overlapping speakers, room/equipment noise, barking patients), where AAC-LC at 32 kbps/16 kHz (~2 bits/sample) introduces pre-echo/spectral smearing and is also a ~6× bits-per-second cut from today's 44.1 kHz/96 kbps capture.
  - storage-optimized profile: 16 kHz, mono, 32 kbps — adopt as the default ONLY if representative clinic-noise + multi-speaker transcription and SOAP output pass owner review against the current baseline (see Assumptions). Default to 48 kbps so a skipped validation ships the safer bitrate, not the riskier one.
  - runtime encoder fallback if 16 kHz is unsupported: 24 kHz, mono, 48 kbps
  - do not use MP4/M4A or HE-AAC for v1
- Platform implementations must write ADTS headers themselves when native encoders emit raw AAC access units:
  - Android skips codec-config buffers, derives ADTS profile/frequency/channel fields from the actual `MediaCodec` output format, and prepends ADTS headers to each encoded access unit before appending.
  - iOS derives profile/frequency/channel fields from the actual `AVAudioConverter` output format, writes ADTS headers per packet/access unit, and never writes an MP4/M4A container for the durable source.
- The end-to-end in-flight audio budget includes capture buffers, native conversion buffers, encoder input/output queues, and writer queues. If a device/OS encoder cannot keep encoded output lag below 250 ms during validation, that profile is unsupported on that device and must fail visibly or use the visible degraded recorder mode; do not claim the near-zero-loss guarantee on an unvalidated encoder path.
- The 250 ms cap is the steady-state figure. Separately, AAC-LC encoders (`MediaCodec`/`AVAudioConverter`) prime and may buffer several input frames before emitting the first output access unit, so time-to-first-complete-frame-on-disk at the very start can exceed 250 ms. A kill in the first ~0.5–1 s can yield ZERO complete frames even though the UI showed `recording`; that directory is then cleaned as transient scratch. This before-first-frame loss is inherent RAM loss already excluded by the recovery guarantee, but the encode-lag validation must explicitly measure time-from-`start()`-to-first-`recordingProgress` commit (not only steady-state lag), and a "kill at ~1 s after Start" native test must document the minimum recoverable point.
- Once the first ADTS frame is written, codec, AAC profile, sample rate, and channel count are locked for that `recordingId`. Resume must reopen the encoder with the same settings; if unavailable, leave the existing file recoverable and fail visibly instead of appending a different stream format.
- The durable recorder owns the microphone foreground service and audio session while recording. `expo-audio` must not also hold a recording session or microphone foreground service. The compatibility hook must guarantee there is only one recording owner.
- The single-owner rule covers capture-vs-capture; it must also cover playback-vs-capture on iOS. The iOS `AVAudioSession` is process-global, and `expo-audio` playback (`src/hooks/useAudioPlayback.ts` → global `setAudioModeAsync`) can deactivate or reroute a parked OR active durable capture session (for example: previewing a recovered slot while another slot is parked-recording, or `RecordingAudioPlayer` playing while a durable recording is paused). The durable recorder must own `AVAudioSession` activation; route all `setAudioModeAsync` calls through (or gate them against) the durable module — either choose a category/options that coexist with active/parked capture, or block playback while capture is active — and define resume-after-playback behavior.
- The native module is a singleton with one live microphone capture session. Multi-patient sessions may park multiple durable recordings, but only one slot may actively capture at a time. Slot-switch auto-pause must flush + park the leaving slot's durable recording (Resume reopens it with locked settings) before the incoming slot may `start()`; on pause failure during slot switch, fall back to a graceful stop that keeps the durable file recoverable, never silently abandon it. The existing reducer consistency guard (which forces an orphaned `recording` slot back to `stopped`/`idle`) must be re-specified for durable slots: an orphaned durable `recording` slot resolves to `stopped` referencing its durable `recordingId` (there are no `segments[]` to gate on), not to `idle`, so the audio is never dropped from session state.

### On-Disk Durability

- Durable files live under app-private, user-scoped storage:
  - Android: `context.filesDir/durable-recordings/{userId}/{recordingId}/`, with `allowBackup=false` still enforced
  - iOS: `Application Support/durable-recordings/{userId}/{recordingId}/`, with `NSURLIsExcludedFromBackupKey=true` and `NSFileProtectionCompleteUntilFirstUserAuthentication`
- `start()` pre-creates the durable directory, empty `audio.aac`, and seed `manifest.json`/active-recording index entry before opening the microphone. If the process dies immediately after Start, recovery must still find the seed manifest or an orphan `audio.aac` with at least one complete ADTS frame.
- iOS `AVAudioEngine`/Audio Unit callbacks must not block on disk I/O on the real-time render thread. Copy/convert into a bounded native ring/serial writer queue and return immediately. If any app-owned capture/encoder/write queue exceeds the 250 ms cap or repeated writes fail, stop capture gracefully, keep all complete frames already written, mark the manifest `error`, and show recoverable user feedback.
- The 250 ms cap protects the write side; protect the capture side too. Under sustained pipeline stall the Android `AudioRecord` ring buffer and the iOS `AVAudioEngine` input tap silently DROP PCM (overrun), producing in-recording audio gaps that never reach the encoder and are invisible to the ADTS prefix parser (the file stays well-formed). Therefore: size the `AudioRecord` buffer to several × `minBufferSize`, run capture on the dedicated high-priority read+enqueue thread, sample the native overrun/drop indicators, emit `durable_writer_backpressure` (or a capture-drop event) when drops occur, and state in the guarantee that a stall degrades to bounded in-recording gaps plus a graceful stop — not only tail loss.
- A native timer updates a small manifest every about 2 seconds via atomic write (temp + rename). It records `committedBytes`, `completeFrameBytes`, `adtsFrameCount`, running peak, state, timestamps, and errors. The manifest is a bounded sidecar; it must not grow with every frame.
- `committedBytes` is a lower-bound UI hint, not the recovery source of truth. The valid prefix through the last complete ADTS frame is the source of truth. A stale or one-version-old manifest must not prevent recovery.
- Recovery enumeration must be native, incremental, bounded, and off the UI thread. Do NOT re-parse a multi-hundred-MB `audio.aac` from byte 0 on the launch hot path: at 16 kHz/32 kbps a 240 MB file is ~900k frames and a cold-start full-file scan (for one or several sessions) blocks launch and can ANR — on the very recovery path that is this plan's reason to exist. Seek to `completeFrameBytes` — the last manifest-confirmed frame boundary — and re-validate only a bounded tail. `completeFrameBytes` is the sole safe seek anchor; never seek to `committedBytes` (a UI hint that can land mid-frame). Before trusting the tail seek, require (a) on-disk file size ≥ `completeFrameBytes` and (b) a valid ADTS sync word at the seek offset; if either fails, the manifest is missing/unparseable, or the manifest carries an `anchorsPending` sentinel (set during edit-commit until anchors are finalized — present both before and after the byte swap), fall back to the byte-0 parse (still incremental, off-thread, watchdog-guarded): recompute `durationMs`/`adtsFrameCount`/`completeFrameBytes` from the ADTS prefix, and KEEP the last manifest-persisted `peakDb` (it is PCM-domain, measured pre-encode, and is not derivable from encoded ADTS without decoding). After a byte-0 reparse, atomically (temp+rename) re-finalize the manifest with the recomputed anchor set so later launches use the fast tail-seek path rather than re-parsing every time. Resolve an `anchorsPending` sentinel per the edit-commit disambiguation (Editing for v1): clear it (edit settled) only once the on-disk bytes are confirmed to DIFFER from the persisted pre-edit anchors (the swap landed); if the bytes still match the pre-edit anchors the edit did not land — keep it flagged "edit not yet applied" rather than clearing the sentinel as cleanly edited. The byte-0 parse is the correctness fallback, not the default. The enumeration returns quickly with a `validating` placeholder and is wrapped by a Rule 24 watchdog (CLAUDE.md) that flips the gate if it stalls — the tail is bounded under normal ~2 s commit cadence, but a stalled commit timer can enlarge it, in which case the off-thread parse + placeholder + watchdog (not a size bound) prevent the ANR. The flag-off / JS recovery path inherits the same bounded, watchdog-guarded performance contract.
- ADTS prefix parsing guarantees a syntactically complete, uploadable ADTS stream through the last complete frame (sync word + `frame_length`); it does not prove each AAC payload is a decodable access unit. Payload-level decode integrity is delegated to the decoder/ASR, which tolerates sparse bad frames. "Source of truth" is scoped against `committedBytes`/the manifest, not against codec output quality.
- Pause, stop, and clean interruption handling must drain pending encoder output, append any complete ADTS frames, force/fsync the AAC file, and atomically update the manifest before returning.
- Pause/resume creates an audible timeline discontinuity only if the microphone was intentionally paused/interrupted; it does not create a new logical upload segment. Appending after resume is valid only when the encoder settings match the existing ADTS stream.
- If ADTS parsing finds a malformed frame before EOF, recover only the valid prefix before that frame and mark the manifest `error`. Do not scan forward for a later sync word in v1.
- A zero-byte durable directory or `audio.aac` with no complete ADTS frame contains no recoverable clinical audio and may be cleaned as transient scratch. Cleaning it must also remove the associated active-durable / recovery-intent metadata key (written by `start()` before the first frame), so a death between seed-manifest and first frame does not leave an orphaned SecureStore key pointing at a directory that was swept. Recovery-state cleanup runs on the launch scan, never on a timer that could fire before `setUserId`.

### Storage Policy

No free-disk helper exists in the app today (`fileOps.ts` has no capacity API), so add a small cross-platform free-space helper and assign each gate a layer: the pre-record 500/250 MiB checks run in JS (`expo-file-system` `getFreeDiskStorageAsync`) at Record-tab mount/start; the while-recording 100 MiB graceful-stop is polled by the native capture loop (it already runs a native timer; a JS poll can be starved or backgrounded), which marks the manifest and emits a low-space stop event. Do not assume a capacity API already exists.

- Warn below 500 MiB free.
- Block new recordings below 250 MiB free.
- While recording, gracefully stop and preserve all complete AAC frames if free space drops below 100 MiB.
- While recording, warn when `audio.aac` reaches 225 MB and gracefully stop before it reaches 240 MB. This keeps the source safely below the 250 MB server file limit.
- Before edit/export/transcode work, require estimated output size plus temporary workspace plus 100 MiB safety margin.
- Do not keep a simultaneous raw duplicate of a successful AAC capture. Raw PCM may exist only inside bounded native buffers or in explicit temporary editor scratch that is deleted after use.
- If AAC encoding fails mid-recording, preserve the last complete AAC frame, mark the manifest recoverable/error, and show user feedback. Do not switch the same recording to persistent PCM. For v1, degraded fallback is the existing `expo-audio` capture path only when durable capture fails before a durable AAC recording starts; it must be visibly labeled as not crash-recoverable.
- If a recovered AAC source already exceeds the 250 MB server limit due to an older build or bug, do not purge it. Block normal submit, keep the local file recoverable, emit non-PHI telemetry, and show a contact-support recovery message. Do not add a generic share/export button in v1.

### Manifest And Type Contract

Expose this TypeScript API from `modules/captivet-durable-recorder/index.ts`:

```ts
type DurableRecorderState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'interrupted'
  | 'stopped'
  | 'uploaded'   // server confirmUpload succeeded; excluded from recovery so an already-submitted recording is never re-offered
  | 'error';

type DurableAudioFile = {
  uri: string;              // audio.aac
  committedBytes: number;   // lower-bound UI hint
  completeFrameBytes: number;
};

type DurableRecordingManifest = {
  schemaVersion: 3;
  recordingId: string;
  userId: string;
  slotId: string;
  state: DurableRecorderState;
  startedAt: string;
  updatedAt: string;
  container: 'adts';
  codec: 'aac_lc';
  bitrate: 32000 | 48000;
  sampleRate: 16000 | 24000;
  channels: 1;
  adtsFrameCount: number;
  durationMs: number;       // recovered/upload duration from complete ADTS frame count
  capturedDurationMs: number; // last live-snapshot UI duration from PCM samples; NOT the authoritative upload duration (use durationMs)
  audioFile: DurableAudioFile;
  peakDb: number;           // running peak from PCM input before encoding
  appVersion: string;
  buildNumber: string;
  lastErrorCode?: string;
  serverRecordingId?: string;   // server recording row id; persisted atomically (temp+rename) the MOMENT create()/createWithFile() returns the id — BEFORE the R2 PUT/confirm. Presence does NOT mean confirmed-uploaded; it is the death-surviving anchor that lets recovery reconcile instead of fresh-creating a duplicate.
  confirmedUploadAt?: string;   // the SOLE confirmed-upload signal (written with state 'uploaded' after confirmUpload). Recovery excludes a manifest only on state==='uploaded'/confirmedUploadAt, never on serverRecordingId alone.
  edited?: boolean;             // set true at edit-commit; the durable source is the edited audio.aac (anchors recomputed). Manifest-derived gate for Continue/Add-More — never a slot/stash flag a round-trip could lose.
  anchorsPending?: boolean;     // transient: set with edited=true BEFORE the edit-commit byte swap, cleared when anchors are finalized. Forces a byte-0 reparse on recovery so a stale pre-edit durationMs/anchors are never trusted.
};

start(input: {
  userId: string;
  slotId: string;
  recordingId: string;
  commitIntervalMs?: number;
}): Promise<DurableRecordingManifest>;

pause(): Promise<DurableRecordingManifest>;
resume(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest>;
stop(input?: { userId?: string; recordingId?: string }): Promise<DurableRecordingManifest>;
discard(input: { userId: string; recordingId: string }): Promise<void>;
purgeAfterUpload(input: { userId: string; recordingId: string }): Promise<void>;
getStatus(): Promise<DurableRecordingManifest | null>;
getManifest(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest | null>;
listRecoverableSessions(userId: string): Promise<DurableRecordingManifest[]>;
```

Native events:

```ts
recordingProgress   // ~2s durable commit tick: { committedThroughMs, completeFrameBytes, peakDb }
liveStats           // high-frequency UI feed (>= ~10 Hz, push or pull via getLiveStats):
                    //   { meteringDb, capturedDurationMs } -- read from PCM input pre-encode
stateChanged
interruption        // { reason: 'focus_loss' | 'route_change' | ... }
error               // { code, message } -- never terminates the process
```

Implementation rules:

- All native errors are reported as typed error codes and events. Native code must not terminate the process.
- The commit marker runs on a native timer/thread. JS timers are not acceptable for durability.
- Three duration/progress quantities have distinct, fixed roles; do not conflate them:
  - `capturedDurationMs` is the live headline elapsed-time quantity; the on-screen recording timer binds to the high-frequency `liveStats` feed (its live value), and the manifest field is only its last snapshot — not the upload duration.
  - `committedThroughMs` (event/hook field, NOT a stored manifest field) is the time-domain equivalent of `completeFrameBytes` — how far the recording is durably saved — and drives only the secondary "saved-through" indicator. It is derived, not persisted.
  - `durationMs` (manifest) is the frame-derived authoritative duration (1024 samples/frame × actual sample rate) used for recovered/upload duration and is the value persisted into `PatientSlot`/stash and sent at upload. `capturedDurationMs` is only a last-live-snapshot in the manifest, never the persisted/upload value.
- The `liveStats` UI feed is INDEPENDENT of the ~2 s durable commit timer and must preserve the existing live metering/duration cadence (`getLiveStats`/`RecorderLiveReadout`): 500 ms foreground (the responsiveness Rule 6 calls for) and the existing 2000 ms background throttle. Wiring the live level meter/timer to the 2 s commit cadence is a UX regression and is not acceptable.
- Rule 12: where the compatibility hook / `record.tsx` log native `error` events, gate `console.error` behind `__DEV__` and never log PHI-shaped payloads (the typed `{ code, message }` events carry no patient/form data — keep it that way).
- Validate `userId`, `slotId`, and `recordingId` natively on every entry point before touching the filesystem. Reject values containing `/`, `\`, `..`, NUL, or characters outside `[A-Za-z0-9_-]`.
- Do not infer user scope from `recordingId`. Every operation addressing a parked/non-current durable recording includes `userId` and resolves only under that user's durable root.
- `discard()` is only for explicit user discard/delete. `purgeAfterUpload()` is only called after server-confirmed upload and local post-upload cleanup.
- Keep local durable recording IDs separate from server draft/recording IDs. `serverDraftId` still lives in draft metadata / `PatientSlot`.

## App Integration

- Refactor `src/hooks/useAudioRecorder.ts` into a compatibility hook backed by `captivet-durable-recorder`.
  - Preserve existing outward states where practical.
  - Add durable fields: `activeDurableRecordingId`, `recoverableDurableRecordingId`, `committedThroughMs`, `completeFrameBytes`, `lastCommitAt`, `mimeType: 'audio/aac'`.
  - Lazy-load the native module (CLAUDE.md Rule 19) so old dev clients or missing modules do not crash at module load. The `modules/captivet-durable-recorder/index.ts` JS bridge must not throw at module load (Rule 1): wrap the `requireNativeModule`/`requireOptionalNativeModule` call so an absent module degrades to the `expo-audio` fallback instead of crashing import.
  - Preserve the Rule 6 error contract in the compatibility hook regardless of the new native backend: `stop()` swallows native rejections and always clears state/URI; `pause()`/`resume()` catch the native rejection, leave the on-disk file recoverable (flush + mark manifest, capture `committedThroughMs`), reset audio mode, and rethrow / surface user feedback (Alert or banner) so `record.tsx` reacts. The native "mark manifest `error`, keep frames" behavior gives on-disk durability but does NOT by itself satisfy the JS-side caller-feedback + state-cleanup contract — a single native interrupt must not permanently corrupt the hook.
- This is a real refactor of the capture-to-segment flow:
  - Unedited slot equals one durable `recordingId` for the whole appointment.
  - Pause parks the file; Resume appends to the same `audio.aac`.
  - Finish stops and saves draft metadata, but does not create copied segment files.
  - There is no stop-time `audioUri` segment append. `PatientSlot` records the durable `recordingId`, frame-derived `durationMs`, peak, format (codec/sampleRate), and server draft IDs; `durationMs` (not `capturedDurationMs`) is the persisted/upload duration.
  - The durable `recordingId` is the sole pointer to the on-disk audio (`segments[]` is empty). Per Rule 20 it MUST round-trip through all three stash sites or Resume restores a slot with no audio reference and permanently orphans `audio.aac` — a failure worse than the documented duplicate-recording bug. The three sites: (1) `StashedSlot` type (`src/types/stash.ts`), (2) `stashAudioManager.moveSegmentsToStashDir()` write, (3) `useStashedSessions.convertToPatientSlots()` read. Carry `recordingId` plus `codec`/`sampleRate`/`bitrate` so Resume reopens the encoder with locked settings. Rule 15: a restored/stashed durable `recordingId` is validated on the native entry points (charset + path-traversal guard, resolves only under the user's durable root), preserving the no-remote-URI guarantee that `validateSegments()` gave the old `segments[]` restore path.
  - Interruption stays within the same durable recording; it must not append a separate file-URI segment.
- In `app/(app)/(tabs)/record.tsx`:
  - generate the local durable `recordingId`, write best-effort active draft metadata with short watchdog timeouts, then call native `start()`
  - wrap native `start()`/`stop()`/`pause()`/`resume()` in a `withTimeout` (~8–12 s) hard watchdog (Rule 24): native mic/FGS acquisition and `AVAudioEngine`/`AudioRecord` open can hang silently on locked storage or permission edge cases, and these calls gate the `starting`/stopping render states. On timeout, flip out of the gating state into a recoverable `error` and emit `captureMessage('durable_recorder_op_watchdog', 'warning', ...)`. The launch recovery scan (`listRecoverableSessions()`/`getStatus()`) gets its own timeout so a hung scan stalls only the recovery badge, never app entry.
  - update metadata on form edits with a short debounce and on AppState background
  - show the live headline timer from `capturedDurationMs` (high-frequency `liveStats` feed) and the secondary saved-through indicator from `committedThroughMs`
  - warn if no `recordingProgress` commit lands within 5 seconds while recording (soft warning; the Rule 24 watchdog above is the hard gate)
  - run every durable native op from non-async RN callbacks that catch rejections (Rule 2/4). This explicitly includes the `AppState` `change` handler used for the background metadata write AND the `AppState` `'active'` microphone re-acquire path (see Background Recording Reliability): both must have an outer try/catch and reset any in-flight/gating state in `finally`, not just the pause/stop/slot-switch/sign-out callbacks.
- Submit for v1:
  - a slot is **durable** iff it carries a durable `recordingId` — it uploads its `audio.aac` whether or not it has been edited (edit-commit replaces the `audio.aac` bytes in place; see Editing for v1) — otherwise it is a **legacy `segments[]` (m4a)** slot. Whether a durable recording was edited is a manifest-derived flag (`manifest.edited`), read from the manifest by the Continue/Add-More block and any edit-aware logic — never a slot/stash-carried flag a round-trip could drop. Every submit-path consumer — upload-helper selection, filename, `contentType`, silent-audio-guard input, oversized-split gate, editor input, draft/stash load, "Not Submitted" loader — branches on durable-vs-legacy. Legacy m4a recordings created before rollout (drafts/stashes survive every logout, Rules 8/13) keep their existing `audio/x-m4a` + `segments[]` path unchanged and coexist indefinitely with durable AAC.
  - upload unedited durable recordings directly as `.aac` with `contentType: 'audio/aac'` when the full file is under the 250 MB server limit
  - update the mobile upload API so the single-file path accepts an explicit upload filename or derives it from URI/content type; never call a helper that hardcodes `recording.m4a` while passing `audio/aac` (the current `createWithFile` hardcodes `recording.m4a` regardless of `contentType` — `recordings.ts` — and must gain an explicit/derived filename). The new explicit-filename `createWithFile` branch retains Rule 9 pre-upload validation: `getInfoAsync` non-empty + 250 MB limit + `R2_UPLOAD_TIMEOUT_MS` `withTimeout`.
  - bypass the current oversized `maybeSplitForUpload()`/FFmpeg path for durable AAC; that path is for legacy segment uploads and can create server-unsafe ADTS multi-segment inputs
  - the silent-audio guard iterates `slot.segments[].peakMetering` and fails OPEN when metering is absent; a durable recording has empty `segments[]`, so the guard becomes a no-op for every durable upload unless `peakDb` is actively wired in. The durable submit path must construct a single synthetic metering entry from manifest `peakDb` (`uri` = the durable `audio.aac` for any fallback) rather than relying on the empty `segments` array, and `peakDb` must be normalized to the same dBFS reference as expo-audio's `peakMetering` before comparing against the `-35 dBFS` threshold, or the silent check misfires.
  - confirm upload without `segmentKeys` in v1
  - the durable submit must be crash-safe against duplicate server rows at EVERY step, including the fresh-create path (offline Finish leaves no `serverDraftId`, so `uploadSlot` falls through to a fresh `createWithFile()`). Ordered, death-surviving steps:
    1. as soon as the server row id is known — `create()`/`createWithFile()` returning it on the fresh-create path, or the existing `serverDraftId` on the promote path — persist `serverRecordingId` into the manifest atomically (temp + rename), BEFORE the R2 PUT/confirm. This is the anchor a post-create kill needs.
    2. the durable fresh-create also sends a DETERMINISTIC idempotency key derived from the durable `recordingId` (on disk before Start), so a retried `create()`/`createWithFile()` after a kill reuses the same server row instead of duplicating. Do not use a `Math.random` idempotency key here — rule 21 permits Math.random only for non-durable keys, and a random key is lost on process death.
    3. immediately after `confirmUpload` returns success, and BEFORE `deleteDraft`/local audio cleanup, atomically write the manifest to state `uploaded` with `confirmedUploadAt`. This — not the mere presence of `serverRecordingId` — is the confirmed signal recovery excludes on.
    4. re-submit of ANY recovered durable recording routes through the `existingRecordingId` promote path keyed on `serverRecordingId`/`serverDraftId`, or relies on the deterministic idempotency key — never a blind fresh `createWithFile()`/`create()` (which creates a duplicate server row, the Rule 20 duplicate-recording class; distinct from the Rule 8 "Lela" un-uploaded-loss class).
  - only after the `uploaded` marker is durably written, clean up in strict order (same contract as the launch self-heal): delete the linked draft + local audio FIRST, then — only if that delete succeeded — call `purgeAfterUpload({ userId, recordingId })` and write the purged-uploaded tombstone, so `cleanupOrphaned` never races a draft whose backing manifest just vanished. On draft-delete failure, leave the `uploaded` manifest for next-launch self-heal (purge is idempotent) and still write the tombstone. On next launch an `uploaded` manifest still on disk is self-healed (see Recovery UX), not re-offered.
- Editing for v1:
  - the editor may use WAV/PCM only as temporary scratch with free-space checks and cleanup
  - the saved edited output must be one derived draft-owned AAC/ADTS file under 250 MB
  - an edited durable recording UPLOADS the edited audio — never the pre-edit audio (which would silently drop the edit) and never a legacy m4a segment (which routes through the unsafe FFmpeg/`maybeSplitForUpload` path). Keep the SAME durable `recordingId`/manifest — do NOT mint a second `recordingId`, which would leave a second manifest re-offerable by `listRecoverableSessions` and re-submittable over the shared server row, dropping the edit. Edit-commit makes the derived file the new canonical `audio.aac`, so every `audio.aac`-keyed recovery/scanner path keeps working unchanged. It is a 3-state commit, because the bytes (`audio.aac`) and the manifest are two files that cannot be made jointly atomic: (1) write the derived AAC to a temp path, fsync; (2) parse its frames and compute the FULL new anchor set — `adtsFrameCount`, `durationMs`, `peakDb`, `audioFile.completeFrameBytes`, `audioFile.committedBytes`; (3) atomically write a manifest INTENT marker — `edited: true` plus an `anchorsPending` sentinel — BEFORE touching the bytes; (4) atomically rename the derived temp onto `audio.aac` (the one allowed replacement of the original bytes, because the edit is now authoritative); (5) atomically (temp+rename) finalize the manifest with the full recomputed anchor set (`audioFile.uri` stays `audio.aac`, `edited: true`, sentinel cleared). This ordering makes the edit crash-atomic. Recovery disambiguates the two intermediate windows by whether the on-disk `audio.aac` still matches the manifest's persisted anchors: (i) crash after the intent marker but before the swap — bytes still MATCH the (pre-edit) anchors while `edited:true`+`anchorsPending` are set, so the edit did NOT land; surface the recording as "edit not yet applied — re-apply before submit" rather than as a clean edited upload, so the user re-edits instead of silently submitting unedited bytes under an edited label; (ii) crash between swap and finalize — bytes do NOT match the stale anchors (e.g. a trim shrank the file), so the swap landed; complete the interrupted finalize by recomputing `durationMs`/`adtsFrameCount`/`completeFrameBytes`/`committedBytes` from the actual bytes (keeping the last persisted `peakDb`, which is PCM-domain and trimming cannot raise), clearing `anchorsPending`, and Continue stays blocked. (Edge: if the recovered edited duration is drastically shorter than the persisted pre-edit duration — an extreme trim toward silence — re-derive `peakDb` by decoding before the silent-audio guard rather than trusting the pre-edit peak, so a now-silent edit is not waved through.) Do NOT reorder to finalize-the-manifest-before-the-swap: that would persist clean edited anchors over pre-edit bytes with no `anchorsPending` to flag it. ANY change of the durable bytes MUST end with the manifest's frame/byte anchors recomputed from those bytes; the line-82 byte-anchor validation + byte-0 fallback are the recovery backstop for the brief two-file window where `audio.aac` and the manifest are not yet jointly consistent. The slot keeps the one `recordingId`, so its draft/stash reference still suppresses it and `serverRecordingId` stays on the single server row. Upload `audio.aac` as `audio/aac` with a `.aac` filename, bypass `maybeSplitForUpload`, and feed the recomputed `peakDb` to the synthetic silent-audio metering entry.
  - the edit must NOT mutate the original `audio.aac` bytes in place: write the derived AAC to a SEPARATE temp path and fsync before the atomic rename (steps 1–2 above). Until the byte swap lands, the original `audio.aac` stays fully recoverable, so a crash before commit yields the unedited recording intact (the edit is simply not yet applied). At edit-commit the `audio.aac` bytes are replaced (atomic rename) and the manifest is rewritten in place with recomputed anchors + `edited:true`; the `recordingId` and the manifest's IDENTITY persist (no second `recordingId`/manifest is minted), and it is removed only via the normal confirmed-upload purge. A half-written derived temp is never mistaken for the canonical source — it carries a recognizable temp suffix the launch scratch sweep reclaims.
  - the launch-time recovery scan also sweeps and deletes orphaned editor scratch not owned by the current session — both WAV/PCM scratch AND any pre-rename derived-edit AAC temp (write derived temps to a recognizable suffix/dir the scan reclaims) — so a kill mid-edit strands no scratch of any format and cannot leave a multi-hundred-MB file that later trips the 250 MiB new-recording block. Do not rely on sign-out-only transient cleanup for editor scratch.
  - after editing (`manifest.edited === true`), block Continue/Add More Info with a clear warning; do not upload mixed edited/tail multi-segment AAC until a later server-supported design exists. Because `edited` is read from the manifest, a stash round-trip that drops other fields can never wrongly re-enable Continue on a resumed edited slot.

## Draft, Stash, Sign-Out, And Recovery Storage

- Add active durable recording metadata separate from normal finished `DraftMetadata`. Do not reuse `draftStorage.saveDraft()` for active recordings: contrary to a tempting assumption, it does NOT reject a zero-segment input — its only empty-result throw is guarded by `slot.segments.length > 0 && draftSegments.length === 0` (the "had segments, all copies failed" case), so a durable slot with empty `segments[]` silently writes a `DraftMetadata` with `segments:[]`, `audioDuration:0`. `draftHasLocalAudio()` then reports it as no audio and `cleanupOrphaned()` DELETES it (server row included) via the `emptyButServerLinked` branch. The real hazard is silent empty-draft creation + later orphan deletion, which is exactly why active durable recordings need separate metadata.
- Active durable metadata, durable recovery intent keys, AND the purged-uploaded tombstone (see Recovery UX) must survive `secureStorage.clearAll()` like `RECOVERY_INTENT` and `DEVICE_ID`, and all are user-scoped (`setUserId` before read/write, Rule 13). Clear active-durable / recovery-intent keys only from explicit discard or confirmed-upload purge. The tombstone must survive sign-out specifically because the linked `emptyButServerLinked` draft survives logout (Rule 8) and reappears on re-sign-in — if the tombstone were wiped, an offline re-sign-in self-heal could delete the just-uploaded server row. Prune a tombstone entry only once both the linked draft and manifest for that `recordingId` are confirmed absent (no later pass can match it), or FIFO-cap the list, so it does not grow unbounded in chunked SecureStore on long-lived clinic tablets.
- Finished drafts reference the durable `recordingId`/`audio.aac` source instead of copying the AAC file into `drafts/{userId}/{slotId}/seg_N.m4a`. This avoids double-storing the recording.
- `draftStorage.cleanupOrphaned()`, `draftHasLocalAudio()`, pending-draft scans, and Home "Not Submitted" card loading must treat a valid non-purged durable AAC manifest as local audio even when `segments[]` is empty. Specifically: `cleanupOrphaned()`'s `emptyButServerLinked` branch tests `segments.length`/`serverDraftId` directly and does NOT consult `draftHasLocalAudio()`, so the durable-manifest awareness must be added to that branch itself (skip the sweep — and the server-row delete — when a valid non-purged durable manifest backs the draft), not only via `draftHasLocalAudio()`'s return value. Otherwise the orphan sweep destroys durable drafts on the next Record-tab mount. Independently, the `emptyButServerLinked` branch must reconcile server status (`getStatus`) before deleting any server row, must FAIL CLOSED — defer the delete when `getStatus` is unverifiable (offline), mirroring Rule 13's `evictExpired` offline deferral — and must skip deletion for any row in an uploaded/processed state or whose `recordingId` is in the persistent purged-uploaded tombstone. This is the second guard against the `uploaded`-marker→`deleteDraft`-window data-loss path above (clinic tablets are frequently offline, so a fail-open delete there would destroy a just-uploaded recording).
- A stopped durable recording that already has a draft (or stash) entry surfaces once via that existing card, not also as a separate recovery card — see the Recovery UX suppression rule for the `recordingId` suppression-key detail (across drafts and stashes).
- Existing 30-day draft/stash eviction must not silently delete any non-purged durable recording in `starting`, `recording`, `paused`, `interrupted`, `stopped`, or `error`.
- Save for Later must accept paused/stopped durable AAC sources with no materialized segments. Stash metadata must round-trip local durable recording ID, server draft ID, slot ID, frame-derived `durationMs`, peak, format (codec/sampleRate/bitrate), and future idempotency fields — through all three Rule 20 sites (see App Integration). The stash capacity cap (`MAX_STASHES`) must not silently drop a recovered recording: if "Save for Later" is invoked during recovery and the cap is reached, surface a clear choice (submit/discard an existing stash, or keep the recovery card) rather than failing the save and stranding the audio. A crash mid-`stashSession` (stash metadata written, draft not yet deleted) can transiently surface one recording as BOTH a Saved Session and an amber "Not Submitted" card; on launch, reconcile a draft whose `recordingId` is also stash-referenced by deleting the orphaned draft (stash owns the audio post-commit) so it surfaces once. No data/dup risk (submit reuses the server row via promote), but it keeps the surface clean.
- Sign-out must not delete active/recoverable durable recordings or edited derived audio. `support_staff` sign-out must preserve durable AAC manifests and files into the existing recovery-vault path. The current vault builders (`supportStaffRecoveryVault.ts`) iterate `slot.segments`/`draft.segments` and skip any item whose segment files do not exist — so a durable item with empty `segments[]` backed only by `audio.aac` is skipped today. The vault builders (`buildItemFromSlots`, `buildDraftItemsForSource`, `buildStashItemsForSource`, `itemHasAudio`) must treat a valid non-purged durable manifest as recoverable audio and copy/reference `audio.aac` rather than skipping on absent segment files.

## Background Recording Reliability

Prevention is best-effort; durability plus recovery is the guarantee.

- Use a correctly typed Android microphone foreground service for every active capture period, with an ongoing user-visible notification.
- iOS background-capture parity (the section is otherwise Android-detailed): declare `UIBackgroundModes: audio` in the iOS config, activate the `AVAudioSession` `playAndRecord` category with options that keep capture alive when backgrounded or while the device locks, and rely on `NSFileProtectionCompleteUntilFirstUserAuthentication` (already required under On-Disk Durability) so writes continue on a locked device after first unlock. Define the same flush-on-interruption / resume-on-`active` behavior as Android.
- Hold a `PARTIAL_WAKE_LOCK` for active recording only; release on pause/stop. The `WAKE_LOCK` permission is already declared in `app.config.ts` — no config-plugin change is needed; implement only the acquire-on-record / release-on-pause-stop logic (do not add a duplicate permission entry).
- Detect audio focus loss inside the durable recorder. On non-`duck` loss, flush, mark `interrupted`, and keep the file. On gain, resume appending to the same recording only when allowed; if the microphone is briefly still held, retry with bounded backoff and show a user-visible banner/manual resume affordance rather than leaving capture silently stuck. If backgrounded, defer re-acquiring the microphone to AppState `active` or notification tap.
- Fold in or consume the existing `modules/captivet-audio-focus` listener. Do not leave two modules independently reacting to the same Android audio-focus session.
- OEM battery killers cannot be fully prevented. Add best-effort setup for battery-optimization settings, including known-aggressive OEM nudges that deep-link only when the intent exists. Default to the lower-risk settings deep link (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`). Use the direct `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` prompt and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission only if product/legal explicitly approves it for managed clinic tablets. Never crash if a setting intent is absent.
- Best-effort `Service.onTaskRemoved`/`onDestroy` may flush/mark interruption for clean shutdowns, but recovery must not depend on those hooks.

## Server Compatibility Gates

- Mobile/API presign allowlists already include `audio/aac`, but production rollout is blocked until the processing job accepts ADTS AAC:
  - `isLikelyAudio()` must recognize ADTS by validating at least the first few ADTS frames, not just a two-byte sync prefix
  - single-file `.aac` uploads must reach Deepgram with `mimetype: 'audio/aac'`
  - end-to-end validation must use an actual ADTS file generated by the native module, not a renamed M4A/MP4 file
- Durable rollout is ALSO blocked until the server `create()`/`createWithFile()` endpoint enforces idempotency on the client-supplied deterministic key (unique constraint / upsert returning the existing row). This is the only thing that closes the pre-response kill window: the server inserts the row, the process dies before the client receives and persists `serverRecordingId`, and the offline-Finish path (no `serverDraftId`) then retries a fresh `create()` with the same deterministic key. Without server enforcement that key is decorative and the window produces a duplicate server row (Rule 20 class). If server idempotency is out of scope for v1, make `serverRecordingId`-persist the sole dedup and explicitly document that the pre-response kill window can still duplicate.
- V1 must avoid multi-segment AAC uploads. The current server job concatenates multi-segment recordings by writing every segment as `.m4a`, running FFmpeg copy concat, and reuploading `audio/mp4`; that path is not safe for ADTS AAC parts.
- If a future v2 needs split AAC uploads, implement server support first: preserve ordered `segmentKeys`, validate every segment as ADTS with matching codec/sample-rate/channel metadata, concatenate by an ADTS-aware path, and pass `audio/aac` to transcription. Keep the existing 20-segment confirm-upload cap.

## Rollout And Fallback

- Phase 1 ships independently and first. It must not wait on durable-recorder work.
- Gate the durable recorder behind a runtime flag so new capture can fall back to the current `expo-audio` path without a store release. The presign allowlist already accepts `audio/aac`, so an `.aac` PUT + `confirmUpload` SUCCEEDS even when the server processing job cannot yet parse ADTS (validation happens later, server-side, after confirm returns) — and the plan purges local audio on confirm. So a premature flag flip (before the VetSOAP-Connect ADTS deploy lands) uploads, confirms, purges locally, then fails server-side ADTS validation, leaving the recording stuck with bytes only in R2. Make the capture flag server-driven (remote config owned by the same deploy that ships ADTS acceptance) so a client cannot enable ADTS capture against a server that cannot process it. (Do not instead defer `purgeAfterUpload` until post-validation: the manifest is already marked `uploaded` at confirm, so the launch self-heal would purge the local AAC regardless and re-strand bytes in R2 — the server-driven flag is the clean control.) Treat the manual release gate (Server Compatibility Gates) as a backstop, not the sole control.
- The runtime flag gates new capture only. Recovery, listing, review, upload, discard, and purge for already-existing durable manifests must remain available after the flag is turned off.
- Existing durable AAC files must not be stranded if capture is disabled or the capture module fails to load. ADTS parsing, manifest reads, direct single-file upload, discard, and purge must either live in JS/shared code or in a lightweight recovery path that remains callable when new native capture is disabled. If neither path is available on a build, surface an update-required recovery state and keep the local file untouched.
- If the native module fails to load/start, fall back to `expo-audio` capture, emit non-PHI telemetry (`durable_recorder_unavailable`), and show that crash-recovery durability is unavailable. Never hard-crash or block recording because the durable module is unavailable.
- Staged rollout: internal testing, small production cohort, full rollout. Do not advance while commit-lag, native-fatal, processing, or recovery alerts are firing.

## Recovery UX

- `listRecoverableSessions(userId)` returns every manifest whose state is `starting`, `recording`, `paused`, `interrupted`, `stopped`, or `error`, as long as `audio.aac` has at least one complete ADTS frame. It must EXCLUDE state `uploaded` / any manifest carrying `confirmedUploadAt` (the sole confirmed-upload signal) — local-state-plus-frames is not enough, because a recording confirmed-uploaded but not yet purged is still `stopped` on disk. It must NOT exclude on `serverRecordingId` alone: a manifest carrying `serverRecordingId`/`serverDraftId` but lacking `confirmedUploadAt` is created-but-not-confirmed (in-flight `PendingConfirm` before the kill), still recoverable, and must be reconciled (below), not hidden.
- On launch, any `uploaded` manifest still present is self-healed, not surfaced. Order is load-bearing: FIRST delete the linked finished draft (by `draftSlotId`/`recordingId`) and its local audio, THEN call the idempotent `purgeAfterUpload` (a native file delete with no `draftStorage` knowledge, which removes the manifest). Deleting the draft strictly before the manifest disappears means `cleanupOrphaned` never sees an orphaned draft with a missing backing manifest. Also record the purged `recordingId` in the persistent, user-scoped, bounded purged-uploaded tombstone (lifecycle defined under Draft/Stash: survives the manifest delete and `clearAll()`, pruned once draft+manifest are both gone) that `cleanupOrphaned` consults. Without the ordering + tombstone, a mid-flight Record-tab visit lets `cleanupOrphaned`'s `emptyButServerLinked` branch delete the server row (the just-uploaded recording) — destroying real uploaded data. `purgeAfterUpload` (step 2) runs ONLY if the draft delete (step 1) succeeded; on draft-delete failure, leave the `uploaded` manifest on disk for the next-launch self-heal retry (purge is idempotent) and still write the tombstone — this degrades to a recoverable amber card, never data loss.
- The recovery surface suppresses any session whose durable `recordingId` is already referenced by an existing draft / amber "Not Submitted" card OR by an existing stash (Saved Session). So a `stopped`+draft recording surfaces once (the existing card) and a stashed durable recording surfaces once (under Saved Sessions), never also as a separate recovery card. The suppression key set is the durable `recordingId` across BOTH drafts and stashes — critical because the stash flow deletes the slot's draft ("stash owns audio"), so the draft alone cannot suppress a stashed durable recording; the stash reference must, or `listRecoverableSessions` re-offers it and two slots end up on the same on-disk file (double-submit / concurrent-resume hazard).
- The scanner also finds orphan `audio.aac` files with at least one complete ADTS frame when the manifest is missing/corrupt. An orphan-recovered durable recording has unknown edit state (the manifest carrying `edited` is gone), so conservatively treat it as edited — block Continue/Add-More — until the user names and submits it, so a tail is never appended to possibly-edited bytes (the forbidden mixed edited/tail stream).
- The scan runs on app launch after auth + draft-storage user ID, invoked from the existing post-`setUserId` one-shot site (reuse/extend `recoveryScannedUserIdRef`) so it never runs before `userId` resolves (cross-user leak on shared tablets, Rule 13) and does not re-fire on `TOKEN_REFRESHED`/foreground re-fetches. It is independent of which tab the user lands on and surfaces a persistent Home + Record badge.
- Auth-level recovery state must support a bounded list/count of recovery items, not the current single `pendingRecoveryDraftSlotId`.
- If one recoverable session exists, route to a recovery screen with Resume recording, Review and submit, Save for later, and Discard. A recording flagged "edit not yet applied" (the window-(i) state: `anchorsPending` + bytes still matching the pre-edit anchors) surfaces a Re-edit affordance; its Review-and-submit uploads the original valid (un-trimmed) audio — never a mislabeled clean-edited file.
- If multiple recoverable sessions exist, show a list sorted by `updatedAt`. Any manifest timestamp actually rendered on a recovery card (`startedAt`/`updatedAt`) must follow Rule 11 — the manifest may be stale/parsed-from-a-torn-write in exactly this after-crash path, so guard with `isNaN(parsedDate.getTime())` before any `Intl`/`toLocaleDateString` formatting and show a safe fallback label (sorting by the raw value alone does not crash).
- A recovered recording that already carries `serverDraftId`/`serverRecordingId` (it had reached draft-create or an in-flight `PendingConfirm` before the kill) must reconcile against the server (`getStatus`, as `draftStorage.evictExpired` already does) before re-offering or re-submitting: if already confirmed-uploaded, mark `uploaded` and stop offering it; if not, any re-submit re-PUTs bytes only through the `existingRecordingId` promote path so the server row is reused, never duplicated.
- Recovery copy must say Captivet recovered an unsaved local recording. It must not say the recording was deleted.
- Never auto-delete recoverable audio because metadata is incomplete. Surface unnamed local recordings and require patient details before submit.

## Testing And Release Gates

- Unit tests:
  - manifest parser rejects malformed JSON, wrong user ID, path traversal, non-local URI, missing file, empty file, unsupported schema
  - ADTS parser handles malformed headers, truncated final frames, mid-file sample-rate/channel/profile drift, and recovery through the last complete frame
  - duration calculations distinguish live `capturedDurationMs` from recovered/upload `durationMs` derived from complete ADTS frames
  - recovery tolerates stale `committedBytes` and computes `completeFrameBytes` from the on-disk ADTS prefix
  - recovery finds orphan `audio.aac` with valid active metadata, and recovers unnamed if metadata is missing
  - reducer/session restore handles durable IDs without copying audio into `PatientSlot.segments`
  - `secureStorage.clearAll()` preserves active durable metadata / durable recovery intent keys AND the purged-uploaded tombstone
  - the purged-uploaded tombstone is user-scoped (`setUserId`-gated, no cross-user read), survives `clearAll()`/sign-out, is pruned once the linked draft+manifest are both absent (or FIFO-capped), and is consulted by `cleanupOrphaned` to skip deleting a purged-uploaded server row offline
  - draft/stash cleanup treats a valid non-purged durable manifest as local audio
  - stashing a paused durable recording with no materialized segments succeeds and round-trips durable IDs/server draft IDs
  - edited durable recordings persist one derived AAC/ADTS file, survive restart, and block Continue/Add More Info in v1
  - sign-out preserves durable active/recoverable recordings; `support_staff` sign-out preserves them to the recovery vault
  - confirmed upload calls `purgeAfterUpload()` only after draft/upload cleanup succeeds
  - `listRecoverableSessions` excludes a manifest only on state `uploaded`/`confirmedUploadAt`, NOT on `serverRecordingId` alone (a created-but-unconfirmed manifest is still recoverable and reconciled)
  - duplicate-row crash safety at every window: (a) kill in the fresh-create `create()`→PUT window — `serverRecordingId` is already on disk so reconcile resolves it, and the deterministic idempotency key makes a retried `create()` reuse the row (no duplicate); (b) kill in the confirm→`uploaded`-marker window — re-submit goes through the promote/idempotency path, never a blind fresh create
  - kill in the `uploaded`-marker→`deleteDraft` window, device OFFLINE, then navigate to Record tab during self-heal: the just-uploaded server row SURVIVES — self-heal deletes the draft strictly before purge, the purged `recordingId` is tombstoned, and `cleanupOrphaned`'s `getStatus` reconcile fails closed (defers) offline and consults the tombstone, so it never deletes an uploaded/processed row
  - recovery suppression: a `stopped`+draft recording AND a stashed durable recording each surface once (by durable `recordingId` key, across drafts and stashes), not as a duplicate recovery card; a stashed durable recording is not re-offered after its draft is deleted by the stash flow
  - edited durable recording keeps the SAME `recordingId`/manifest and replaces `audio.aac` in place at edit-commit (3-state: intent marker `edited:true`+`anchorsPending` → byte swap → finalize recomputed `adtsFrameCount`/`completeFrameBytes`/`committedBytes`/`durationMs`, keep `peakDb`); uploads `audio.aac` as `audio/aac`/`.aac`, bypasses `maybeSplitForUpload`. Crash sub-windows: (i) before commit → unedited recording recovers; (ii) after intent-marker / before swap → bytes match pre-edit anchors → surfaced "edit not yet applied", Continue blocked; (iii) after swap / before finalize → bytes mismatch stale anchors → byte-0 reparse yields correct non-truncated anchors, manifest re-finalized + `anchorsPending` cleared, Continue blocked, exactly ONE card. A corrupt/missing manifest recovers the edited `audio.aac` via the orphan scan (treated as edited → Continue blocked). `manifest.edited` (not a slot flag) gates Continue across a stash round-trip
  - server idempotency (cross-repo): two `create()`/`createWithFile()` calls with the same deterministic key derived from the durable `recordingId` yield ONE server row; a kill after the server creates the row but before the client persists `serverRecordingId`, then a fresh-create retry, does not duplicate
  - the silent-audio guard actually BLOCKS a silent durable recording (empty `segments[]`, synthetic `peakDb` metering), and does not fail open
  - format discriminator: a legacy `segments[]` (m4a) slot and a durable `recordingId` slot each route to the correct upload helper/filename/contentType/silent-guard input/split decision; legacy recordings created pre-rollout still submit unchanged (coexistence)
  - the durable `recordingId` (plus codec/sampleRate/bitrate) round-trips through all three Rule 20 stash sites; Resume of a stashed paused durable session restores the `recordingId` and the audio is not orphaned
- Native/device tests:
  - continuous-pipeline assertion: fail if microphone or encoder restarts during uninterrupted active recording
  - reproduce the Peter Ellis timeline exactly: record about 12 minutes, pause, lock/background for about 1 hour, kill while paused, relaunch, and recover the full complete ADTS prefix
  - Android kills: `adb shell am kill`, `am force-stop`, and `kill -9`
  - Doze: `adb shell dumpsys deviceidle force-idle`, then verify capture continues when allowed and recovery works if killed/stalled
  - OEM battery killer: Samsung and Xiaomi long background/screen-off tests
  - audio-focus interruption: incoming call / Siri / another voice app; no committed audio is lost
  - format validation: generated ADTS headers match actual codec profile/sample rate/channel count; resume refuses incompatible settings
  - writer backpressure: queue never exceeds 250 ms; already-written audio remains recoverable
  - encoder output lag: validated Android and iOS devices keep capture/encode/write lag below 250 ms at 16 kHz/32 kbps, 16 kHz/48 kbps, and the 24 kHz/48 kbps fallback where used
  - feature-flag fallback: durable flag off and native start failure both fall back without crashing
  - notification/microphone permission failures show recoverable errors
  - low storage: 500 MiB warning, 250 MiB start block, 100 MiB graceful stop, 225 MB source warning, 240 MB graceful stop
  - recovered over-250 MB source blocks normal submit and shows contact-support recovery message without deleting local audio
  - kill at ~1 s after Start: document the minimum recoverable point (encoder warm-up before first frame); a directory with zero complete frames is cleaned AND its orphaned active-durable/recovery-intent metadata key is removed
  - kill during edit: the original durable `audio.aac` is still recoverable, the derived edit is either fully committed (atomic rename) or absent, and no orphaned WAV/PCM scratch survives restart
  - capture-side overrun: under forced pipeline stall, dropped PCM is detected and reported (`durable_writer_backpressure`/capture-drop) and capture degrades to a graceful stop, not a silent well-framed file with hidden gaps
  - large-file recovery is bounded and off the UI thread: enumerating a ~240 MB durable file at launch returns promptly (seek via `completeFrameBytes`, bounded tail re-validate), never blocks app entry / ANRs, and the Rule 24 watchdog flips the gate if a scan stalls
  - native `start()/stop()/pause()/resume()` watchdog: a hung native op flips out of `starting`/stopping into recoverable `error` within the timeout
  - iOS playback-vs-capture: starting `expo-audio` playback (recovery preview / `RecordingAudioPlayer`) does not kill or reroute an active or parked durable capture session
  - storage layer: pre-record 500/250 MiB JS checks and the while-recording 100 MiB native graceful-stop both fire at the right thresholds
  - server-enforced min-version: a build below the durable-capable floor is blocked from recording by the `426`-style response
- Upload/transcription tests:
  - 15-minute, 2-hour, and 4-hour recordings stay within expected storage budget and upload as a single `.aac` file
  - durable AAC upload uses `.aac` filenames, `audio/aac` content type, and no `segmentKeys`
  - legacy oversized split path is not invoked for durable AAC
  - R2 upload/confirm retry uses existing `PendingConfirm` behavior and does not delete local durable AAC
  - native-module ADTS samples pass presign, R2 upload, confirm, processing-job audio validation, Deepgram transcription, and SOAP generation
  - transcription/SOAP quality on representative clinic-noise + multi-speaker samples is validated against the current baseline; the 32 kbps profile is adopted only on owner approval, otherwise the 48 kbps fail-safe default ships
- Release gates:
  - `npm test`, `npm run typecheck`, `npx expo-doctor`
  - Android preview/internal build installed on SM-T220 and at least one aggressive-OEM device
  - iOS internal/TestFlight build installed on a physical device
  - Play-served APK inspection proves PairIP/licensing protection is absent
  - at least one production-representative clinic tablet has installed the replacement unprotected build, or stale protected installs are blocked/tracked
  - logcat/sysdiagnose review confirms no PHI in logs and no native process exits
  - server accepts native-module ADTS AAC end to end before durable recorder is enabled in production
  - server enforces `create()`/`createWithFile()` idempotency on the deterministic key before durable recorder is enabled in production (or the pre-response duplicate window is explicitly accepted + documented)
  - runtime flag defaults safely; `expo-audio` fallback and flag-off recovery/upload of existing durable manifests are verified

## Monitoring

Track only non-PHI telemetry. Add events to the `AnalyticsEvent` discriminated union in `src/lib/analytics.ts`.

- `durable_recorder_started`
- `durable_commit_flushed`
- `durable_commit_lagged`
- `durable_recorder_interrupted`
- `durable_resume_failed`
- `durable_writer_backpressure`
- `durable_process_recovered`
- `durable_battery_opt_exemption`
- `durable_recovery_available`
- `durable_recovery_restored`
- `durable_recovery_discarded`
- `durable_recorder_unavailable`
- `durable_upload_confirmed`
- `durable_adts_parse_error`
- `durable_aac_size_warning`
- `durable_aac_size_stop`
- `durable_aac_oversize_recovered`
- `durable_recorder_op_watchdog`
- `durable_capture_drop`
- `durable_low_space_stop`

Alert thresholds:

- any actively recording session where no commit lands within 5 seconds of start/resume
- any recording where commit lag exceeds 5 seconds while state is `recording`
- any malformed ADTS parse in production
- any recovered over-250 MB AAC source
- rising `durable_resume_failed` or `durable_process_recovered` rate
- any `durable_writer_backpressure` or `durable_capture_drop` event on production devices
- any `durable_recorder_op_watchdog` (native op hang) event on production devices
- any Play-served Android APK containing PairIP/licensing protection
- any production event with a durable recorder native fatal error

## Assumptions

- The durability mechanism is continuous capture-to-disk; for a process kill the loss is the in-flight capture/encoder buffer, not the commit interval.
- AAC-LC ADTS is the canonical durable format. The historical raw PCM/WAV storage path is not part of the v1 implementation.
- The shipping fail-safe default bitrate is 48 kbps. The storage-optimized 32 kbps profile is adopted as the default only if representative clinic-noise + multi-speaker transcription and SOAP output pass owner review against the current baseline; defaulting to 48 kbps means a skipped validation ships the safer bitrate.
- Normal exam recordings remain single-file under the 250 MB server cap. Multi-segment AAC is out of scope for v1.
- Existing auth, device binding, draft/stash cleanup, and no-PHI logging rules remain mandatory.
- The durable recorder protects against process death and OS/app interruptions. It does not protect against uninstall, app-data clear, physical device loss, storage corruption, or power loss before the OS flushes cached writes.
- OEM battery kills cannot be fully prevented from inside the app. The design reduces probability with FGS, wakelock, and battery-optimization setup, but relies on durability + recovery when kills still happen.
- The two-phase plan ships in order: Phase 1 Play-protection hotfix first, durable recorder behind a runtime flag second.

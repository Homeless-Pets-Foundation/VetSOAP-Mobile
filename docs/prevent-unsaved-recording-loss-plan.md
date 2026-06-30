# Prevent Unsaved Recording Loss Across Android and iOS

## Summary

The Peter Ellis recording was lost because the Android app process exited while the appointment audio still lived only inside the live `expo-audio` recorder/session state. It had not yet been stopped, saved as a draft, stashed, or uploaded. The immediate Android trigger was Google Play automatic protection/licensing code disconnecting from Play services and terminating the process (e.g. `System.exit`).

This plan prevents the same class of loss in two layers:

1. Remove the Android licensing/protection path that can terminate Captivet during recording.
2. Replace live-recorder-only durability with a native, cross-platform durable recorder that streams audio **continuously to a single growing app-private file** and recovers it after process death.

**The durability mechanism is continuous capture-to-disk, not periodic save.** A single low-level capture pipeline appends PCM to one growing file as fast as the microphone delivers it. Because bytes written with a normal `write()` syscall live in the kernel page cache and are flushed to disk by the kernel **after** the process dies, a process kill (crash, `System.exit`, OS reclaim, Play-services restart, OEM battery killer) loses only the audio still buffered in the app's own user-space buffer — tens of milliseconds, not seconds. The implementation must avoid large user-space buffers: each native capture buffer is written to the file immediately or handed to a bounded native writer queue, short writes are handled, and any app-owned buffer/ring is capped below 250 ms of audio. A tiny periodic commit marker drives UI/progress and identifies the active file; recovery still uses the frame-aligned on-disk file size as the source of truth.

The recovery guarantee is: after capture has produced any audio, any app crash, process kill, Play-services restart, OS reclaim, OEM kill, or tablet lock/background transition leaves the on-disk file recoverable up to (frame-aligned) its last written byte. No plan can recover audio after app data is cleared, the app is uninstalled, the device storage fails, or the device loses power before the kernel flushes the page cache (power loss is out of scope; `fsync` hardening is noted but not the guarantee).

A critical anti-regression note: an earlier feature saved a new recording every 5 minutes by **stopping and restarting** the encoder, and recordings would intermittently *stop entirely* (a failed encoder restart left capture dead). This plan's pipeline **never stops or restarts the microphone to achieve durability** — see the continuous-pipeline rule. That is the single most important property and is tested directly.

References:

- Google Play Integrity / automatic protection: https://developer.android.com/google/play/integrity
- Android foreground service microphone requirements: https://developer.android.com/about/versions/14/changes/fgs-types-required
- Android Doze and App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby
- Android `AudioRecord` (continuous PCM capture): https://developer.android.com/reference/android/media/AudioRecord
- Battery-optimization exemption: https://developer.android.com/training/monitoring-device-state/doze-standby#whitelisting-cases
- Apple background modes: https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes
- Apple `AVAudioEngine` input tap: https://developer.apple.com/documentation/avfaudio/avaudioengine
- Apple backup exclusion guidance: https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey

## Phase 1: Android Hotfix

- Disable Google Play automatic protection for Captivet's Android app in Play Console App Integrity for every production/internal testing track that can reach clinic tablets. Do not rely on client-side Play licensing code that can terminate the app process. Captivet should continue relying on Supabase auth, server auth, and the existing `X-Device-Id` session binding/revocation model.
- Keep Play Integrity, if needed later, as a server-adjudicated API check only: the mobile client may request an integrity token, but the backend decides access. The client must never call `System.exit`, kill itself, discard local recordings, or block local recovery because Play services is unavailable.
- Add a release-artifact verification step before promoting any Android build:
  - **Inspect the Play-served artifact, not the locally-built AAB.** Google Play automatic protection (PairIP) is injected by Google *after* upload, at distribution — it is absent from the AAB you build and upload, so scanning the local artifact would falsely pass. Download the actually-served APKs (Internal App Sharing / Play Internal testing, or `bundletool build-apks` from the Google-signed bundle) and scan those.
  - inspect the served APK permissions and class names for `com.android.vending.CHECK_LICENSE`, `com.pairip.licensecheck`, and PairIP/licensing classes
  - fail the release if the fatal licensing code is still present
  - run a tablet logcat smoke test on the served build while forcing Play Store/Play services restarts and verify no `LicenseClient`/PairIP fatal exit occurs
  - **If no licensing/protection code is found, do not assume Phase 1 resolved the loss** — re-investigate the kill cause (OS reclaim, OOM, OEM battery killer, other native crash). Phase 2's durable recorder is the actual guarantee and protects regardless of why the process dies.
- Add a lightweight startup breadcrumb that records only non-PHI process/session state: app version, process start time, user ID hash, and whether the previous process exited while a recording was in progress (known from local state). Do not log patient/client names or transcript content. Extend it in Phase 2 with the durable recording ID, slot ID, and whether recovery was offered (those fields don't exist until the durable recorder ships).

## Phase 2: Durable Recorder Architecture

### Capture pipeline (the core of the design)

- Add a local Expo native module at `modules/captivet-durable-recorder`, with Android and iOS implementations. This replaces `expo-audio` for all recording capture. `expo-audio` may remain only for playback paths that do not affect recording durability.
- **Continuous capture, never stop/restart.** Use the low-level streaming capture API on each platform, NOT the high-level encoder:
  - Android: `AudioRecord` reading raw 16-bit PCM on a dedicated capture thread.
  - iOS: `AVAudioEngine` input-node tap (or Audio Queue Services) delivering PCM buffers.
  - During uninterrupted active recording, the microphone session is continuous. Durability is achieved by *where the bytes are written*, never by stopping/finalizing/restarting capture on a timer. User pause, slot switch, Finish, and OS interruption may deliberately release the microphone after flushing. **This is the anti-regression rule for the prior "recordings just stop" bug** (which was caused by restarting the encoder on an interval). A failed interval restart cannot kill capture because there is no interval restart.
- **Canonical durable format, with native conversion.** The on-disk `audio.pcm` format is `pcm_s16le`, 16 kHz, mono. Do not assume the hardware input already arrives in that format. Android should request 16 kHz mono 16-bit PCM and validate `AudioRecord.getMinBufferSize`; if the device only supports another capture rate, use a native resampler or fail visibly with a typed unsupported-format error before writing. iOS normally delivers hardware-rate float PCM (often 44.1/48 kHz), so the native module must convert with `AVAudioConverter` (or equivalent) before appending. Never write bytes whose actual format differs from the manifest/WAV header.
- **Single audio-session / foreground-service owner.** The durable recorder owns the microphone foreground service and the audio session while recording. expo-audio must not also hold a recording session or its own microphone FGS at the same time: stop calling `setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: true, shouldPlayInBackground: true })` for capture (that is what drives expo-audio's background recording today). Two microphone FGS owners or two `record`-category sessions race for the input route and produce dropped audio / `ForegroundServiceStartNotAllowedException`. The compat hook (below) must guarantee expo-audio is not in a recording session whenever the durable recorder is active.
- **Single active capture at a time; multiple parked recordings.** The native module is a singleton with one live microphone capture session, mirroring today's `recorderBoundToSlotId` ownership. `start()` while capture is active must reject with a typed error; the JS layer must park the current slot via `pause()` before starting or resuming another slot. Multi-patient sessions still keep ≤10 slots, and each slot can have its own parked durable `recordingId`, but only one slot is actively capturing in native code at a time.

### On-disk durability (single growing file)

- Append incoming PCM to **one growing raw-PCM file** under app-private persistent storage. There are no per-interval chunk files and no v1 coarse rolling. Each capture buffer (~10–100 ms from the OS) is written immediately or handed off to the bounded native writer queue described below.
  - Android: `context.filesDir/durable-recordings/{userId}/{recordingId}/`, with `allowBackup=false` still enforced
  - iOS: `Application Support/durable-recordings/{userId}/{recordingId}/`, with `NSURLIsExcludedFromBackupKey=true` and `NSFileProtectionCompleteUntilFirstUserAuthentication`
  - the live audio is stored **headerless raw PCM** (`audio.pcm`); WAV headers are generated only at materialization. Headerless raw PCM has no container/trailer to finalize, so a file that simply stops growing mid-write is fully readable up to its last whole frame — this is the whole reason PCM is chosen over an encoded container.
  - if a future product requirement allows unusually long recordings where one file becomes operationally risky, add coarse rolling as a separate v2 with the same no-capture-restart invariant and tests. Do not add rolling to v1.
- **Writer-thread rule.** Android's `AudioRecord` reader thread may write directly to the file after each read. iOS `AVAudioEngine`/Audio Unit callbacks must not block on disk I/O on the real-time render thread; copy/convert into a bounded native ring/serial writer queue and return immediately. If the writer queue exceeds the 250 ms cap or a write repeatedly fails, stop capture gracefully, keep all bytes already written, mark the manifest `error`, and show recoverable user feedback rather than silently dropping audio.
- **Pre-create recovery anchors before audio capture starts.** `start()` creates the durable directory, empty `audio.pcm`, and a seed `manifest.json`/active-recording index entry before opening the microphone. If the process dies before the first 2-second commit marker, `listRecoverableSessions()` must still discover the recording from the seed manifest or, if the manifest write was torn, from an orphan `audio.pcm` file with at least one whole frame. SecureStore active metadata improves labels/patient details when available; it is not required to recover the audio, which can surface as unnamed. This closes the "killed immediately after Start" gap.
- **Periodic commit marker (the "valid through byte N" sidecar).** A native timer (not a JS timer) updates a small `manifest.json` every ~2 s via atomic write (temp + rename): `audio.pcm` `committedBytes`, running peak level, state, timestamps. The manifest is small and bounded, so this is O(1) per update — no growing array, none of the O(n²) cost of rewriting a per-chunk index.
  - `committedBytes` is a **lower-bound hint**, not the source of truth. The recovery rule is exactly: recoverable length = `frame_floor(on-disk audio.pcm size)`. It is always safe to recover *more* than the manifest claims because every written byte survives a process kill via the page cache, and `frame_floor` drops any torn partial frame at EOF. The marker exists only to drive the live "saved through" UI cheaply and identify the recording; recovery never depends on it being current, so a stale or one-version-old manifest (from a kill mid-rename) costs nothing.
  - **Why a process kill loses almost nothing:** bytes handed to `write()` are in the kernel page cache and are flushed to disk by the kernel after the process exits; only the buffer not yet written by the capture thread (tens of ms) is lost. `fsync` per flush is optional power-loss hardening (out of primary scope) — the page-cache property, not `fsync`, is what makes the process-kill case safe.
- Storage hygiene:
  - require at least 1 GiB free before starting a new recording; while recording, stop gracefully (finalize cleanly, keep all audio) if free space drops below 250 MiB
  - raw PCM is ~115 MB/hour (16 kHz mono 16-bit), so a 4-hour recording is ~460 MB on disk — acknowledged and within the budget above
  - a durable directory with **zero bytes of audio** (a failed/aborted `start()`) holds no clinical data, is never recoverable, and may be cleaned up like transient scratch so failed starts don't accumulate on shared tablets

### Manifest and metadata

- Keep the durable manifest non-PHI. It may contain user ID, slot ID, recording ID, timestamps, state, format, `audio.pcm`, committed byte count, running peak, and app/build version. Patient/client metadata remains in SecureStore-backed draft metadata/recovery intent, written when recording starts, on metadata edits, on pause, and on app background.
- **Format decision (record it explicitly).** Capture is 16 kHz mono 16-bit PCM instead of 44.1 kHz AAC. PCM is chosen because a raw-PCM file is recoverable as its readable prefix after a kill, whereas an AAC/MP4 stream killed mid-write leaves a container with no `moov` atom and is unrecoverable — the exact failure mode this plan exists to fix. The cost is larger files/uploads (~115 MB/hour vs ~43 MB/hour) and lower playback fidelity (16 kHz is sufficient for speech and is what ASR downsamples to anyway). This is acceptable for transcription-first vet SOAP recordings, but it is a product decision — confirm with the owner before rollout, and confirm clinic-Wi-Fi upload of multi-hundred-MB recordings is tolerable.

### Materialization into upload parts

- At submit/recovery, split the PCM file into WAV **upload parts** by byte range. Each part becomes one segment in the existing multi-segment R2 upload.
  - `planUploadParts` computes byte ranges only (no bytes written, disk-free). `materializeUploadPart` writes one WAV temp file (fresh WAV header with the correct `data` size + the byte range copied). `discardMaterializedPart` deletes that temp file after its segment upload confirms.
  - **Streaming, one part at a time** (not a full up-front duplicate): a full materialize of a 4-hour recording would need ~2× the recording on disk and would fail on the near-full tablets this protects. Materialize → upload → discard each part with bounded concurrency, so peak extra disk is ~(upload concurrency × one part), ≈ tens of MB. Raw PCM files remain the source of truth until the whole recording is server-confirmed, then `purgeAfterUpload()`.
  - **Part sizing bounds the segment count.** Part count = segment count = R2 objects = presign round-trips. Pick `maxPartDurationMs` so the longest supported recording yields roughly ≤20 parts (e.g. ~12–15 min parts for a 4-hour recording), each well under the 250 MB per-file limit (16 kHz mono PCM is ~1.92 MB/min, so a 15-min part is ~29 MB). Confirm the server's maximum accepted `segmentCount` and keep part count under it.
  - **Frame alignment + torn-tail handling.** Copy only whole PCM frames (2 bytes, mono 16-bit); truncate the final part to the last whole frame. If `audio.pcm` is shorter than the manifest claims, use its readable frame-aligned prefix and continue — never abort the whole recording over a torn tail. Report dropped/truncated bytes via `durable_materialize_partial`.
  - **Peak metering carry-through.** Each `DurableUploadPart` carries a `peakDb` **computed during `materializeUploadPart`** — it already streams the part's PCM bytes, so the peak is free and exact per part (the manifest's single `peakDb` is a whole-recording running max for the live UI / silent signal, not a per-range value). The part `peakDb` maps to the segment's `peakMetering`; `record.tsx`'s silent-audio guard keys off per-segment `peakMetering`, and without it every Submit falls through to a slow FFmpeg silent check.
  - no FFmpeg pass is required for normal materialization; use streaming file copy + header generation to avoid memory spikes on tablets.

### State transitions

- Update app state so a recording can be represented in three stages:
  - `activeDurableRecordingId`: native recorder owns the live growing file
  - `recoverableDurableRecordingId`: app restarted and found a recoverable file
  - `segments`: materialized upload parts ready for playback/edit/upload through the existing multi-segment flow
  - `editedDerivedSegments` / `tailDurableRecordingIds`: only needed after the user edits and then continues recording; see JS integration below
- On pause, stop, interruption, app background, and sign-out:
  - **pause** flushes the current capture buffer, updates the commit marker, closes the file handle, releases the microphone/foreground service/wakelock, and leaves the manifest `paused`. The file is durable as-is. This avoids holding the microphone for long clinical pauses like the Peter Ellis timeline; resume must be user/foreground initiated and reopens the same `recordingId` for append.
  - **app background / screen lock** does not by itself pause an active recording. If state is `recording`, capture continues under the microphone FGS/wakelock and the app only flushes active metadata/commit state. If state is already `paused`, no microphone/FGS is held and the parked file remains recoverable.
  - **slot switch** parks the current slot exactly like pause, then starts or resumes the target slot's own durable `recordingId`. The native module still has one active capture session at a time, but the session can contain multiple parked durable recordings.
  - **stop / Finish** flushes + finalizes the marker, releases native resources, marks the manifest `stopped`, and writes normal draft metadata immediately — the recording is durable and still appendable until upload/discard if the user chooses to add more information. **Materialization is deferred to submit**, not stop (avoids the 2× disk spike).
  - **interruption** (audio focus loss) flushes the marker, marks the manifest `interrupted`, releases whatever the OS has taken away, and resumes appending to the **same** file after focus/session recovery from a foreground/user action. The captured audio is already durable; an interruption never starts a separate recording.
  - **sign-out** must not delete active/recoverable durable recordings or edited derived audio associated with them; cleanup remains explicit submit/discard/delete only. Durable recordings are per-user disk-scoped (under `{userId}`), so they survive logout and reappear on re-sign-in like drafts/stashes (rule 8). **`support_staff` sign-out is the exception:** `preserveSupportStaffRecordings()` must also cover active/recoverable durable recordings and edited derived segments (support staff may never return, so per-user scoping alone strands them) — fold durable manifests and derived edit assets into the same owner/admin recovery-vault path it already uses for drafts/stashes.

## Background Recording Reliability (preventing kills, and surviving the ones you can't prevent)

Periodic saving does nothing about the things that most often kill long background recordings on Android: OEM battery killers, Doze/App Standby, and a mishandled audio-focus interruption. This section addresses them with a **layered** strategy. The honest framing: some of these kills (especially aggressive OEMs) **cannot be reliably prevented from inside the app**, so the design does not pretend to. Layer 1 reduces the probability of a kill; Layer 2 (the continuous-capture durability above) guarantees the audio survives the kill anyway; Layer 3 recovers it on relaunch. **Durability + recovery is the guarantee; prevention is best-effort.** Keep it properly engineered — no AlarmManager/JobScheduler resurrection hacks, no watchdog second process; just a correct foreground service, a wakelock, a battery-optimization exemption, and the durability backstop.

### Audio focus loss (incoming call, Siri, another voice app) — common and fully recoverable

- The durable recorder owns the audio session, so it must detect focus loss directly (folding in or consuming the existing `modules/captivet-audio-focus` `AudioManager` listener; do not leave two modules reacting to focus on one session). On a non-`duck` `loss`:
  - flush the commit marker, mark the manifest `interrupted`, and **keep the file** (already durable)
  - the OS may cut the mic during a call; there is simply no audio for that span. Do not treat this as an error or a stop.
- On focus `gain`, **resume appending to the same recording only when allowed**:
  - if `resume()` fails because the mic is still held, retry with bounded backoff rather than giving up
  - if the app is backgrounded, **defer the resume to AppState `active` or a notification tap that brings the app foreground** — starting/re-acquiring a microphone foreground service from the background is restricted on Android 12+ and throws `ForegroundServiceStartNotAllowedException`; matching today's anti-double-resume behavior
  - never leave capture silently stuck: show a banner and keep retrying / offer manual resume. The already-captured audio is safe regardless of whether resume succeeds.
- A wrong interruption→resume path is itself a cause of "recordings stop"; this is the third leg of that historical bug and is tested explicitly.

### Doze / App Standby

- Use a correctly typed **microphone foreground service** for every active capture period. Do not depend on background jobs, timers, or network while recording; Doze/App Standby can defer those, while the recorder only needs local disk writes.
- Hold a `PARTIAL_WAKE_LOCK` for the duration of **active** recording (acquired on start/resume, released on pause/stop) to reduce CPU-sleep risk outside deep idle modes. Add the `WAKE_LOCK` permission via the config plugin. Scope it tightly to avoid battery drain when paused, and do not treat it as a guarantee because Android idle modes can ignore wake locks.
- Backstop: if Doze, memory pressure, or OEM policy still kills/reclaims the process despite the FGS/wakelock, the file on disk is already recoverable.

### OEM battery killers (Samsung "Deep Sleep" / Sleeping Apps, Xiaomi/MIUI, Oppo/ColorOS, Huawei, etc.)

- These OEMs kill foreground services and background apps on their own schedules regardless of standards compliance. **This cannot be fully prevented from inside the app — do not design as if it can.** Mitigations that measurably reduce the probability:
  - a correct microphone FGS with an **ongoing user-visible notification** ("Recording appointment — tap to return") so the OS treats the app as user-visible work; do not assume every Android/OEM version makes it strictly non-dismissible
  - the partial wakelock above
  - request a **battery-optimization exemption**, but mind Play policy: the direct prompt (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission) is policy-gated. Default to the lower-risk settings deep link (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`) unless product/legal explicitly approves the direct prompt for managed clinic tablets.
  - on known-aggressive OEMs, a one-time onboarding nudge that deep-links to the OEM's "don't optimize / protected apps / allow background" setting (best-effort intent resolution; never crash if the intent is absent — rule 1). Surface this as a setup step for clinic tablets that record long appointments.
  - best-effort `Service.onTaskRemoved`/`onDestroy` hook that flushes the commit marker and marks the manifest `interrupted` for a clean recovery (won't fire on a hard SIGKILL, so it's an optimization, not a guarantee)
- **The real defense is durability + recovery:** when an OEM kills the FGS, the continuous-capture file holds everything up to the kill, and the recovery scan surfaces it on next launch. This is precisely the layer the app fully controls, which is why the plan invests there rather than in unwinnable OEM-kill prevention.

## Native Module Contract

Expose this TypeScript API from `modules/captivet-durable-recorder/index.ts`:

```ts
type DurableRecorderState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'interrupted'
  | 'stopped'
  | 'error';

// One raw PCM file for the durable recording.
type DurableAudioFile = {
  uri: string;              // headerless raw PCM file: audio.pcm
  committedBytes: number;   // lower-bound hint; recovery uses frame_floor(actual file size)
};

type DurableRecordingManifest = {
  schemaVersion: 2;
  recordingId: string;
  userId: string;
  slotId: string;
  state: DurableRecorderState;
  startedAt: string;
  updatedAt: string;
  committedThroughMs: number;    // derived from committedBytes / byte-rate
  encoding: 'pcm_s16le';
  sampleRate: 16000;
  channels: 1;
  bitDepth: 16;
  frameBytes: 2;                 // channels * bitDepth/8
  audioFile: DurableAudioFile;
  peakDb: number;                // running peak over the whole recording (silent-audio guard)
  appVersion: string;
  buildNumber: string;
  lastErrorCode?: string;
};

// Plan = byte ranges over audio.pcm; no WAV written.
type DurableUploadPartPlan = {
  partIndex: number;
  byteStart: number;   // inclusive, logical-stream offset, frame-aligned
  byteEnd: number;     // exclusive, frame-aligned
  durationMs: number;
  estimatedSizeBytes: number;  // PCM bytes + WAV header
  // peakDb is NOT here: it's computed during materializeUploadPart, which reads the bytes.
};

// Materialized = one WAV temp file, produced on demand and deleted by the
// caller after its segment upload confirms.
type DurableUploadPart = {
  partIndex: number;
  uri: string;
  duration: number;
  sizeBytes: number;
  peakDb: number;
  contentType: 'audio/wav';
};

start(input: {
  userId: string;
  slotId: string;
  recordingId: string;
  commitIntervalMs?: number;   // default 2000; native timer cadence for the marker
}): Promise<DurableRecordingManifest>;

pause(): Promise<DurableRecordingManifest>;
resume(input: {
  userId: string;
  recordingId: string;          // existing paused/interrupted/stopped local durable recording
}): Promise<DurableRecordingManifest>;
stop(input?: {
  userId?: string;              // required if recordingId is provided for a non-current recording
  recordingId?: string;         // current active recording by default
}): Promise<DurableRecordingManifest>;
discard(input: { userId: string; recordingId: string }): Promise<void>;
purgeAfterUpload(input: { userId: string; recordingId: string }): Promise<void>;
getStatus(): Promise<DurableRecordingManifest | null>;
getManifest(input: { userId: string; recordingId: string }): Promise<DurableRecordingManifest | null>;
listRecoverableSessions(userId: string): Promise<DurableRecordingManifest[]>;

// Streaming materialization: plan byte ranges, then materialize/discard one
// part at a time so peak extra disk is ~(upload concurrency × one part).
// `maxPartDurationMs` bounds part count = segment count; choose so the longest
// supported recording yields roughly ≤20 parts, each well under 250 MB.
planUploadParts(input: {
  userId: string;
  recordingId: string;
  maxPartDurationMs: number;
}): Promise<DurableUploadPartPlan[]>;
materializeUploadPart(input: {
  userId: string;
  recordingId: string;
  partIndex: number;
}): Promise<DurableUploadPart>;
discardMaterializedPart(input: {
  userId: string;
  recordingId: string;
  partIndex: number;
}): Promise<void>;
```

Native events:

```ts
recordingProgress   // periodic: { committedThroughMs, peakDb } — drives saved-through UI + metering
stateChanged
interruption        // { reason: 'focus_loss' | 'route_change' | ... }
error               // { code, message } — never terminates the process
```

Implementation rules:

- **Never stop/restart the microphone to achieve durability.** An uninterrupted active recording has one continuous capture session; user pause, slot switch, Finish, and OS interruption may deliberately release the microphone after flushing. The anti-regression rule is that the app never auto-stops/restarts capture on an interval merely to save data. This is what caused the prior "recordings just stop" bug.
- All native errors are reported as typed error codes and `error` events; native code must not terminate the process.
- The commit marker runs on a **native** timer/thread. JS timers are not acceptable for the durability cadence.
- Android: declare and start a `microphone` foreground service with `FOREGROUND_SERVICE_MICROPHONE`; request/grant `RECORD_AUDIO` before service start; call `startForeground` with the microphone service type and an ongoing notification while actively recording; hold a `PARTIAL_WAKE_LOCK` while actively recording when the platform honors it (released on pause/stop).
- The Expo config plugin must add the Android service declaration, foreground-service type, `RECORD_AUDIO`/`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_MICROPHONE`/`POST_NOTIFICATIONS`/`WAKE_LOCK` permissions (and optionally `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), and any required ProGuard/R8 keep rules.
- iOS: configure `AVAudioSession` for `playAndRecord`/record with the audio background mode; handle route/session interruptions by flushing the marker and transitioning to `interrupted`, then resuming the same file after the interruption ends.
- **Native-side path-component validation.** `userId`, `slotId`, and `recordingId` are interpolated into filesystem paths (`filesDir/durable-recordings/{userId}/{recordingId}/`). The native module — not only the JS layer — must reject any value containing `/`, `\`, `..`, a NUL byte, or any character outside `[A-Za-z0-9_-]` before touching the filesystem, on every entry point (`start`, `resume`, `stop`, `discard`, `purgeAfterUpload`, `getStatus`, `getManifest`, `listRecoverableSessions`, `planUploadParts`, `materializeUploadPart`, `discardMaterializedPart`). A compromised editor bridge or corrupted manifest must not escape the per-user durable root (mirrors rule 13/15 path-traversal defenses).
- **Do not infer user scope from `recordingId`.** Every operation that addresses a parked/non-current durable recording must include `userId` and must resolve paths only under that user's durable root. A UUID collision is unlikely, but shared-tablet PHI isolation should not depend on UUID uniqueness alone.
- `discard()` is only for explicit user discard/delete. `purgeAfterUpload()` is only called after the server confirms upload and all dependent edit/export work has completed.
- **Two distinct IDs — do not conflate them.** `recordingId` is the *local durable recording id* (a UUID generated client-side via `expo-crypto`, per rule 21, used only as the on-disk folder name and manifest key). The *server draft id* (`serverDraftId`) returned by `recordingsApi.create({ isDraft: true })` is separate and lives in draft metadata / `PatientSlot`. Materialize/upload/promote must map local → server id explicitly; reusing one as the other will fresh-create duplicate server recordings (rule 20).

## JS Integration

- Refactor `src/hooks/useAudioRecorder.ts` into a compatibility hook backed by `captivet-durable-recorder`.
  - Keep the **full** current public surface working or explicitly remap each member — `record.tsx` and `PatientSlotCard` consume all of: `state`, `isStarting`, `duration`, `maxMetering`, `audioUri`, `mimeType`, `getLiveStats`, `getPersistableSnapshot`, `start`, `pause`, `resume`, `stop`, `reset`, `resetWithoutDelete`, `triggerInterruption`, `isSupported`. A partial preserve-list will silently break the stopped-effect and interruption flow in `record.tsx`.
  - Drive `maxMetering`/`getLiveStats` and the "saved through" duration from the `recordingProgress` event (`peakDb`, `committedThroughMs`).
  - Add durable-specific fields instead of changing existing meanings: `activeDurableRecordingId`, `recoverableDurableRecordingId`, `committedThroughMs`, and `lastCommitAt`.
  - Change `mimeType` to `audio/wav` after durable materialization.
  - Keep every callback Promise either awaited in try/catch or terminated with `.catch(() => {})`, matching the Android crash-prevention rules.
- **This is a real refactor of the capture→segment flow, not a drop-in hook — call it out explicitly:**
  - **Unedited slot = one durable `recordingId` for the whole appointment.** The user's Pause parks that recording on disk; Resume reopens the same local `recordingId` and appends to the same `audio.pcm`. Switching to another patient parks the current slot, then starts or resumes the target slot's recording. Finish maps to durable `stop()` but remains appendable until upload/discard so "add more information" still works.
  - **Edited-then-continued recordings become mixed-source.** Once the editor emits derived draft-owned segments, those edited segments are the source of truth for the earlier audio. If the user then chooses Continue/Add More Info, do **not** append to the original edited raw source and pretend the old edit still covers the whole file. Start a new durable tail `recordingId` for the appended audio, then upload in order: edited derived segments first, followed by materialized tail durable parts. Keep both the original raw source and tail raw source until the mixed upload is confirmed. If the mixed-source path is not implemented in the first release, block Continue after edit with a clear warning; never silently drop the edit or the appended tail.
  - **There is no single `audioUri` at stop.** Today the stopped-effect (`record.tsx` ~L742) reads `recorder.audioUri` and calls `saveAudio(slotId, audioUri, duration, maxMetering)` to append one segment. In the durable model the slot is backed by its `recordingId`; `PatientSlot.segments` is populated from materialized parts at submit/resume, not from a stop-time file. The stopped-effect and `SAVE_AUDIO` must be reworked to record the durable `recordingId` + `committedThroughMs`/peak, not a file URI.
  - **`CONTINUE_RECORDING` changes semantics.** For unedited durable audio, it reopens the same durable recording instead of stop→`resetWithoutDelete()`→restart to add a file segment. For edited-derived audio, it starts a new durable tail source as described above. Reconcile the reducer/action so the source of truth is durable raw + optional derived/tail sources, materialized into ordered upload parts only at submit.
  - The interruption effect (`recorder.state === 'interrupted'` → `saveAudio(recorder.audioUri…)`) likewise changes: an interruption stays within the same durable recording; the partial audio is already durable, so it must not be appended as a separate file-URI segment.
- Update `app/(app)/(tabs)/record.tsx`:
  - generate the local durable `recordingId`, write best-effort SecureStore-backed active draft metadata, then call native `start()`; if SecureStore is unavailable, native capture may still start, but recovery must surface the audio as unnamed instead of dropping it
  - update draft metadata on form edits with a short debounce and on AppState background
  - show "saved through" status from `committedThroughMs`
  - show a warning if no `recordingProgress` commit has landed in more than 5 seconds while recording (capture may be wedged)
  - on Finish, call `stop()` and save normal draft metadata immediately — the recording is durable at this point. Materialization happens at submit, not Finish.
  - **Submit interleaves materialize + upload (do not pre-materialize the whole recording).** The existing `createWithSegments` preflights every segment URI up front, which assumes all parts already exist on disk — incompatible with streaming materialization. The durable submit path must instead `planUploadParts` → for each part `materializeUploadPart` → upload it (reusing the per-segment presign + PUT + `uploadOnceWithRetry` logic) → `discardMaterializedPart` after its segment upload confirms, with bounded concurrency, so peak extra disk is ~(concurrency × part size). Extend `createWithSegments` with an optional per-part producer/cleanup callback, or add a durable-specific upload path that reuses `uploadRetry` helpers.
  - after confirmed upload and local post-upload cleanup, call `purgeAfterUpload({ userId, recordingId })` for each raw durable source involved in the upload (raw PCM files are retained until this point, never deleted by the per-part temp cleanup above)
- Extend draft/recovery storage:
  - add active-durable recording metadata separate from normal finished `DraftMetadata`
  - add an explicit active metadata API instead of reusing `draftStorage.saveDraft()`, because `saveDraft()` correctly rejects zero-segment drafts
  - **Dedupe durable recovery against the draft/"Not Submitted" surface.** After Finish a recording is both `stopped` in its durable manifest AND a normal `draftStorage` entry + server draft row. It must appear to the user exactly once. Link the draft entry to its durable manifest by `slotId`/local `recordingId`; a `stopped` durable recording that already has a draft entry surfaces as the existing amber "Not Submitted" card (not a second durable-recovery card). The durable-recovery screen is for manifests with NO completed draft entry (killed while `recording`/`paused`/`interrupted`/`starting`, or `stopped` before the draft write landed).
  - **Draft audio for durable recordings is the raw PCM file, not copied `seg_N.m4a`.** The current draft flow copies a single audio file into `drafts/{userId}/{slotId}/`; the durable recorder owns raw PCM instead. The draft entry references the durable manifest, and the resume/playback path rehydrates `PatientSlot.segments` by materializing upload parts on demand (it must not expect pre-copied `seg_N.m4a`). Don't double-store the audio.
  - **Edited recordings are the exception to "no copied draft audio."** Today the editor returns concrete segment URIs after trim/split/merge/reorder/delete. If the user edits a durable recording, persist the editor result immediately as derived draft-owned audio (`editedFromDurableRecordingId`) so the edited state survives restart and sign-out recovery. Keep the original raw PCM until the edited draft is uploaded/confirmed/purged, because it is still the recovery source and allows re-materialization/revert. Upload the edited derived segments when they exist; otherwise use the streaming raw-PCM materializer.
  - validate user ID, slot ID, recording ID, file URI scheme, file existence, size, and manifest schema before recovery
  - reject path traversal and any URI outside the durable recording root
  - do not let existing 30-day draft/stash eviction (rule 13) delete any non-purged durable recording (`recording`/`paused`/`interrupted`/`stopped`/`error`/`starting`) without first surfacing it; like un-sent drafts/stashes today, a recoverable durable recording is never silently auto-deleted, and sign-out never deletes it (rule 8)
- Update upload:
  - drive the multi-segment R2 flow from the streaming materializer (per the Submit bullet above), one ordered WAV part per segment — not a pre-materialized array — and carry each part's `peakDb` into the segment's `peakMetering` so the existing silent-audio guard (`record.tsx`) does not fall through to a full FFmpeg pass on every Submit
  - support mixed-source upload ordering for edited-then-continued recordings: already-persisted edited WAV segments, then streamed durable tail parts. Cleanup must be per source and must retain every raw/derived source until server confirm.
  - use `audio/wav` content type (already in `ALLOWED_AUDIO_TYPES`); the `createWithSegments` default content type is `audio/x-m4a`, so pass `'audio/wav'` explicitly
  - confirm backend and transcription support for ordered WAV segments; if missing, add server support before enabling the durable recorder in production
- Update playback/editing:
  - play materialized WAV parts, not the raw PCM file directly
  - make the editor format-aware: current `audioTempFiles`/`trimAudio`/`concatenateAudio` paths assume `.m4a` outputs and AAC stream-copy. Durable inputs are WAV/PCM, so trim/split/merge/play-all must output valid WAV (or deliberately re-encode with the correct content type) instead of copying PCM into an `.m4a` container. Prefer WAV outputs so the durable upload path stays `audio/wav` end-to-end.
  - do not concatenate an entire long durable recording just to preview "Play All"; play ordered materialized parts sequentially so preview does not create a full-size duplicate. Whole-recording merge/export is allowed only as an explicit operation with a free-space check and streaming implementation.
  - before applying an edit that creates derived audio, check free space for the expected output plus safety margin. If there is not enough room, keep the raw durable source untouched and show a user-visible "free storage before editing" error.
  - teach the editor/record callback which URIs are durable-owned or materialized temp inputs; it must not delete raw `audio.pcm` or durable-owned sources when replacing edited segments
  - keep raw PCM until upload confirmation and until any edit/export operation no longer needs it; keep edited derived segments until their server-confirmed upload cleanup succeeds

## Rollout and Fallback

- **Phase 1 ships independently and first.** Disabling Play automatic protection (and the artifact-inspection gate) is a self-contained hotfix that stops the specific process-kill cause; it must not wait on the durable-recorder work. Ship it as its own release.
- **Gate the durable recorder behind a runtime flag** (e.g. `extra` config like `isProduction`, ideally remotely togglable) so it can be disabled in production without a store release if the native module misbehaves. When the flag is off, capture falls back to the current `expo-audio` path. The compat hook is the single switch point: same JS surface, two backends.
- **Fallback must be safe and visibly degraded, not silent.** If the native module fails to load, fails `start()`, or reports an unsupported-platform error, fall back to `expo-audio` capture AND surface a non-PHI telemetry event (`durable_recorder_unavailable`) so the fleet shows how many devices are on the durable path. The UI must show that crash-recovery durability is unavailable and should prompt the user to Finish/Save before locking or leaving the app. Never hard-crash or block recording because the durable module is unavailable (rule 1: never throw at module load — lazy-`require` the native module per rule 19).
- **Staged rollout:** internal testing → small production cohort → full. Watch the monitoring thresholds below at each stage; do not advance while commit-lag or native-fatal alerts are firing.

## Recovery UX

- **Recoverable predicate (must be explicit).** `listRecoverableSessions(userId)` returns every manifest whose `state` is one of `starting`, `recording`, `paused`, `interrupted`, `stopped`, or `error`, **as long as** `audio.pcm` has at least one whole frame and has not been confirmed-uploaded-and-purged. It also scans the durable root for orphan `audio.pcm` files with at least one whole frame when a manifest is missing/corrupt. The Peter Ellis recording was in `paused` state when the process was killed, so a predicate that only scans `recording`/`interrupted` would still lose it — `paused` and `stopped` (not-yet-uploaded) manifests MUST be recoverable. A manifest leaves the recoverable set only via `purgeAfterUpload()` (server confirmed) or explicit `discard()`.
- The recovery scan must run on app launch after auth + draft-storage user ID, independent of which tab the user lands on, and must surface a persistent indicator (Home + Record tab badge) so a recovered session is never hidden behind a tab the user does not open.
- If one recoverable session exists, route to the recording recovery screen with options: Resume recording, Review and submit, Save for later, Discard.
- If multiple recoverable sessions exist, show a list sorted by `updatedAt`.
- Recovery copy must not say the recording was deleted. It should say Captivet recovered an unsaved local recording and show patient/client metadata only from SecureStore-backed draft metadata.
- Never auto-delete a recoverable recording just because its metadata is incomplete. If the audio file is valid but patient metadata is missing, recover it as an unnamed local recording and require the user to fill patient details before submit.

## Testing and Release Gates

- Unit tests:
  - durable manifest parser rejects malformed JSON, wrong user ID, path traversal, non-local URI, missing file, empty file, unsupported schema
  - recovery computes recoverable length as `frame_floor(file size)` and tolerates a manifest `committedBytes` that lags the on-disk file (recovers the larger, frame-aligned length)
  - recovery finds an orphan `audio.pcm` with valid active metadata when the seed manifest is missing/corrupt, and recovers it as unnamed if active metadata is also missing
  - `planUploadParts` produces frame-aligned, contiguous, non-overlapping byte ranges covering the whole stream, ≤ the configured part count
  - reducer/session restore handles active durable IDs and materialized upload parts without copying audio into `PatientSlot.segments`
  - edited durable recordings persist derived draft-owned segments, survive app restart, upload the edited audio rather than the raw source, and retain raw PCM until confirmed cleanup
  - edited-then-continued recordings upload edited derived segments followed by the new durable tail, and neither source is deleted before server confirmation
  - durable editor preview plays ordered parts without creating a full-recording concat temp file; edit operations fail visibly before writing when free space is insufficient
  - draft recovery preserves patient metadata edits made before, during, and after recording
  - sign-out does not delete durable active/recoverable recordings or edited derived audio; `support_staff` sign-out preserves both to the recovery vault
  - confirmed upload calls `purgeAfterUpload()` only after draft/upload cleanup has succeeded
  - a `stopped` durable recording that already has a draft entry surfaces once (as the "Not Submitted" card), not also as a separate durable-recovery card
- Native tests (the durability + reliability core):
  - **Continuous-pipeline assertion (the anti-regression test):** instrument the capture session so a test fails if the microphone is stopped/restarted during an uninterrupted active recording; run a 2-hour active recording and assert zero capture restarts. User pause/slot switch/interruption are allowed to release and later re-acquire the mic after flushing.
  - **Reproduce the Peter Ellis timeline exactly:** start recording, record ~12 min, pause, lock/screen-off and background ~1 hour, then kill the process while still `paused` (`adb shell am kill`, then on a debuggable build `kill -9`) — relaunch, and the recovery scan MUST surface the `paused` session with the full file recoverable (loss ≤ the in-flight buffer). This is the regression test for the exact loss this plan exists to prevent.
  - Android: kill Captivet with `adb shell am kill`, `adb shell am force-stop`, and `kill -9`; after relaunch, recovered audio equals the on-disk file frame-aligned (near-zero loss).
  - **Doze:** `adb shell dumpsys deviceidle force-idle` mid-recording; verify the mic FGS/wakelock behavior on the target OS, capture continues when the OS allows it, and audio is recoverable if the OS kills or stalls capture; `unforce` and confirm normal resume.
  - **OEM battery killer:** on a Samsung and a Xiaomi device, record, background/screen-off for an extended period, and either let the OEM kill the app or `am kill` it; relaunch and recover with near-zero loss. Verify the battery-optimization setup flow appears, opens the correct settings/prompt path for the selected policy, and reduces kills when the user grants the exemption.
  - **Audio-focus interruption + resume:** trigger an incoming call (and Siri on iOS) while recording, foreground and backgrounded; on a backgrounded interruption, resume defers to AppState `active` (no `ForegroundServiceStartNotAllowedException`); resume retries with backoff if the mic is briefly held; no committed audio is lost and the recording continues as one file.
  - **Format conversion:** verify Android devices that support 16 kHz directly and iOS devices delivering 44.1/48 kHz float input both write canonical `pcm_s16le` 16 kHz mono files whose manifest and generated WAV headers match the actual bytes.
  - **Writer backpressure:** inject slow/failing writes; assert the queue never grows past the configured 250 ms cap, already-written audio remains recoverable, and the user sees a recoverable error instead of silent audio drops.
  - feature-flag fallback: with the durable flag off, capture uses `expo-audio` and still records/uploads; with the native module forced to fail `start()`, capture falls back to `expo-audio` and emits `durable_recorder_unavailable` without crashing.
  - Android: deny `POST_NOTIFICATIONS`, grant microphone, verify FGS behavior and user warning; verify `SecurityException`/`ForegroundServiceStartNotAllowedException`/missing-mic-permission paths fail visibly without data loss.
  - iOS device: record with screen locked, background for 2 hours, terminate from the app switcher and the debugger, relaunch, recover, submit.
  - Low/tight storage: fill storage until a write or materialization fails; the recording stops gracefully, previously written audio stays recoverable, and a long recording still materializes part-by-part (streaming) without room for a full second copy — raw PCM is never deleted to make room.
  - Torn tail: truncate the PCM file to a non-frame-aligned length; recovery and materialization produce valid WAV from the frame-aligned prefix and report `durable_materialize_partial`.
- Upload/transcription tests:
  - 15-minute, 2-hour, and 4-hour recordings materialize into WAV parts each under 250 MB, total part (segment) count within the server's accepted maximum
  - materialized parts carry `peakDb` → segment `peakMetering`, so a normal recording does not trigger the FFmpeg silent-check fallback; a genuinely silent recording is still caught
  - ordered multi-segment upload preserves playback order and generates SOAP notes
  - retry after R2 upload/confirm failure uses existing `PendingConfirm` behavior and does not delete the local durable PCM
- Release gates:
  - `npm test`, `npm run typecheck`, `npx expo-doctor`
  - Android preview/internal build installed on SM-T220 (and at least one aggressive-OEM device: Samsung + Xiaomi)
  - iOS internal/TestFlight build installed on a physical device
  - inspection of the Play-served APKs (not the locally-built AAB) proves PairIP/licensing protection is absent
  - logcat/sysdiagnose review confirms no PHI in logs and no native process exits
  - **server accepts `audio/wav` ordered multi-segment recordings end-to-end (presign → confirm → transcription → SOAP)** — hard blocker: do not enable the durable recorder in production until verified, since the client emits WAV not m4a
  - the durable-recorder runtime flag defaults safely and the `expo-audio` fallback path is verified on the same build

## Monitoring

Track only non-PHI telemetry (add each to the `AnalyticsEvent` discriminated union in `src/lib/analytics.ts` — the catalog is the single source of truth; an event not in the union won't compile — with non-PHI fields only):

- `durable_recorder_started`
- `durable_commit_flushed`
- `durable_commit_lagged`        // no commit within the expected window while recording
- `durable_recorder_interrupted` // { reason }
- `durable_resume_failed`        // focus-gain resume could not re-acquire the mic
- `durable_writer_backpressure` // native writer queue hit the safety cap or repeated write failures
- `durable_process_recovered`    // inferred on next launch from a recoverable manifest/orphan file whose prior process did not cleanly stop
- `durable_battery_opt_exemption`// { granted: boolean }
- `durable_recovery_available`
- `durable_recovery_restored`
- `durable_recovery_discarded`
- `durable_materialize_failed`
- `durable_materialize_partial`
- `durable_recorder_unavailable`
- `durable_upload_confirmed`

Alert thresholds:

- any actively recording session where no commit lands within 5 seconds of start/resume
- any recording where commit lag exceeds 5 seconds while state is `recording`
- any recovery where `frame_floor(file size) - committedThroughMs` implies more than one commit interval of lag
- a rising `durable_resume_failed` or `durable_process_recovered` rate (interruption/kill handling regressed, or an OEM cohort needs the battery-opt nudge)
- any `durable_writer_backpressure` event on production devices (native write path or storage performance needs investigation)
- any Play-served Android APK containing PairIP/licensing protection
- any production event with a durable recorder native fatal error

## Assumptions

- The durability mechanism is continuous capture-to-disk; for a process kill the loss is the in-flight buffer (tens of ms), not the commit interval. The commit interval bounds saved-through UI/manifest staleness; frame-aligned EOF recovery handles torn tails.
- The implementation must work on both Android and iOS physical devices, not only emulators/simulators, and on at least one aggressive-OEM Android device.
- Server support for `audio/wav` multi-segment recordings will be verified before production rollout.
- Existing auth, device binding, draft/stash cleanup, and no-PHI logging rules remain mandatory.
- The durable recorder protects against process death and OS/app interruptions. It does not protect against uninstall, app-data clear, physical device loss, storage corruption, or power loss before the kernel flushes the page cache.
- OEM battery kills cannot be fully prevented from inside the app; the design reduces their probability (FGS + wakelock + battery-opt exemption) but relies on continuous durability + recovery to guarantee no data loss when a kill happens anyway.
- 16 kHz mono 16-bit PCM is an accepted product trade-off (durability + transcription over fidelity and upload size); the owner signs off before rollout.
- The two-phase plan ships in order: the Phase 1 Play-protection hotfix is released first and independently; the durable recorder follows behind a runtime flag with a verified `expo-audio` fallback.

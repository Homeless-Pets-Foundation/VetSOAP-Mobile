# Durable Recorder AAC Storage Plan

> Historical design note: this file is preserved for the low-storage/AAC decision history. The canonical implementation plan is now `docs/prevent-unsaved-recording-loss-plan.md`.

## Summary

This historical note captures the durable-recorder storage strategy for low-storage clinic tablets and phones.

The durable recorder must use AAC-LC in ADTS frames as the canonical on-disk source instead of raw PCM. This keeps the crash-recovery guarantee while reducing storage from about 115 MB/hour for 16 kHz mono PCM to about 14 MB/hour at 32 kbps AAC or 22 MB/hour at 48 kbps AAC.

## Key Changes

- Replace the canonical raw `audio.pcm` durable source with a single growing `audio.aac` ADTS file under the per-user durable recording directory.
- Pre-create the per-user durable directory, empty `audio.aac`, and seed manifest before opening the microphone. Recovery scans must find orphan `audio.aac` files with at least one complete ADTS frame even when the manifest write was torn.
- Native capture still reads microphone PCM continuously, but immediately encodes to mono AAC-LC ADTS:
  - default profile: 16 kHz, mono, 32 kbps
  - quality-validation fallback profile: 16 kHz, mono, 48 kbps
  - runtime encoder fallback if 16 kHz is unsupported: 24 kHz, mono, 48 kbps
  - do not use MP4/M4A or HE-AAC for v1
- Platform implementations must write ADTS headers themselves when the native encoder emits raw AAC access units:
  - Android: `AudioRecord` feeds `MediaCodec` AAC-LC (`audio/mp4a-latm`); skip codec-config buffers, derive ADTS profile/frequency/channel fields from the actual output format, and prepend ADTS headers to each encoded access unit before appending.
  - iOS: `AVAudioEngine` input buffers feed `AVAudioConverter`/Audio Converter AAC-LC output; write ADTS headers per packet/access unit, not an MP4/M4A container.
- Once the first ADTS frame is written, `codec`, AAC profile, sample rate, and channel count are locked for that `recordingId`. Resume must reopen the encoder with the same settings; if the same settings are unavailable, leave the file recoverable and fail visibly instead of appending a different stream format.
- Recovery must parse ADTS frames, recover through the last complete frame, and discard only a torn partial frame at EOF.
- `committedBytes` remains a lower-bound UI/progress hint. The recovery source of truth is the on-disk ADTS prefix through the parser-derived `completeFrameBytes`.
- Keep raw PCM only inside bounded native buffers below 250 ms. Never persist a raw PCM duplicate after AAC frames are written.
- Pause, stop, and clean interruption handling must drain pending encoder output, append any complete ADTS frames, force/fsync the AAC file, and atomically update the manifest before returning.
- User pause, slot switch, Finish, and OS interruption may close/reopen the encoder; uninterrupted active recording must never restart the microphone or encoder on a timer just to create checkpoints.

## Storage Policy

- Warn below 500 MiB free.
- Block new recordings below 250 MiB free.
- While recording, gracefully stop and preserve all complete AAC frames if free space drops below 100 MiB.
- While recording, warn when `audio.aac` reaches 225 MB and gracefully stop before it reaches 240 MB. This keeps the source safely below the 250 MB server file limit after filesystem/MIME overhead and avoids producing an unuploadable recording.
- Before edit/export/transcode work, require estimated output size plus temporary workspace plus 100 MiB safety margin.
- Normal submit must not create a full second copy of a long recording. For v1, upload the canonical AAC source directly as a single file.

## Interfaces And Upload Flow

- Update the native module manifest:
  - `audioFile.uri` points to `audio.aac`
  - include `container: 'adts'`, `codec: 'aac_lc'`, `bitrate`, `sampleRate`, `channels`, `adtsFrameCount`, `completeFrameBytes`, `committedBytes`, `durationMs`, and `peakDb`
  - `durationMs` is derived from AAC-LC frame count (`1024` samples per frame) and actual `sampleRate`, not byte rate
  - keep manifest metadata non-PHI; patient/client labels stay in the existing SecureStore-backed draft/recovery metadata
- Upload unedited durable recordings directly as `.aac` with `contentType: 'audio/aac'` when the full file is under the 250 MB server limit.
- Generated filenames and content types must match bytes: `.aac` plus `audio/aac`. Remove normal-path WAV generation.
- Update the mobile upload API so the single-file path accepts an explicit upload filename or derives it from the source URI/content type. The durable path must not call a helper that still hardcodes `recording.m4a` while passing `audio/aac`.
- Durable AAC submit must bypass the current oversized `maybeSplitForUpload()`/FFmpeg path; that path is for legacy `.m4a` segment uploads and can create multi-segment inputs the current server job cannot process as ADTS AAC.
- For v1 single-file uploads, use manifest `peakDb` as the segment `peakMetering`; it is computed from PCM input before encoding and avoids decoding the AAC file during submit. If v2 adds split uploads, add a bounded peak-window sidecar then.
- Edited durable recordings must produce one derived draft-owned AAC/ADTS file by default. WAV is allowed only as temporary editor scratch and must be deleted after use.
- V1 behavior after an edit: block Continue/Add More Info with a clear warning. Do not upload mixed edited/tail multi-segment AAC until a later server-supported design exists.

## Draft, Stash, And Recovery Storage

- Finished drafts must reference the durable `recordingId`/`audio.aac` source instead of copying the AAC file into `drafts/{userId}/{slotId}/seg_N.m4a`. This avoids double-storing the recording.
- `draftStorage.cleanupOrphaned()`, `draftHasLocalAudio()`, pending-draft scans, and Home "Not Submitted" card loading must treat a valid non-purged durable AAC manifest as local audio even when `segments[]` is empty.
- Save for Later must accept a paused/stopped durable AAC source with no materialized segments. Stash metadata must round-trip the local durable recording ID, server draft ID, slot ID, duration, peak, and format.
- Support-staff sign-out preservation must preserve durable AAC manifests and files into the existing recovery-vault path; it must not rely only on concrete `segments[]` files.
- Explicit discard/delete and confirmed-upload purge are the only paths that remove a non-purged durable AAC source. Logout, session expiry, and 30-day eviction must not silently delete it.

## Server Compatibility Gates

- Mobile/API presign already allow `audio/aac`, but the processing job must be updated before production rollout:
  - `isLikelyAudio()` must recognize ADTS AAC by validating at least the first few ADTS frames, not just a two-byte sync prefix.
  - single-file `.aac` uploads must reach Deepgram with `mimetype: 'audio/aac'`.
  - end-to-end validation must use an actual ADTS file generated by the native module, not a renamed M4A/MP4 file.
- V1 must avoid multi-segment AAC uploads. The current server job concatenates multi-segment recordings by writing every segment as `.m4a`, running FFmpeg copy concat, and reuploading `audio/mp4`; that path is not safe for ADTS AAC parts.
- If a future v2 needs split AAC uploads, implement server support first: preserve ordered `segmentKeys`, validate every segment as ADTS with matching codec/sample-rate/channel metadata, concatenate by an ADTS-aware path, and pass `audio/aac` to transcription. Keep the existing 20-segment confirm-upload cap.

## Failure Modes

- ADTS AAC is required because it is prefix-recoverable. MP4/M4A is excluded because it can require finalization metadata, which is exactly the failure mode the durable recorder must avoid.
- If AAC encoding fails mid-recording, stop gracefully, preserve the last complete AAC frame, mark the manifest `error`/recoverable, and show user feedback.
- Do not silently fall back to persistent raw PCM. A PCM fallback may exist only as a separate visible degraded recorder mode with free-space validation and telemetry; it must not keep a simultaneous raw duplicate of a successful AAC capture.
- The durable-recorder runtime flag gates new capture only. Recovery, listing, review, upload, discard, and purge for existing durable AAC manifests must remain available after the flag is turned off.
- A zero-byte durable directory or an `audio.aac` file with no complete ADTS frame contains no recoverable clinical audio and may be cleaned as transient scratch.
- If ADTS parsing finds a malformed frame before EOF, recover only the valid prefix before that frame and mark the manifest `error`. Do not scan forward for a later sync word in v1; false resync can splice corrupted audio into a clinical recording.
- If a recovered AAC source already exceeds the 250 MB server limit due to an older build or bug, do not purge it. Block normal submit, keep the local file recoverable, emit non-PHI telemetry, and show a contact-support recovery message. Do not add a generic share/export button in v1.

## Test Plan

- Unit-test ADTS parsing, malformed headers, truncated final frames, mid-file sample-rate/channel/profile drift, and recovery through the last complete frame.
- Kill-test Android and iOS active, paused, interrupted, and stopped recordings. Recovered audio must match the complete ADTS prefix.
- Test resume after app restart uses the manifest's locked codec/profile/sample-rate/channel settings; if those settings are unavailable, resume fails visibly and leaves the prior AAC file recoverable.
- Verify 15-minute, 2-hour, and 4-hour recordings stay within the expected storage budget and upload as a single file without full-file duplication.
- Verify the 225 MB warning, 240 MB graceful stop, and recovered-over-250 MB support/export path.
- Run end-to-end server validation with real native-module `.aac` ADTS samples: presign, R2 upload, confirm, processing-job audio validation, Deepgram transcription, SOAP generation.
- Validate transcription quality on representative clinic-noise samples at 32 kbps and 48 kbps before rollout against the current recording baseline. Use 32 kbps only if transcription and SOAP output pass owner review; otherwise use 48 kbps as the default.
- Test encoder unavailable/failure paths: no module-load crash, no silent PCM fallback, visible degraded recording state, and preserved existing AAC prefix.
- Test low-storage start/block/stop behavior and edit/export free-space failures.
- Test stash, draft, recovery, sign-out, support-staff preservation, and 30-day eviction with durable AAC sources that have no copied segment files.
- Test that durable AAC upload uses `.aac` filenames, `audio/aac` content type, and no `segmentKeys` in confirm-upload for v1.
- Test that the legacy oversized split path is not invoked for durable AAC recordings.

## Assumptions And Defaults

- Backend upload allowlists include `audio/aac`, but production rollout is blocked until the processing job accepts ADTS magic bytes and a real ADTS AAC transcription path is verified end to end.
- The 32 kbps AAC-LC profile is the default because storage pressure is expected on shared clinic tablets and phones. Move the default to 48 kbps only if transcription/audio-quality validation fails at 32 kbps.
- At 48 kbps, the 250 MB server limit covers roughly 11 hours of audio; normal exam recordings must remain single-file. Multi-segment AAC is out of scope for v1.
- The Phase 1 Android hotfix remains independent. The AAC durable recorder follows behind a runtime flag with a verified `expo-audio` fallback.

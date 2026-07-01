# Durable Recorder — Implementation Status

Companion to `prevent-unsaved-recording-loss-plan.md`. Tracks what has been built
in this repo vs. what is gated on devices, the server (VetSOAP-Connect), or owner
sign-off. The durable capture path ships **behind a server-driven flag that
defaults OFF** — with the flag off, recording behaves exactly as before
(expo-audio), so this can land without changing production behavior.

## Implemented in this repo (code-complete, typechecks, unit + source tests green)

- **Native module `modules/captivet-durable-recorder`** — Android (Kotlin:
  AudioRecord→MediaCodec AAC-LC→ADTS, microphone foreground service, wakelock,
  audio-focus, atomic manifest, bounded recovery scan) and iOS (Swift:
  AVAudioEngine→AVAudioConverter→ADTS, AVAudioSession ownership + interruptions,
  Application Support storage w/ backup-exclusion + file protection, atomic
  manifest, bounded recovery scan). JS bridge `index.ts` is lazy + fallback-safe.
- **Shared JS/TS (`src/lib/durableAudio/`)** — pure ADTS parser (`adts.ts`),
  manifest type + validator (`manifest.ts`), id/path guard (`paths.ts`), recovery
  selection logic (`recoveryLogic.ts`), launch orchestration (`durableRecovery.ts`),
  purged-uploaded tombstone + active-recording pointer + chunked SecureStore
  (`tombstone.ts`/`activeStore.ts`/`chunkedStore.ts`), offer store + hook.
- **Free-space gates** (`src/lib/freeSpace.ts`, 500/250 MiB JS side; 100 MiB /
  225 / 240 MB native side).
- **Rollout flag** (`src/lib/durableFlag.ts`, server-driven via
  `x-durable-capture-enabled`) and **min-version floor** (`src/lib/minVersion.ts`
  + client `426` branch, cached via `x-minimum-app-version`).
- **Compat hook** (`useAudioRecorder.ts`) — durable backend selected only when
  flag on + module available + context provided; expo path unchanged when off.
- **record.tsx** — durable start (ctx + Rule 24 watchdog + active pointer),
  durable finish (auto/manual/interruption), durable upload (explicit
  `recording.aac`/`audio/aac`, deterministic idempotency, serverRecordingId
  anchor before PUT, `uploaded`-marker→deleteDraft→purge+tombstone order, bypass
  split, synthetic silent-guard peak), durable discard, Continue blocked,
  audio-focus deferred to the durable module.
- **Storage** — draftStorage (durable metadata-only save, durable-aware
  `draftHasLocalAudio`/`cleanupOrphaned` with getStatus reconcile + fail-closed,
  evictExpired guard), stash round-trip (all 3 Rule 20 sites), support-staff
  recovery vault (durable manifests preserved).
- **Recovery UX** — launch scan wired into AuthProvider's post-setUserId one-shot,
  self-heal/reconcile/suppression, `durable-recovery.tsx` screen + Home banner.
- **Analytics** — full durable event catalog in `analytics.ts`.
- **Tests** — `tests/durable-*.test.mjs` (ADTS parser, manifest validator, paths,
  recovery logic, tombstone, min-version, free-space) + `durable-recorder-plan.test.mjs`
  source-invariant guards.

## v1 scoping decisions (deliberate limitations, documented)

- **Durable = one continuous recording per appointment.** Pause/resume within a
  recording is supported; **Continue / Add-More is blocked for durable slots**
  (would require the unsafe multi-segment AAC path the plan defers to v2).
- **Durable interruption = graceful finish**, not auto-resume-append. The
  audio.aac is durable and becomes a submittable draft; the user submits or
  re-records. (Append-resume needs the v2 multi-segment path.)
- **Editing a durable recording is not wired** — durable recordings submit their
  `audio.aac` as-is; the waveform editor remains for legacy m4a segments. The
  manifest already carries `edited`/`anchorsPending` and recovery treats
  orphan/edit-pending states conservatively, so the edit-commit machinery can be
  added later without a schema change.

## Gated OUTSIDE this repo — required before enabling the flag in production

- **VetSOAP-Connect (server)**: `isLikelyAudio()` must validate real ADTS frames;
  single-file `.aac` must reach Deepgram with `mimetype: 'audio/aac'`;
  `create()/createWithFile()` must enforce idempotency on the client-supplied
  deterministic key (unique constraint / upsert). The client sends
  `x-durable-capture-enabled` expectations but the flag must be owned by the same
  deploy that ships ADTS acceptance. **Until then the flag must stay OFF.**
- **Play Console / hotfix (Phase 1)**: disable Google Play automatic protection,
  ship + verify an unprotected served artifact, add the server min-version floor.
- **Device tests** (plan "Native/device tests" + "Release gates"): Peter-Ellis
  timeline, `am kill`/`force-stop`/`kill -9`, Doze, OEM battery killers,
  audio-focus, encoder lag < 250 ms, ADTS end-to-end through Deepgram/SOAP,
  large-file recovery, iOS playback-vs-capture, on SM-T220 + an aggressive-OEM
  device + a physical iOS device.
- **Owner sign-off**: 32 kbps profile (defaults to the safer 48 kbps until
  approved); direct battery-optimization prompt (defaults to the settings deep
  link, no special permission).

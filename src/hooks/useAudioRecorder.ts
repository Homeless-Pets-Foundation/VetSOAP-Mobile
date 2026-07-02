import { useState, useCallback, useEffect, useRef } from 'react';
import { Alert, AppState, Platform, PermissionsAndroid } from 'react-native';
import {
  useAudioRecorder as useExpoAudioRecorder,
  setAudioModeAsync,
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
  type RecordingStatus,
} from 'expo-audio';
import { safeDeleteFile } from '../lib/fileOps';
import { breadcrumb, captureException } from '../lib/monitoring';
import { reportClientError } from '../api/telemetry';
import * as durableRecorder from '../../modules/captivet-durable-recorder';
import { isDurableCaptureEnabled } from '../lib/durableFlag';
import { trackEvent } from '../lib/analytics';

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped' | 'interrupted';

/**
 * Hard cap on the native durable start() promise. Kept below the record.tsx
 * withDurableOpWatchdog (12s) so the hook unwinds its own isStartingRef lock and
 * falls back to the expo path before the outer watchdog fires.
 */
const DURABLE_START_TIMEOUT_MS = 10_000;

/**
 * Hard cap on the native durable stop() promise. Kept below the record.tsx
 * withDurableOpWatchdog (12s): the caller-side watchdog only rejects the UI
 * handler, so if the native stop hangs the hook must unwind its OWN stoppingRef
 * lock + state here, or every later Finish/Save-for-Later early-returns forever.
 */
const DURABLE_STOP_TIMEOUT_MS = 10_000;

/**
 * Hard caps on the native durable pause()/resume() promises. Same rationale as
 * DURABLE_START/STOP: a native bridge that hangs during an audio-session /
 * audio-focus edge case must not leave pause()/resume() awaiting forever — the
 * slot would never reach paused/stopped, the record.tsx Alert (Rule 6) would
 * never fire, and the recording control would not reflect the recoverable
 * on-disk file. Unlike start/stop, record.tsx does NOT wrap pause()/resume() in
 * withDurableOpWatchdog, so this internal race is the ONLY guard.
 */
const DURABLE_PAUSE_TIMEOUT_MS = 10_000;
const DURABLE_RESUME_TIMEOUT_MS = 10_000;

/**
 * Race a durable native op against a rejecting timeout so a hung native bridge
 * can't leave the hook awaiting forever (Rule 24). On timeout the returned
 * promise rejects with `label`, letting pause()/resume() run their Rule-6
 * cleanup (best-effort graceful stop -> state 'stopped') and RETHROW so
 * record.tsx surfaces the Alert. A late-settling native op is harmless: its
 * result is ignored (mirrors the inline races in start()/stop()).
 */
function withDurableTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    op,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Context required to start a durable capture (audio.aac under the user root). */
export interface DurableStartContext {
  userId: string;
  slotId: string;
  recordingId: string;
}

/** Snapshot of a finished durable capture, for building the slot's durable ref. */
export interface DurableSnapshot {
  recordingId: string;
  durationMs: number;
  peakDb: number;
  sampleRate: 16000 | 24000;
  bitrate: 32000 | 48000;
}

export interface UseAudioRecorderReturn {
  state: RecordingState;
  isStarting: boolean;
  /** Frozen-at-transition duration (updates on start/pause/resume/stop), NOT a live ticker. */
  duration: number;
  maxMetering?: number;
  audioUri: string | null;
  mimeType: string;
  /**
   * Live metering + duration read on demand from refs/native — no React state
   * behind it, so consumers poll it from a leaf component without re-rendering
   * the screen that owns the recorder (see RecorderLiveReadout).
   */
  getLiveStats: () => { meteringDb: number; durationSeconds: number };
  getPersistableSnapshot: () => {
    audioUri: string | null;
    duration: number;
    maxMetering?: number;
  };
  /** Non-null while a durable capture owns the current recording. */
  activeDurableRecordingId: string | null;
  /** Reserved for a recoverable durable recording surfaced to this hook (null in v1). */
  recoverableDurableRecordingId: string | null;
  /** Durably-saved-through time (ms) — drives the secondary "saved" indicator. */
  committedThroughMs: number;
  /** Byte offset through the last complete ADTS frame (durable only). */
  completeFrameBytes: number;
  /** Timestamp of the last durable commit tick, or null. */
  lastCommitAt: number | null;
  /** Snapshot of a finished durable capture, or null when the expo path is used. */
  getDurableSnapshot: () => DurableSnapshot | null;
  start: (ctx?: DurableStartContext) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  resetWithoutDelete: () => void;
  triggerInterruption: () => Promise<void>;
  isSupported: boolean;
}

const RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: true,
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 96000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    audioSource: 'voice_recognition',
  },
  ios: {
    audioQuality: AudioQuality.HIGH,
    outputFormat: IOSOutputFormat.MPEG4AAC,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm;codecs=opus',
    bitsPerSecond: 96000,
  },
};

let androidNotificationPermissionChecked = false;

async function ensureAndroidRecordingNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  if (androidNotificationPermissionChecked) return;
  androidNotificationPermissionChecked = true;

  try {
    const permission = 'android.permission.POST_NOTIFICATIONS' as keyof typeof PermissionsAndroid.PERMISSIONS;
    const alreadyGranted = await PermissionsAndroid.check(permission as any);
    if (alreadyGranted) return;
    await PermissionsAndroid.request(permission as any);
    // Recording still works if denied — just no persistent notification,
    // which may let the OS kill the process. Not a blocker.
  } catch {
    // Denial or bridge failure is nonfatal.
  }
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [finalDuration, setFinalDuration] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [isStarting, setIsStarting] = useState(false);
  const stoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  // Re-entrancy guard for durable resume(): a double-tap Resume (or a stale JS
  // resume firing before the first updates React state) must be a no-op, not a
  // second native resume() — the native side now rejects the second call with
  // BUSY, and the resume catch would otherwise stop the recording the first tap
  // just restarted. Set true for the duration of a durable resume, reset in finally.
  const resumeInFlightRef = useRef(false);
  const mediaResetAlertedRef = useRef(false);
  const hasErrorAlertedRef = useRef(false);
  const latestAudioUriRef = useRef<string | null>(null);
  const maxMeteringRef = useRef(-160);
  const hasMeteringSampleRef = useRef(false);
  const finalDurationRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const elapsedBeforeCurrentRunMsRef = useRef(0);
  const recordingStartedAtMsRef = useRef<number | null>(null);
  // Capture duration before pause/stop — native pause can reset the polled durationMillis to 0
  const capturedDurationRef = useRef(0);

  // Recorder is referenced inside statusListener but declared below this
  // hook. We forward it via a ref so the listener identity stays stable
  // (callback memoization doesn't break on every render) without introducing
  // the use-before-define lint trap.
  const recorderRef = useRef<ReturnType<typeof useExpoAudioRecorder> | null>(null);
  // Last native status sample written by the render-free polling effect below.
  // Read fallback for getLiveStats/getNativeDurationSeconds when a direct
  // getStatus() call throws (released/broken native handle).
  const lastStatusRef = useRef<{ metering: number | undefined; durationMillis: number } | null>(null);
  const stateRef = useRef<RecordingState>('idle');

  // ─── Durable backend (flag-gated; expo path is untouched when off) ─────────
  // Which backend owns the CURRENT capture. Only ever 'durable' when the runtime
  // flag is on AND the native module is available AND a start context was given.
  const backendRef = useRef<'expo' | 'durable'>('expo');
  const durableUserIdRef = useRef<string | null>(null);
  const durableSlotIdRef = useRef<string | null>(null);
  const durableRecordingIdRef = useRef<string | null>(null);
  const durableSampleRateRef = useRef<16000 | 24000>(16000);
  const durableBitrateRef = useRef<32000 | 48000>(48000);
  const durablePeakDbRef = useRef(-160);
  const durableDurationMsRef = useRef(0);
  const durableLiveRef = useRef<{ meteringDb: number; capturedDurationMs: number }>({
    meteringDb: -160,
    capturedDurationMs: 0,
  });
  const lastCommitAtRef = useRef<number | null>(null);
  // Mirror of committedThroughMs readable synchronously (state is stale inside
  // ref-based callbacks). The durably-saved-through time is the crash-safe
  // duration to attribute to an interrupted capture.
  const committedThroughMsRef = useRef(0);
  const [committedThroughMs, setCommittedThroughMs] = useState(0);
  const [completeFrameBytes, setCompleteFrameBytes] = useState(0);
  const [activeDurableRecordingId, setActiveDurableRecordingId] = useState<string | null>(null);

  const setElapsedSecondsValue = useCallback((seconds: number) => {
    const normalized = Math.max(0, seconds);
    elapsedSecondsRef.current = normalized;
    setElapsedSeconds(normalized);
  }, []);

  const getNativeDurationSeconds = useCallback(() => {
    let durationMillis = lastStatusRef.current?.durationMillis ?? 0;
    try {
      const status = recorderRef.current?.getStatus();
      if (status && typeof status.durationMillis === 'number') {
        durationMillis = status.durationMillis;
      }
    } catch {
      // Released/broken native handle — keep the last polled sample.
    }
    return Math.floor(durationMillis / 1000);
  }, []);

  const getElapsedDurationSeconds = useCallback(() => {
    const startedAt = recordingStartedAtMsRef.current;
    const activeElapsedMs = startedAt === null ? 0 : Math.max(0, Date.now() - startedAt);
    return Math.floor((elapsedBeforeCurrentRunMsRef.current + activeElapsedMs) / 1000);
  }, []);

  const resetElapsedClock = useCallback(() => {
    recordingStartedAtMsRef.current = null;
    elapsedBeforeCurrentRunMsRef.current = 0;
    setElapsedSecondsValue(0);
  }, [setElapsedSecondsValue]);

  const startElapsedClock = useCallback(() => {
    elapsedBeforeCurrentRunMsRef.current = 0;
    recordingStartedAtMsRef.current = Date.now();
    setElapsedSecondsValue(0);
  }, [setElapsedSecondsValue]);

  const resumeElapsedClock = useCallback(() => {
    if (recordingStartedAtMsRef.current === null) {
      recordingStartedAtMsRef.current = Date.now();
    }
    setElapsedSecondsValue(getElapsedDurationSeconds());
  }, [getElapsedDurationSeconds, setElapsedSecondsValue]);

  const freezeElapsedClock = useCallback(() => {
    const startedAt = recordingStartedAtMsRef.current;
    if (startedAt !== null) {
      elapsedBeforeCurrentRunMsRef.current += Math.max(0, Date.now() - startedAt);
      recordingStartedAtMsRef.current = null;
    }
    const seconds = Math.max(
      getElapsedDurationSeconds(),
      getNativeDurationSeconds(),
      capturedDurationRef.current
    );
    capturedDurationRef.current = seconds;
    setElapsedSecondsValue(seconds);
    return seconds;
  }, [getElapsedDurationSeconds, getNativeDurationSeconds, setElapsedSecondsValue]);

  const finalizeDuration = useCallback(() => {
    const seconds = Math.max(freezeElapsedClock(), finalDurationRef.current);
    finalDurationRef.current = seconds;
    setFinalDuration(seconds);
    setElapsedSecondsValue(seconds);
    return seconds;
  }, [freezeElapsedClock, setElapsedSecondsValue]);

  // Status listener for recording events (errors, media reset).
  //
  // Interruption auto-resume contract: when expo-audio emits `hasError` while
  // we believe we're recording, treat that as an audio session interruption
  // (incoming call, Siri, headphones unplugged) rather than a hard stop.
  // Flush bytes to disk via a best-effort `recorder.stop()`, capture the
  // resulting URI, and transition to a new `'interrupted'` state. The caller
  // observes that state, saves the URI as a multi-segment, and auto-restarts
  // recording when AppState returns to 'active'. We do NOT fire the legacy
  // "Recording Issue" Alert here — the banner UI in record.tsx tells the
  // user what's happening; an OS-modal alert on top of an incoming call
  // screen is just noise the user can't dismiss.
  //
  // `mediaServicesDidReset` keeps its dedicated alert path because it
  // signals that the audio daemon itself crashed and the recorder handle is
  // permanently invalid — auto-resume cannot recover. Same for the very
  // first `hasError` we ever see on a recorder that wasn't recording yet.
  const statusListener = useCallback((status: RecordingStatus) => {
    if (status.mediaServicesDidReset && !mediaResetAlertedRef.current) {
      mediaResetAlertedRef.current = true;
      Alert.alert(
        'Recording Interrupted',
        'The audio input was lost (e.g. headphones disconnected). Please stop and start a new recording.'
      );
      return;
    }
    if (!status.hasError) return;
    if (hasErrorAlertedRef.current || mediaResetAlertedRef.current) return;
    hasErrorAlertedRef.current = true;

    const errorMessage = typeof status.error === 'string' ? status.error : JSON.stringify(status.error ?? {});
    if (__DEV__) console.error('[AudioRecorder] Recording error:', status.error);
    breadcrumb('record', 'recorder_status_error', {
      state: stateRef.current,
      will_attempt_interrupt_flow: stateRef.current === 'recording' || stateRef.current === 'paused',
    });
    captureException(new Error(errorMessage || 'expo-audio status.hasError'), {
      tags: { component: 'useAudioRecorder', phase: 'recorder_status' },
    });
    reportClientError({
      phase: 'recorder_status',
      severity: 'error',
      message: errorMessage,
    });

    const wasRecording = stateRef.current === 'recording' || stateRef.current === 'paused';
    if (!wasRecording) {
      // Error during prepare / before record() — there's nothing to flush;
      // surface the legacy alert so the user knows their attempt failed.
      Alert.alert(
        'Recording Issue',
        'An error occurred during recording. The audio may be incomplete or silent — please stop, check your recording, and re-record if needed.'
      );
      return;
    }

    // Best-effort flush + capture URI for the partial segment, then signal
    // the interrupted state so the UI can offer auto-resume.
    runInterruptionFlowRef.current().catch(() => { /* best-effort */ });
  }, []);

  // Shared interruption flow used by both expo-audio's hasError signal (above)
  // and the Android audio-focus loss listener (record.tsx). Captures bytes,
  // transitions to 'interrupted', and lets the caller observe state and run
  // the save+pending-resume flow.
  const runInterruptionFlow = useCallback(async () => {
    const wasRecording = stateRef.current === 'recording' || stateRef.current === 'paused';
    if (!wasRecording) return;
    breadcrumb('record', 'recorder_interrupted', { from_state: stateRef.current });
    const r = recorderRef.current;
    finalizeDuration();
    try {
      if (r) await r.stop();
    } catch {
      // Recording is already broken or already stopped; ignore.
    }
    const uri = r?.uri ?? null;
    latestAudioUriRef.current = uri;
    setAudioUri(uri);
    setState('interrupted');
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  }, [finalizeDuration]);
  const runInterruptionFlowRef = useRef(runInterruptionFlow);
  runInterruptionFlowRef.current = runInterruptionFlow;

  // Durable-backend interruption: the native module has already flushed + marked
  // the manifest interrupted and kept audio.aac. JS just reflects the state so
  // record.tsx arms pending-resume (the audio is already durable — no URI flush).
  const runDurableInterruption = useCallback(() => {
    const wasRecording = stateRef.current === 'recording' || stateRef.current === 'paused';
    if (!wasRecording) return;
    breadcrumb('record', 'durable_recorder_interrupted', { from_state: stateRef.current });
    freezeElapsedClock();
    // The native module flushes + writes the manifest BEFORE emitting the
    // interruption event, but only updates durableDurationMsRef on
    // stop/pause/resume — so a finish taken straight off getDurableSnapshot()
    // here would attribute durationMs=0. Fold in the last committed progress
    // (the crash-safe durably-saved-through time) so the saved durable draft
    // carries a real duration and never triggers a false silent-upload prompt.
    durableDurationMsRef.current = Math.max(
      durableDurationMsRef.current,
      committedThroughMsRef.current,
    );
    setState('interrupted');
  }, [freezeElapsedClock]);
  const runDurableInterruptionRef = useRef(runDurableInterruption);
  runDurableInterruptionRef.current = runDurableInterruption;

  // Durable native event subscriptions. No-op subscriptions when the module is
  // unavailable (bridge returns NOOP), so this is safe on old dev clients.
  useEffect(() => {
    const subs = [
      durableRecorder.addRecordingProgressListener((e) => {
        if (backendRef.current !== 'durable' || e.recordingId !== durableRecordingIdRef.current) return;
        committedThroughMsRef.current = e.committedThroughMs;
        setCommittedThroughMs(e.committedThroughMs);
        setCompleteFrameBytes(e.completeFrameBytes);
        lastCommitAtRef.current = Date.now();
        if (typeof e.peakDb === 'number' && e.peakDb > durablePeakDbRef.current) {
          durablePeakDbRef.current = e.peakDb;
        }
      }),
      durableRecorder.addLiveStatsListener((e) => {
        if (backendRef.current !== 'durable' || e.recordingId !== durableRecordingIdRef.current) return;
        durableLiveRef.current = { meteringDb: e.meteringDb, capturedDurationMs: e.capturedDurationMs };
      }),
      durableRecorder.addInterruptionListener((e) => {
        if (backendRef.current !== 'durable' || e.recordingId !== durableRecordingIdRef.current) return;
        // This flow is FATAL (finalizes + resets the durable slot), so it must run
        // ONLY for genuine capture-losing interruptions. Ignore a focus/audio GAIN
        // signal (resume is driven by AppState 'active') — defense in depth against
        // any platform emitting a gain on the interruption channel.
        const reason = (e as { reason?: unknown } | null)?.reason;
        if (reason === 'focus_gain' || reason === 'gain') return;
        runDurableInterruptionRef.current();
      }),
      durableRecorder.addErrorListener((e) => {
        // Rule 12: gate console behind __DEV__; the typed {code,message} carries no PHI.
        if (__DEV__) console.error('[DurableRecorder] error', e.code, e.message);
      }),
    ];
    return () => {
      for (const s of subs) s.remove();
    };
  }, []);

  // Create the expo-audio recorder (auto-released on unmount)
  const recorder = useExpoAudioRecorder(RECORDING_OPTIONS, statusListener);

  // Forward to the refs the statusListener closes over — see its comment.
  recorderRef.current = recorder;
  stateRef.current = state;

  // App-state as a ref, not state: the poll cadence below reads it at each
  // tick, and nothing should re-render on foreground/background changes.
  const appActiveRef = useRef(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next === 'active';
    });
    return () => sub.remove();
  }, []);

  // Render-free recorder sampling. This used to be useAudioRecorderState +
  // a 250ms display interval — both setState-driven, so every metering tick
  // re-rendered the entire record screen. Now the samples land in refs only:
  // RecorderLiveReadout polls getLiveStats() from a leaf component for the
  // visible waveform/timer, and the screen re-renders only on actual state
  // transitions. Max-metering tracking must stay HERE (not the leaf): the
  // FlatList can unmount the owner card mid-recording on swipe, and
  // peakMetering feeds the silent-audio guard in record.tsx.
  // Cadence: 500ms foreground / 2000ms background (rule 6: responsiveness
  // vs CPU on weak hardware); no polling at all when idle/stopped.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sample = () => {
      if (cancelled) return;
      try {
        const status = recorderRef.current?.getStatus();
        if (status) {
          const metering = typeof status.metering === 'number' ? status.metering : undefined;
          lastStatusRef.current = {
            metering,
            durationMillis: typeof status.durationMillis === 'number' ? status.durationMillis : 0,
          };
          if (metering !== undefined && metering > maxMeteringRef.current) {
            hasMeteringSampleRef.current = true;
            maxMeteringRef.current = metering;
          }
        }
      } catch {
        // Released/broken native handle — keep the last sample.
      }
      timer = setTimeout(sample, appActiveRef.current ? 500 : 2000);
    };
    sample();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state]);

  const getLiveStats = useCallback(() => {
    if (backendRef.current === 'durable') {
      // Durable live feed comes from the native liveStats channel (PCM metering +
      // captured duration), floored by the JS elapsed clock so the timer never
      // stalls if the native push is briefly late.
      const live = durableLiveRef.current;
      return {
        meteringDb: live.meteringDb,
        durationSeconds: Math.max(
          elapsedSecondsRef.current,
          getElapsedDurationSeconds(),
          Math.floor(live.capturedDurationMs / 1000),
        ),
      };
    }
    return {
      meteringDb: lastStatusRef.current?.metering ?? -160,
      // Mirrors getPersistableSnapshot's live branch: the JS clock is the
      // primary source (iOS native status throttling can't make it jump),
      // native duration is the fallback when the JS clock loses (e.g. process
      // was suspended), and the last transition value is the floor.
      durationSeconds: Math.max(
        elapsedSecondsRef.current,
        getElapsedDurationSeconds(),
        getNativeDurationSeconds()
      ),
    };
  }, [getElapsedDurationSeconds, getNativeDurationSeconds]);

  /** Clear durable backend refs + state back to the idle/expo default. */
  const resetDurableState = useCallback(() => {
    backendRef.current = 'expo';
    durableUserIdRef.current = null;
    durableSlotIdRef.current = null;
    durableRecordingIdRef.current = null;
    durablePeakDbRef.current = -160;
    durableDurationMsRef.current = 0;
    durableLiveRef.current = { meteringDb: -160, capturedDurationMs: 0 };
    lastCommitAtRef.current = null;
    setCommittedThroughMs(0);
    setCompleteFrameBytes(0);
    setActiveDurableRecordingId(null);
  }, []);

  /** Snapshot of a finished durable capture (for building the slot's durable ref). */
  const getDurableSnapshot = useCallback((): DurableSnapshot | null => {
    if (!durableRecordingIdRef.current) return null;
    return {
      recordingId: durableRecordingIdRef.current,
      // durableDurationMsRef only advances on pause/resume/successful stop — a
      // timed-out or failed durable stop leaves it stale (possibly 0). Fold in the
      // last committed (crash-safe flushed) and live durations so a recovered
      // finish never saves a real recording as a durationMs=0 card/upload.
      durationMs: Math.max(
        durableDurationMsRef.current,
        committedThroughMsRef.current,
        durableLiveRef.current.capturedDurationMs,
      ),
      peakDb: durablePeakDbRef.current,
      sampleRate: durableSampleRateRef.current,
      bitrate: durableBitrateRef.current,
    };
  }, []);

  const start = useCallback(async (ctx?: DurableStartContext) => {
    if (isStartingRef.current || state !== 'idle') {
      throw new Error(`Recorder not ready (state: ${state})`);
    }
    isStartingRef.current = true;
    setIsStarting(true);
    let startSucceeded = false;
    try {
      // Durable capture path — flag-gated + module-available + context provided.
      // On ANY durable start failure, fall through to the expo-audio path
      // (plan: "If the native module fails to load/start, fall back to
      // expo-audio capture, emit telemetry, show durability unavailable").
      const wantDurable = !!ctx && isDurableCaptureEnabled() && durableRecorder.isAvailable();
      if (wantDurable && ctx) {
        try {
          // Internal Rule-24 timeout: a native start that never settles would
          // otherwise leave isStartingRef=true forever (the finally never runs)
          // → the recorder is permanently locked, and a late-resolving start
          // would attach an orphan durable capture no slot owns. Racing a
          // rejecting timeout lets the finally release the lock and fall through
          // to the expo path. (The record.tsx watchdog is a second layer, but it
          // can't unwind the hook's own start state.)
          let durableStartTimedOut = false;
          const startPromise = durableRecorder.start({
            userId: ctx.userId,
            slotId: ctx.slotId,
            recordingId: ctx.recordingId,
          });
          // If the timeout wins the race we fall back to expo-audio, but the
          // native start may still resolve LATE and own the mic + foreground
          // service with no JS slot referencing it. Discard that orphan capture
          // (best-effort) so it releases the mic instead of racing the expo path.
          startPromise.then(
            () => {
              if (durableStartTimedOut) {
                durableRecorder
                  .discard({ userId: ctx.userId, recordingId: ctx.recordingId })
                  .catch(() => {});
              }
            },
            () => { /* rejected start: nothing to release */ },
          );
          const manifest = await Promise.race([
            startPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => {
                durableStartTimedOut = true;
                reject(new Error('durable start timed out'));
              }, DURABLE_START_TIMEOUT_MS),
            ),
          ]);
          backendRef.current = 'durable';
          durableUserIdRef.current = ctx.userId;
          durableSlotIdRef.current = ctx.slotId;
          durableRecordingIdRef.current = ctx.recordingId;
          durableSampleRateRef.current = manifest.sampleRate;
          durableBitrateRef.current = manifest.bitrate;
          durablePeakDbRef.current = -160;
          durableDurationMsRef.current = 0;
          durableLiveRef.current = { meteringDb: -160, capturedDurationMs: 0 };
          lastCommitAtRef.current = null;
          setCommittedThroughMs(0);
          setCompleteFrameBytes(0);
          setActiveDurableRecordingId(ctx.recordingId);
          startElapsedClock();
          setState('recording');
          setAudioUri(null);
          latestAudioUriRef.current = null;
          maxMeteringRef.current = -160;
          hasMeteringSampleRef.current = false;
          finalDurationRef.current = 0;
          setFinalDuration(0);
          capturedDurationRef.current = 0;
          mediaResetAlertedRef.current = false;
          hasErrorAlertedRef.current = false;
          trackEvent({
            name: 'durable_recorder_started',
            props: { slot_index: 0, sample_rate: manifest.sampleRate, bitrate: manifest.bitrate },
          });
          startSucceeded = true;
          return;
        } catch (durableError) {
          if (__DEV__) console.error('[AudioRecorder] durable start failed, falling back to expo-audio:', durableError);
          trackEvent({ name: 'durable_recorder_unavailable', props: { reason: 'start_failed' } });
          backendRef.current = 'expo';
          durableRecordingIdRef.current = null;
          setActiveDurableRecordingId(null);
          // fall through to expo-audio path below
        }
      } else {
        backendRef.current = 'expo';
      }
      // Android 13+ requires POST_NOTIFICATIONS for the foreground service
      // notification. Cache the session result so every recording start does
      // not pay a repeated bridge/request cost.
      await ensureAndroidRecordingNotificationPermission();

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
        allowsBackgroundRecording: true,
        shouldPlayInBackground: true,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();

      startElapsedClock();
      setState('recording');
      setAudioUri(null);
      latestAudioUriRef.current = null;
      maxMeteringRef.current = -160;
      hasMeteringSampleRef.current = false;
      finalDurationRef.current = 0;
      setFinalDuration(0);
      capturedDurationRef.current = 0;
      mediaResetAlertedRef.current = false;
      hasErrorAlertedRef.current = false;
      startSucceeded = true;
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
      if (!startSucceeded) {
        // Fire-and-forget telemetry — caller is responsible for user-facing
        // Alert, we just want the signal in dashboards. Silent on disabled
        // monitoring + rate-limited on repeats.
        reportClientError({
          phase: 'recorder_start',
          severity: 'error',
          message: 'recorder_start threw',
        });
      }
    }
  }, [state, recorder, startElapsedClock]);

  const pause = useCallback(async () => {
    // Capture duration before native pause — native pause can reset durationMillis to 0
    capturedDurationRef.current = freezeElapsedClock();
    if (backendRef.current === 'durable') {
      try {
        const manifest = await withDurableTimeout(
          durableRecorder.pause(),
          DURABLE_PAUSE_TIMEOUT_MS,
          'durable pause timed out',
        );
        durableDurationMsRef.current = manifest.durationMs;
        durablePeakDbRef.current = Math.max(durablePeakDbRef.current, manifest.peakDb);
        setState('paused');
      } catch (error) {
        if (__DEV__) console.error('[AudioRecorder] durable pause failed:', error);
        reportClientError({
          phase: 'recorder_pause',
          severity: 'warning',
          errorCode: 'DURABLE_PAUSE_FAILED',
          message: String(error),
          durationSeconds: capturedDurationRef.current,
        });
        // Keep the on-disk file recoverable: best-effort graceful stop (native
        // flushes + marks the manifest), then surface to the caller (rethrow)
        // so record.tsx shows feedback (Rule 6 contract).
        finalizeDuration();
        try {
          const stopped = await withDurableTimeout(
            durableRecorder.stop(),
            DURABLE_STOP_TIMEOUT_MS,
            'durable stop timed out',
          );
          durableDurationMsRef.current = stopped.durationMs;
        } catch {
          /* already broken or timed out — file stays recoverable via the manifest */
        }
        setState('stopped');
        throw error;
      }
      return;
    }
    try {
      recorder.pause();
      setState('paused');
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] pause failed:', error);
      // Same expected native interruption as resume() (audio session grabbed
      // mid-record). Recovered below + surfaced via the Alert in record.tsx,
      // so report as a warning with a real code rather than a captureException.
      breadcrumb('record', 'audio_session_interrupted', {
        phase: 'recorder_pause',
        error: String(error),
      });
      reportClientError({
        phase: 'recorder_pause',
        severity: 'warning',
        errorCode: 'AUDIO_SESSION_INTERRUPTED',
        message: String(error),
        durationSeconds: capturedDurationRef.current,
      });
      // Native handle is broken — clean up so user can start fresh
      finalizeDuration();
      try { await recorder.stop(); } catch {}
      const stoppedUri = recorder.uri ?? null;
      latestAudioUriRef.current = stoppedUri;
      setAudioUri(stoppedUri);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      throw error;
    }
  }, [finalizeDuration, freezeElapsedClock, recorder]);

  const resume = useCallback(async () => {
    if (backendRef.current === 'durable') {
      const userId = durableUserIdRef.current;
      const recordingId = durableRecordingIdRef.current;
      if (!userId || !recordingId) {
        // No durable target — nothing to resume into; surface as an error.
        throw new Error('Durable resume: missing recording context');
      }
      // Double-tap / re-entrant resume: the first call owns the restart; a second
      // must not fire a second native resume (native rejects it BUSY) — no-op.
      if (resumeInFlightRef.current) return;
      resumeInFlightRef.current = true;
      try {
        const manifest = await withDurableTimeout(
          durableRecorder.resume({ userId, recordingId }),
          DURABLE_RESUME_TIMEOUT_MS,
          'durable resume timed out',
        );
        durableDurationMsRef.current = manifest.durationMs;
        resumeElapsedClock();
        setState('recording');
      } catch (error) {
        // BUSY = a concurrent resume already restarted this capture (double-tap
        // that raced past the in-flight guard). The live recording belongs to the
        // first call — do NOT stop it. Swallow as a no-op, leaving state intact.
        // Match on the code SUBSTRING: iOS surfaces code "BUSY", Android surfaces
        // "ERR_DURABLE_BUSY" (DurableErrors.BUSY) whose message has no "BUSY" word,
        // so a \bBUSY\b message probe alone would miss Android — dropping the live
        // recording on the PRIMARY platform. The message probe stays as a fallback.
        const codeStr = String((error as { code?: unknown } | null)?.code ?? '');
        if (/BUSY/.test(codeStr) || /\bBUSY\b/.test(String(error))) {
          if (__DEV__) console.warn('[AudioRecorder] durable resume ignored — capture already active');
          return;
        }
        if (__DEV__) console.error('[AudioRecorder] durable resume failed:', error);
        trackEvent({ name: 'durable_resume_failed', props: { error_code: 'RESUME_FAILED' } });
        reportClientError({
          phase: 'recorder_resume',
          severity: 'warning',
          errorCode: 'DURABLE_RESUME_FAILED',
          message: String(error),
          durationSeconds: capturedDurationRef.current,
        });
        // Existing audio.aac stays recoverable; surface a graceful stop.
        finalizeDuration();
        try {
          const stopped = await withDurableTimeout(
            durableRecorder.stop(),
            DURABLE_STOP_TIMEOUT_MS,
            'durable stop timed out',
          );
          durableDurationMsRef.current = stopped.durationMs;
        } catch {
          /* broken or timed out — file stays recoverable via the manifest */
        }
        setState('stopped');
        throw error;
      } finally {
        resumeInFlightRef.current = false;
      }
      return;
    }
    try {
      recorder.record();
      resumeElapsedClock();
      setState('recording');
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] resume failed:', error);
      // Expected native interruption: the OS audio session was grabbed by an
      // incoming call / Siri / another app while paused, so record() is
      // rejected (java.lang.IllegalStateException). Fully recovered below
      // (audio up to the pause is preserved) and surfaced to the user via the
      // Alert in record.tsx — so this is a warning, not a captureException
      // (which paged Sentry REACT-NATIVE-X as an unresolved error).
      breadcrumb('record', 'audio_session_interrupted', {
        phase: 'recorder_resume',
        error: String(error),
      });
      reportClientError({
        phase: 'recorder_resume',
        severity: 'warning',
        errorCode: 'AUDIO_SESSION_INTERRUPTED',
        message: String(error),
        durationSeconds: capturedDurationRef.current,
      });
      // Native handle is broken — clean up so user can start fresh
      finalizeDuration();
      try { await recorder.stop(); } catch {}
      const stoppedUri = recorder.uri ?? null;
      latestAudioUriRef.current = stoppedUri;
      setAudioUri(stoppedUri);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      throw error;
    }
  }, [finalizeDuration, recorder, resumeElapsedClock]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const durationSeconds = finalizeDuration();
    if (backendRef.current === 'durable') {
      // Rule 6: stop() swallows native rejections; state + refs always cleaned.
      // Rule 24: race the native stop against an internal timeout so a hung
      // durable bridge can't leave stoppingRef=true forever (which would make
      // every later Finish/Save-for-Later early-return at the guard above). The
      // finally ALWAYS unwinds the lock + state. The audio.aac + manifest stay on
      // disk (recoverable next launch); getDurableSnapshot() reads the last-polled
      // duration, so the finish path still saves a durable draft.
      try {
        const manifest = await Promise.race([
          durableRecorder.stop(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('durable stop timed out')), DURABLE_STOP_TIMEOUT_MS),
          ),
        ]);
        durableDurationMsRef.current = manifest.durationMs;
        durablePeakDbRef.current = Math.max(durablePeakDbRef.current, manifest.peakDb);
      } catch (error) {
        if (__DEV__) console.error('[AudioRecorder] durable stop failed:', error);
        reportClientError({
          phase: 'recorder_stop',
          severity: 'error',
          message: String(error),
          durationSeconds,
        });
      } finally {
        // No expo audioUri for durable — the durable recordingId is the pointer.
        setAudioUri(null);
        latestAudioUriRef.current = null;
        setState('stopped');
        stoppingRef.current = false;
      }
      return;
    }
    try {
      await recorder.stop();
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] stop failed:', error);
      captureException(error, { tags: { component: 'useAudioRecorder', phase: 'recorder_stop' } });
      reportClientError({
        phase: 'recorder_stop',
        severity: 'error',
        message: String(error),
        durationSeconds,
      });
    }
    const stoppedUri = recorder.uri ?? null;
    latestAudioUriRef.current = stoppedUri;
    setAudioUri(stoppedUri);
    setState('stopped');
    stoppingRef.current = false;

    await setAudioModeAsync({
      allowsRecording: false,
    }).catch(() => {});
  }, [finalizeDuration, recorder]);

  const reset = useCallback(() => {
    if (latestAudioUriRef.current) {
      safeDeleteFile(latestAudioUriRef.current);
    }
    // reset() is the DELETE/discard variant (resetWithoutDelete keeps the file).
    // If a durable capture is still live+bound here, discard its native audio.aac
    // + manifest BEFORE resetDurableState() clears the recordingId — otherwise the
    // launch recovery scan re-offers a recording the user explicitly discarded.
    if (
      backendRef.current === 'durable' &&
      durableUserIdRef.current &&
      durableRecordingIdRef.current
    ) {
      durableRecorder
        .discard({ userId: durableUserIdRef.current, recordingId: durableRecordingIdRef.current })
        .catch(() => {});
    }
    setState('idle');
    setAudioUri(null);
    latestAudioUriRef.current = null;
    maxMeteringRef.current = -160;
    hasMeteringSampleRef.current = false;
    setFinalDuration(0);
    finalDurationRef.current = 0;
    resetElapsedClock();
    capturedDurationRef.current = 0;
    stoppingRef.current = false;
    mediaResetAlertedRef.current = false;
    hasErrorAlertedRef.current = false;
    resetDurableState();
  }, [resetElapsedClock, resetDurableState]);

  const resetWithoutDelete = useCallback(() => {
    setState('idle');
    setAudioUri(null);
    latestAudioUriRef.current = null;
    maxMeteringRef.current = -160;
    hasMeteringSampleRef.current = false;
    setFinalDuration(0);
    finalDurationRef.current = 0;
    resetElapsedClock();
    capturedDurationRef.current = 0;
    stoppingRef.current = false;
    mediaResetAlertedRef.current = false;
    hasErrorAlertedRef.current = false;
    resetDurableState();
  }, [resetElapsedClock, resetDurableState]);

  return {
    state,
    isStarting,
    duration:
      state === 'stopped' || state === 'interrupted'
        ? finalDuration
        : elapsedSeconds,
    maxMetering: hasMeteringSampleRef.current ? maxMeteringRef.current : undefined,
    getLiveStats,
    audioUri,
    mimeType: activeDurableRecordingId ? 'audio/aac' : 'audio/x-m4a',
    getPersistableSnapshot: () => ({
      audioUri: latestAudioUriRef.current,
      duration: finalDurationRef.current > 0
        ? finalDurationRef.current
        : Math.max(elapsedSecondsRef.current, getElapsedDurationSeconds(), getNativeDurationSeconds()),
      maxMetering: hasMeteringSampleRef.current ? maxMeteringRef.current : undefined,
    }),
    activeDurableRecordingId,
    recoverableDurableRecordingId: null,
    committedThroughMs,
    completeFrameBytes,
    lastCommitAt: lastCommitAtRef.current,
    getDurableSnapshot,
    start,
    pause,
    resume,
    stop,
    reset,
    resetWithoutDelete,
    triggerInterruption: runInterruptionFlow,
    isSupported: true,
  };
}

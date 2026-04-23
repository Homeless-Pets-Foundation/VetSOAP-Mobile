import { useState, useCallback, useEffect, useRef } from 'react';
import { Alert, Platform, PermissionsAndroid } from 'react-native';
import {
  useAudioRecorder as useExpoAudioRecorder,
  useAudioRecorderState,
  setAudioModeAsync,
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
  type RecordingStatus,
} from 'expo-audio';
import { safeDeleteFile } from '../lib/fileOps';
import { captureException } from '../lib/monitoring';
import { reportClientError } from '../api/telemetry';

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

export interface UseAudioRecorderReturn {
  state: RecordingState;
  isStarting: boolean;
  duration: number;
  metering: number;
  maxMetering?: number;
  audioUri: string | null;
  mimeType: string;
  getPersistableSnapshot: () => {
    audioUri: string | null;
    duration: number;
    maxMetering?: number;
  };
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  resetWithoutDelete: () => void;
  isSupported: boolean;
}

const RECORDING_OPTIONS: RecordingOptions = {
  isMeteringEnabled: true,
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 2,
  bitRate: 256000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    audioSource: 'voice_recognition',
  },
  ios: {
    audioQuality: AudioQuality.MAX,
    outputFormat: IOSOutputFormat.MPEG4AAC,
    bitRateStrategy: 0, // CONSTANT — consistent bitrate throughout recording
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm;codecs=opus',
    bitsPerSecond: 256000,
  },
};

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [finalDuration, setFinalDuration] = useState(0);

  const [isStarting, setIsStarting] = useState(false);
  const stoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  const mediaResetAlertedRef = useRef(false);
  const hasErrorAlertedRef = useRef(false);
  const latestAudioUriRef = useRef<string | null>(null);
  const maxMeteringRef = useRef(-160);
  const hasMeteringSampleRef = useRef(false);
  const finalDurationRef = useRef(0);
  // Capture duration before pause/stop — native pause can reset the polled durationMillis to 0
  const capturedDurationRef = useRef(0);

  // Status listener for recording events (errors, media reset)
  const statusListener = useCallback((status: RecordingStatus) => {
    if (status.mediaServicesDidReset && !mediaResetAlertedRef.current) {
      mediaResetAlertedRef.current = true;
      Alert.alert(
        'Recording Interrupted',
        'The audio input was lost (e.g. headphones disconnected). Please stop and start a new recording.'
      );
    }
    if (status.hasError && !hasErrorAlertedRef.current && !mediaResetAlertedRef.current) {
      hasErrorAlertedRef.current = true;
      if (__DEV__) console.error('[AudioRecorder] Recording error:', status.error);
      const errorMessage = typeof status.error === 'string' ? status.error : JSON.stringify(status.error ?? {});
      captureException(new Error(errorMessage || 'expo-audio status.hasError'), {
        tags: { component: 'useAudioRecorder', phase: 'recorder_status' },
      });
      reportClientError({
        phase: 'recorder_status',
        severity: 'error',
        message: errorMessage,
      });
      Alert.alert(
        'Recording Issue',
        'An error occurred during recording. The audio may be incomplete or silent — please stop, check your recording, and re-record if needed.'
      );
    }
  }, []);

  // Create the expo-audio recorder (auto-released on unmount)
  const recorder = useExpoAudioRecorder(RECORDING_OPTIONS, statusListener);

  // Poll for status (duration, metering) — 500ms balances responsiveness with CPU usage on weak hardware
  const recorderState = useAudioRecorderState(recorder, 500);

  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    const currentMetering = recorderState.metering;
    if (typeof currentMetering === 'number' && currentMetering > maxMeteringRef.current) {
      hasMeteringSampleRef.current = true;
      maxMeteringRef.current = currentMetering;
    }
  }, [recorderState.metering, state]);

  const start = useCallback(async () => {
    if (isStartingRef.current || state !== 'idle') {
      throw new Error(`Recorder not ready (state: ${state})`);
    }
    isStartingRef.current = true;
    setIsStarting(true);
    let startSucceeded = false;
    try {
      // Android 13+ requires POST_NOTIFICATIONS for the foreground service notification.
      // Without it the background recording service may fail to start silently.
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        try {
          await PermissionsAndroid.request(
            'android.permission.POST_NOTIFICATIONS' as any,
          );
          // Recording still works if denied — just no persistent notification,
          // which may let the OS kill the process. Not a blocker.
        } catch {}
      }

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

      setState('recording');
      setAudioUri(null);
      latestAudioUriRef.current = null;
      maxMeteringRef.current = -160;
      hasMeteringSampleRef.current = false;
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
  }, [state, recorder]);

  const pause = useCallback(async () => {
    // Capture duration before native pause — Android can reset polled durationMillis to 0
    capturedDurationRef.current = Math.floor(recorderState.durationMillis / 1000);
    try {
      recorder.pause();
      setState('paused');
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] pause failed:', error);
      captureException(error, { tags: { component: 'useAudioRecorder', phase: 'recorder_pause' } });
      reportClientError({
        phase: 'recorder_pause',
        severity: 'error',
        message: String(error),
        durationSeconds: capturedDurationRef.current,
      });
      // Native handle is broken — clean up so user can start fresh
      finalDurationRef.current = capturedDurationRef.current;
      setFinalDuration(capturedDurationRef.current);
      try { await recorder.stop(); } catch {}
      const stoppedUri = recorder.uri ?? null;
      latestAudioUriRef.current = stoppedUri;
      setAudioUri(stoppedUri);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      throw error;
    }
  }, [recorder, recorderState.durationMillis]);

  const resume = useCallback(async () => {
    try {
      recorder.record();
      setState('recording');
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] resume failed:', error);
      captureException(error, { tags: { component: 'useAudioRecorder', phase: 'recorder_resume' } });
      reportClientError({
        phase: 'recorder_resume',
        severity: 'error',
        message: String(error),
      });
      // Native handle is broken — clean up so user can start fresh
      // Use captured duration since polled value may be 0 while paused
      const polledDuration = Math.floor(recorderState.durationMillis / 1000);
      finalDurationRef.current = polledDuration > 0 ? polledDuration : capturedDurationRef.current;
      setFinalDuration(finalDurationRef.current);
      try { await recorder.stop(); } catch {}
      const stoppedUri = recorder.uri ?? null;
      latestAudioUriRef.current = stoppedUri;
      setAudioUri(stoppedUri);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      throw error;
    }
  }, [recorder, recorderState.durationMillis]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    // Use polled duration if available, otherwise fall back to duration captured before pause
    const polledDuration = Math.floor(recorderState.durationMillis / 1000);
    finalDurationRef.current = polledDuration > 0 ? polledDuration : capturedDurationRef.current;
    setFinalDuration(finalDurationRef.current);
    try {
      await recorder.stop();
    } catch (error) {
      if (__DEV__) console.error('[AudioRecorder] stop failed:', error);
      captureException(error, { tags: { component: 'useAudioRecorder', phase: 'recorder_stop' } });
      reportClientError({
        phase: 'recorder_stop',
        severity: 'error',
        message: String(error),
        durationSeconds: finalDurationRef.current,
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
  }, [recorder, recorderState.durationMillis]);

  const reset = useCallback(() => {
    if (latestAudioUriRef.current) {
      safeDeleteFile(latestAudioUriRef.current);
    }
    setState('idle');
    setAudioUri(null);
    latestAudioUriRef.current = null;
    maxMeteringRef.current = -160;
    hasMeteringSampleRef.current = false;
    setFinalDuration(0);
    finalDurationRef.current = 0;
    capturedDurationRef.current = 0;
    stoppingRef.current = false;
    mediaResetAlertedRef.current = false;
    hasErrorAlertedRef.current = false;
  }, []);

  const resetWithoutDelete = useCallback(() => {
    setState('idle');
    setAudioUri(null);
    latestAudioUriRef.current = null;
    maxMeteringRef.current = -160;
    hasMeteringSampleRef.current = false;
    setFinalDuration(0);
    finalDurationRef.current = 0;
    capturedDurationRef.current = 0;
    stoppingRef.current = false;
    mediaResetAlertedRef.current = false;
    hasErrorAlertedRef.current = false;
  }, []);

  return {
    state,
    isStarting,
    duration: state === 'stopped' ? finalDuration : Math.floor(recorderState.durationMillis / 1000),
    metering: recorderState.metering ?? -160,
    maxMetering: hasMeteringSampleRef.current ? maxMeteringRef.current : undefined,
    audioUri,
    mimeType: 'audio/x-m4a',
    getPersistableSnapshot: () => ({
      audioUri: latestAudioUriRef.current,
      duration: finalDurationRef.current > 0
        ? finalDurationRef.current
        : Math.floor(recorderState.durationMillis / 1000),
      maxMetering: hasMeteringSampleRef.current ? maxMeteringRef.current : undefined,
    }),
    start,
    pause,
    resume,
    stop,
    reset,
    resetWithoutDelete,
    isSupported: true,
  };
}

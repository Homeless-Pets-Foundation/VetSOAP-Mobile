import { useState, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import {
  useAudioRecorder as useExpoAudioRecorder,
  useAudioRecorderState,
  setAudioModeAsync,
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
  type RecordingStatus,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system';

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

export interface UseAudioRecorderReturn {
  state: RecordingState;
  duration: number;
  metering: number;
  audioUri: string | null;
  mimeType: string;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
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

  const stoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  const mediaResetAlertedRef = useRef(false);

  // Status listener for recording events (errors, media reset)
  const statusListener = useCallback((status: RecordingStatus) => {
    if (status.mediaServicesDidReset && !mediaResetAlertedRef.current) {
      mediaResetAlertedRef.current = true;
      Alert.alert(
        'Recording Interrupted',
        'The audio input was lost (e.g. headphones disconnected). Please stop and start a new recording.'
      );
    }
    if (status.hasError) {
      console.error('[AudioRecorder] Recording error:', status.error);
    }
  }, []);

  // Create the expo-audio recorder (auto-released on unmount)
  const recorder = useExpoAudioRecorder(RECORDING_OPTIONS, statusListener);

  // Poll for status (duration, metering) at 250ms intervals
  const recorderState = useAudioRecorderState(recorder, 250);

  const start = useCallback(async () => {
    if (isStartingRef.current || state !== 'idle') return;
    isStartingRef.current = true;
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();

      setState('recording');
      setAudioUri(null);
      mediaResetAlertedRef.current = false;
    } finally {
      isStartingRef.current = false;
    }
  }, [state, recorder]);

  const pause = useCallback(async () => {
    try {
      recorder.pause();
      setState('paused');
    } catch (error) {
      console.error('[AudioRecorder] pause failed:', error);
      // Native handle is broken — clean up so user can start fresh
      setFinalDuration(Math.floor(recorderState.durationMillis / 1000));
      try { await recorder.stop(); } catch {}
      setAudioUri(recorder.uri ?? null);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
  }, [recorder, recorderState.durationMillis]);

  const resume = useCallback(async () => {
    try {
      recorder.record();
      setState('recording');
    } catch (error) {
      console.error('[AudioRecorder] resume failed:', error);
      // Native handle is broken — clean up so user can start fresh
      setFinalDuration(Math.floor(recorderState.durationMillis / 1000));
      try { await recorder.stop(); } catch {}
      setAudioUri(recorder.uri ?? null);
      setState('stopped');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
  }, [recorder, recorderState.durationMillis]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    // Capture duration before native stop resets it
    setFinalDuration(Math.floor(recorderState.durationMillis / 1000));
    try {
      await recorder.stop();
    } catch (error) {
      console.error('[AudioRecorder] stop failed:', error);
    }
    setAudioUri(recorder.uri ?? null);
    setState('stopped');
    stoppingRef.current = false;

    await setAudioModeAsync({
      allowsRecording: false,
    }).catch(() => {});
  }, [recorder, recorderState.durationMillis]);

  const reset = useCallback(() => {
    if (audioUri) {
      FileSystem.deleteAsync(audioUri, { idempotent: true }).catch(() => {});
    }
    setState('idle');
    setAudioUri(null);
    setFinalDuration(0);
    stoppingRef.current = false;
    mediaResetAlertedRef.current = false;
  }, [audioUri]);

  return {
    state,
    duration: state === 'stopped' ? finalDuration : Math.floor(recorderState.durationMillis / 1000),
    metering: recorderState.metering ?? -160,
    audioUri,
    mimeType: 'audio/x-m4a',
    start,
    pause,
    resume,
    stop,
    reset,
    isSupported: true,
  };
}

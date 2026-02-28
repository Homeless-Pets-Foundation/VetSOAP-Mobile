import { useState, useCallback, useRef, useEffect } from 'react';
import { Audio } from 'expo-av';

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopped';

export interface UseAudioRecorderReturn {
  state: RecordingState;
  duration: number;
  audioUri: string | null;
  mimeType: string;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  isSupported: boolean;
  permissionGranted: boolean;
}

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.m4a',
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 128000,
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
  },
  web: {
    mimeType: 'audio/webm;codecs=opus',
    bitsPerSecond: 128000,
  },
};

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);

  const recordingRef = useRef<Audio.Recording | null>(null);

  // Request permissions on mount
  useEffect(() => {
    Audio.requestPermissionsAsync().then(({ granted }) => {
      setPermissionGranted(granted);
    });
  }, []);

  const start = useCallback(async () => {
    if (!permissionGranted) {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        throw new Error('Microphone permission not granted');
      }
      setPermissionGranted(true);
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync(RECORDING_OPTIONS);

    recording.setOnRecordingStatusUpdate((status) => {
      if (status.isRecording && status.durationMillis) {
        setDuration(Math.floor(status.durationMillis / 1000));
      }
    });

    await recording.startAsync();
    recordingRef.current = recording;

    setState('recording');
    setDuration(0);
    setAudioUri(null);
  }, [permissionGranted]);

  const pause = useCallback(async () => {
    if (recordingRef.current) {
      await recordingRef.current.pauseAsync();
      setState('paused');
    }
  }, []);

  const resume = useCallback(async () => {
    if (recordingRef.current) {
      await recordingRef.current.startAsync();
      setState('recording');
    }
  }, []);

  const stop = useCallback(async () => {
    if (recordingRef.current) {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      setAudioUri(uri);
      recordingRef.current = null;
      setState('stopped');

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });
    }
  }, []);

  const reset = useCallback(() => {
    setState('idle');
    setDuration(0);
    setAudioUri(null);
    recordingRef.current = null;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  return {
    state,
    duration,
    audioUri,
    mimeType: 'audio/mp4',
    start,
    pause,
    resume,
    stop,
    reset,
    isSupported: true,
    permissionGranted,
  };
}

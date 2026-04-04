import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioPlayer,
  setAudioModeAsync,
} from 'expo-audio';
import { useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

export interface UseAudioPlaybackReturn {
  isLoaded: boolean;
  isPlaying: boolean;
  duration: number;
  isBuffering: boolean;
  currentTimeSV: SharedValue<number>;
  currentTimeRef: React.RefObject<number>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekTo: (seconds: number) => Promise<void>;
  loadSource: (uri: string) => Promise<void>;
}

export function useAudioPlayback(): UseAudioPlaybackReturn {
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const audioModeSetRef = useRef(false);

  // High-frequency state — never causes React re-renders
  const currentTimeSV = useSharedValue(0);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);

  // Low-frequency discrete state — only updates on meaningful changes
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [duration, setDuration] = useState(0);

  // Manual event subscription — avoids useAudioPlayerStatus triggering re-renders every 100ms
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      // High-frequency path: update shared value + ref without React state
      currentTimeSV.value = status.currentTime;
      currentTimeRef.current = status.currentTime;
      durationRef.current = status.duration;

      // Low-frequency path: only setState when value actually changed
      if (status.isLoaded !== isLoadedRef.current) {
        isLoadedRef.current = status.isLoaded;
        setIsLoaded(status.isLoaded);
      }
      if (status.playing !== isPlayingRef.current) {
        isPlayingRef.current = status.playing;
        setIsPlaying(status.playing);
      }
      if (status.isBuffering !== isBufferingRef.current) {
        isBufferingRef.current = status.isBuffering;
        setIsBuffering(status.isBuffering);
      }
      if (status.duration !== durationStateRef.current) {
        durationStateRef.current = status.duration;
        setDuration(status.duration);
      }
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- player is stable; refs avoid stale closures
  }, [player]);

  // Shadow refs to track current state values inside the listener without closure staleness
  const isLoadedRef = useRef(false);
  const isPlayingRef = useRef(false);
  const isBufferingRef = useRef(false);
  const durationStateRef = useRef(0);

  const ensurePlaybackMode = useCallback(async () => {
    if (audioModeSetRef.current) return;
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      audioModeSetRef.current = true;
    } catch {
      // Best-effort — playback may still work
    }
  }, []);

  const loadSource = useCallback(
    async (uri: string) => {
      await ensurePlaybackMode();
      try {
        player.replace({ uri });
      } catch (error) {
        if (__DEV__) console.error('[Playback] loadSource failed:', error);
      }
    },
    [player, ensurePlaybackMode]
  );

  const play = useCallback(() => {
    if (!isLoaded) return;
    ensurePlaybackMode()
      .then(() => {
        try {
          player.play();
        } catch (error) {
          if (__DEV__) console.error('[Playback] play failed:', error);
        }
      })
      .catch((error) => {
        if (__DEV__) console.error('[Playback] play: ensurePlaybackMode failed:', error);
      });
  }, [player, isLoaded, ensurePlaybackMode]);

  const pause = useCallback(() => {
    try {
      player.pause();
    } catch (error) {
      if (__DEV__) console.error('[Playback] pause failed:', error);
    }
  }, [player]);

  const toggle = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const seekTo = useCallback(
    async (seconds: number) => {
      try {
        const clamped = Math.max(0, Math.min(seconds, durationRef.current || 0));
        await player.seekTo(clamped);
      } catch (error) {
        if (__DEV__) console.error('[Playback] seekTo failed:', error);
      }
    },
    [player]
  );

  return {
    isLoaded,
    isPlaying,
    duration,
    isBuffering,
    currentTimeSV,
    currentTimeRef,
    play,
    pause,
    toggle,
    seekTo,
    loadSource,
  };
}

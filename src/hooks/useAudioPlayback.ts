import { useCallback, useRef } from 'react';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  setAudioModeAsync,
} from 'expo-audio';

export interface UseAudioPlaybackReturn {
  isLoaded: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isBuffering: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekTo: (seconds: number) => Promise<void>;
  loadSource: (uri: string) => void;
}

export function useAudioPlayback(): UseAudioPlaybackReturn {
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const audioModeSetRef = useRef(false);

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
    (uri: string) => {
      try {
        player.replace({ uri });
      } catch (error) {
        if (__DEV__) console.error('[Playback] loadSource failed:', error);
      }
    },
    [player]
  );

  const play = useCallback(() => {
    ensurePlaybackMode()
      .then(() => {
        try {
          player.play();
        } catch (error) {
          if (__DEV__) console.error('[Playback] play failed:', error);
        }
      })
      .catch(() => {});
  }, [player, ensurePlaybackMode]);

  const pause = useCallback(() => {
    try {
      player.pause();
    } catch (error) {
      if (__DEV__) console.error('[Playback] pause failed:', error);
    }
  }, [player]);

  const toggle = useCallback(() => {
    if (status.playing) {
      pause();
    } else {
      play();
    }
  }, [status.playing, play, pause]);

  const seekTo = useCallback(
    async (seconds: number) => {
      try {
        const clamped = Math.max(0, Math.min(seconds, status.duration || 0));
        await player.seekTo(clamped);
      } catch (error) {
        if (__DEV__) console.error('[Playback] seekTo failed:', error);
      }
    },
    [player, status.duration]
  );

  return {
    isLoaded: status.isLoaded,
    isPlaying: status.playing,
    currentTime: status.currentTime,
    duration: status.duration,
    isBuffering: status.isBuffering,
    play,
    pause,
    toggle,
    seekTo,
    loadSource,
  };
}

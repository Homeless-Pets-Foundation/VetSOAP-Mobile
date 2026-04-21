import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioPlayer,
  setAudioModeAsync,
} from 'expo-audio';
import { useSharedValue, useFrameCallback } from 'react-native-reanimated';
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

  // Anchors for 60 Hz playhead interpolation (useFrameCallback below). Updated on every native
  // status tick; useFrameCallback extrapolates currentTimeSV between ticks so the playhead
  // slides continuously at display-refresh rate instead of stepping 10×/sec.
  // SVs (not refs) because useFrameCallback runs as a worklet on the UI thread.
  //
  // lastStatusTimeSV is written by the JS thread (media position from expo-audio);
  // anchorFrameTimestampSV is written from inside the frame callback itself whenever the
  // JS anchor changes, so interpolation uses only UI-thread frame timestamps — no cross-thread
  // wall-clock dependency (iOS/Android map performance.now() to different clocks on different
  // threads, which would produce drift).
  const lastStatusTimeSV = useSharedValue(0);
  const anchorFrameTimestampSV = useSharedValue(0);
  const prevAnchorTimeSV = useSharedValue(-1);
  const isPlayingSV = useSharedValue(false);
  const durationSV = useSharedValue(0);

  // Low-frequency discrete state — only updates on meaningful changes
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [duration, setDuration] = useState(0);

  // Manual event subscription — avoids useAudioPlayerStatus triggering re-renders every 100ms
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      // High-frequency path: update shared values + ref without React state
      currentTimeSV.value = status.currentTime;
      currentTimeRef.current = status.currentTime;
      durationRef.current = status.duration;
      durationSV.value = status.duration;
      // Re-anchor interpolation on each real native tick. The UI-thread frame callback
      // picks this up and captures its own frame.timestamp as the wall-clock reference,
      // so no cross-thread clock comparison is needed.
      lastStatusTimeSV.value = status.currentTime;

      // Low-frequency path: only setState when value actually changed
      if (status.isLoaded !== isLoadedRef.current) {
        isLoadedRef.current = status.isLoaded;
        setIsLoaded(status.isLoaded);
      }
      if (status.playing !== isPlayingRef.current) {
        isPlayingRef.current = status.playing;
        isPlayingSV.value = status.playing;
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

  // 60 Hz playhead interpolation. expo-audio's status update interval is 100 ms, which would
  // otherwise produce a visibly stepping playhead. Between native ticks we extrapolate using
  // the delta between frame timestamps; every real tick resets the anchor so the interpolation
  // stays pinned to the native clock. Skipped while paused so the SV freezes at the last tick.
  useFrameCallback((frame) => {
    'worklet';
    // Detect a fresh anchor written by the JS thread and capture this frame's timestamp
    // as the interpolation reference (UI-thread frame timestamps only — no cross-thread
    // clock comparison).
    if (lastStatusTimeSV.value !== prevAnchorTimeSV.value) {
      prevAnchorTimeSV.value = lastStatusTimeSV.value;
      anchorFrameTimestampSV.value = frame.timestamp;
    }
    if (!isPlayingSV.value) return;
    if (anchorFrameTimestampSV.value === 0) return;
    const elapsed = (frame.timestamp - anchorFrameTimestampSV.value) / 1000;
    const interpolated = lastStatusTimeSV.value + elapsed;
    const dur = durationSV.value;
    currentTimeSV.value = dur > 0 ? Math.min(dur, interpolated) : interpolated;
  }, true);

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
      .then(async () => {
        try {
          // Auto-rewind from EOF: expo-audio leaves currentTime at duration after natural
          // end-of-clip, and a subsequent play() just sits there. Reset to start so the
          // next play actually plays.
          const dur = durationRef.current;
          if (dur > 0 && currentTimeRef.current >= dur - 0.05) {
            await player.seekTo(0);
            currentTimeSV.value = 0;
            currentTimeRef.current = 0;
            lastStatusTimeSV.value = 0;
          }
          player.play();
        } catch (error) {
          if (__DEV__) console.error('[Playback] play failed:', error);
        }
      })
      .catch((error) => {
        if (__DEV__) console.error('[Playback] play: ensurePlaybackMode failed:', error);
      });
  }, [player, isLoaded, ensurePlaybackMode, currentTimeSV, lastStatusTimeSV]);

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
        // When paused, expo-audio doesn't fire playbackStatusUpdate after seek, so the
        // local SV/ref/anchor would stay at the pre-seek time and the playhead wouldn't
        // move on screen. Sync them directly to the clamped target.
        currentTimeSV.value = clamped;
        currentTimeRef.current = clamped;
        lastStatusTimeSV.value = clamped;
      } catch (error) {
        if (__DEV__) console.error('[Playback] seekTo failed:', error);
      }
    },
    [player, currentTimeSV, lastStatusTimeSV]
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

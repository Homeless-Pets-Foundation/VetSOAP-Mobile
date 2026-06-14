import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { Play, Pause, RotateCcw, RotateCw, Mic } from 'lucide-react-native';
import { Card } from './ui/Card';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import { recordingActivity } from '../lib/recordingActivity';
import { trackEvent } from '../lib/analytics';
import { useThemeColors } from '../hooks/useThemeColors';
import { AUDIO_PLAYER_COPY } from '../constants/strings';

const LOAD_WATCHDOG_MS = 15_000;
const SEEK_STEP_SECONDS = 15;

type PlayerPhase = 'idle' | 'fetching' | 'loading' | 'ready' | 'error';

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface RecordingAudioPlayerProps {
  recordingId: string;
}

/**
 * Streams a recording's audio from R2 via short-lived presigned URLs
 * (`recordingsApi.getPlaybackUrl`). URLs are fetched lazily on the first Play
 * tap — not on mount — so opening a detail screen never issues (and audits)
 * a playback URL the vet doesn't use. On a load failure the URL is re-fetched
 * once (it may simply have expired), then degrades to an inline
 * "Audio unavailable" — never an Alert loop.
 */
export function RecordingAudioPlayer({ recordingId }: RecordingAudioPlayerProps) {
  const colors = useThemeColors();
  const [recordingActive, setRecordingActive] = useState(recordingActivity.isActive());

  useEffect(() => {
    // Re-sync first: the flag may have flipped between the initial useState
    // read (render time) and this subscription (post-mount).
    setRecordingActive(recordingActivity.isActive());
    return recordingActivity.subscribe(setRecordingActive);
  }, []);

  // While a recording session owns the recorder, the player must not
  // initialize: ensurePlaybackMode() would flip allowsRecording off under the
  // live recorder (rule-6 failure class). Render an inert hint instead; the
  // inner player unmounts entirely (releasing any native player) if a
  // recording starts mid-playback.
  if (recordingActive) {
    return (
      <Card className="mx-5 mb-4">
        <Text className="text-body-lg font-semibold text-content-primary mb-1">
          {AUDIO_PLAYER_COPY.title}
        </Text>
        <View className="flex-row items-center">
          <Mic size={16} color={colors.contentTertiary} style={{ flexShrink: 0 }} />
          {/* flex-1 so the hint wraps instead of clipping (Android Text-in-flex-row gotcha) */}
          <Text className="flex-1 ml-2 text-body-sm text-content-tertiary">
            {AUDIO_PLAYER_COPY.disabledWhileRecording}
          </Text>
        </View>
      </Card>
    );
  }

  return <ActiveAudioPlayer recordingId={recordingId} />;
}

function ActiveAudioPlayer({ recordingId }: { recordingId: string }) {
  const colors = useThemeColors();
  const playback = useAudioPlayback();
  const { isLoaded, isPlaying, duration, isBuffering, currentTimeSV, currentTimeRef } = playback;

  const [phase, setPhase] = useState<PlayerPhase>('idle');
  const [segmentUrls, setSegmentUrls] = useState<string[]>([]);
  const [activeSegment, setActiveSegment] = useState(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const urlRefetchUsedRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const startedEmittedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  const failPlayback = useCallback(
    (errorCode: string) => {
      if (!mountedRef.current) return;
      setPhase('error');
      setErrorCode(errorCode);
      pendingPlayRef.current = false;
      trackEvent({
        name: 'audio_playback_failed',
        props: { recording_id: recordingId, error_code: errorCode },
      });
    },
    [recordingId]
  );

  /**
   * Load one segment URL into the player with a watchdog (rule 24): expo-audio
   * swallows replace() errors, so a bad/expired URL just leaves isLoaded false
   * forever. Watchdog → one fresh-URL retry → inline error.
   */
  const loadSegment = useCallback(
    async (urls: string[], index: number) => {
      const uri = urls[index];
      if (!uri) {
        failPlayback('missing_segment_url');
        return;
      }
      setPhase('loading');
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (!urlRefetchUsedRef.current) {
          urlRefetchUsedRef.current = true;
          recordingsApi
            .getPlaybackUrl(recordingId)
            .then((fresh) => {
              if (!mountedRef.current) return;
              setSegmentUrls(fresh.segmentUrls);
              return loadSegment(fresh.segmentUrls, index);
            })
            .catch(() => failPlayback('url_refetch_failed'));
        } else {
          failPlayback('load_timeout');
        }
      }, LOAD_WATCHDOG_MS);
      try {
        await playback.loadSource(uri);
      } catch (error) {
        if (watchdogRef.current) {
          clearTimeout(watchdogRef.current);
          watchdogRef.current = null;
        }
        throw error;
      }
    },
    [failPlayback, playback, recordingId]
  );

  // Load completion: clear the watchdog and start playback if a Play tap is
  // pending. isLoaded also flips when switching segments.
  useEffect(() => {
    if (!isLoaded) return;
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    setPhase('ready');
    if (pendingPlayRef.current) {
      pendingPlayRef.current = false;
      playback.play();
      if (!startedEmittedRef.current) {
        startedEmittedRef.current = true;
        trackEvent({ name: 'audio_playback_started', props: { recording_id: recordingId } });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- play/trackEvent are stable; isLoaded is the trigger
  }, [isLoaded]);

  // Low-frequency time display (the SV updates at 60 Hz for the progress bar;
  // React state only needs ~2 Hz for the mm:ss label).
  useEffect(() => {
    if (!isPlaying) {
      setDisplayTime(currentTimeRef.current ?? 0);
      return;
    }
    const interval = setInterval(() => {
      setDisplayTime(currentTimeRef.current ?? 0);
    }, 500);
    return () => clearInterval(interval);
  }, [isPlaying, currentTimeRef]);

  const progressStyle = useAnimatedStyle(() => {
    const dur = duration > 0 ? duration : 1;
    const ratio = Math.min(1, Math.max(0, currentTimeSV.value / dur));
    return { width: `${ratio * 100}%` };
  }, [duration]);

  const handlePlayPause = useCallback(() => {
    if (phase === 'idle' || phase === 'error') {
      // First tap (or retry after error): fetch fresh URLs, then load + play.
      setPhase('fetching');
      setErrorCode(null);
      pendingPlayRef.current = true;
      urlRefetchUsedRef.current = false;
      recordingsApi
        .getPlaybackUrl(recordingId)
        .then((result) => {
          if (!mountedRef.current) return;
          setSegmentUrls(result.segmentUrls);
          setActiveSegment(0);
          return loadSegment(result.segmentUrls, 0);
        })
        .catch((error) => {
          failPlayback(error instanceof ApiError ? (error.code ?? `http_${error.status}`) : 'url_fetch_failed');
        });
      return;
    }
    if (phase !== 'ready') return;
    if (!isPlaying && !startedEmittedRef.current) {
      startedEmittedRef.current = true;
      trackEvent({ name: 'audio_playback_started', props: { recording_id: recordingId } });
    }
    playback.toggle();
  }, [phase, isPlaying, playback, recordingId, loadSegment, failPlayback]);

  const handleSeek = useCallback(
    (deltaSeconds: number) => {
      if (phase !== 'ready') return;
      playback.seekTo((currentTimeRef.current ?? 0) + deltaSeconds).catch(() => {});
    },
    [phase, playback, currentTimeRef]
  );

  const handleSelectSegment = useCallback(
    (index: number) => {
      if (index === activeSegment || segmentUrls.length === 0) return;
      playback.pause();
      setActiveSegment(index);
      pendingPlayRef.current = false;
      loadSegment(segmentUrls, index).catch(() => failPlayback('segment_load_failed'));
    },
    [activeSegment, segmentUrls, playback, loadSegment, failPlayback]
  );

  const isBusy = phase === 'fetching' || phase === 'loading' || (phase === 'ready' && isBuffering);
  const errorMessage =
    errorCode === 'PLAYBACK_FORBIDDEN' ? AUDIO_PLAYER_COPY.forbidden : AUDIO_PLAYER_COPY.unavailable;
  const canRetry = errorCode !== 'PLAYBACK_FORBIDDEN';

  return (
    <Card className="mx-5 mb-4">
      <Text className="text-body-lg font-semibold text-content-primary mb-3">
        {AUDIO_PLAYER_COPY.title}
      </Text>

      {phase === 'error' ? (
        <View className="flex-row items-center mb-1">
          {/* flex-1 so the message wraps instead of clipping (Android Text-in-flex-row gotcha) */}
          <Text className="flex-1 text-body-sm text-content-tertiary">
            {errorMessage}
          </Text>
          {canRetry && (
            <Pressable
              onPress={handlePlayPause}
              accessibilityRole="button"
              accessibilityLabel="Retry loading audio"
              className="px-3 py-2 rounded border border-border-strong"
              style={{ minHeight: 44, justifyContent: 'center', flexShrink: 0 }}
            >
              {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
              <Text
                className="text-caption text-content-secondary"
                allowFontScaling={false}
                style={{ flexShrink: 0, paddingRight: 2 }}
              >
                {`${AUDIO_PLAYER_COPY.retry} `}
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        <>
          <View className="flex-row items-center">
            <Pressable
              onPress={() => handleSeek(-SEEK_STEP_SECONDS)}
              disabled={phase !== 'ready'}
              accessibilityRole="button"
              accessibilityLabel="Rewind 15 seconds"
              className="w-11 h-11 items-center justify-center"
              style={{ opacity: phase === 'ready' ? 1 : 0.35 }}
            >
              <RotateCcw size={20} color={colors.contentSecondary} />
            </Pressable>

            <Pressable
              onPress={handlePlayPause}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? 'Pause audio' : 'Play audio'}
              className="w-14 h-14 rounded-full bg-brand-500 items-center justify-center mx-2"
              style={{ opacity: isBusy ? 0.7 : 1 }}
            >
              {isBusy ? (
                <ActivityIndicator color={colors.contentOnBrand} size="small" />
              ) : isPlaying ? (
                <Pause size={24} color={colors.contentOnBrand} fill={colors.contentOnBrand} />
              ) : (
                <Play size={24} color={colors.contentOnBrand} fill={colors.contentOnBrand} style={{ marginLeft: 2 }} />
              )}
            </Pressable>

            <Pressable
              onPress={() => handleSeek(SEEK_STEP_SECONDS)}
              disabled={phase !== 'ready'}
              accessibilityRole="button"
              accessibilityLabel="Skip ahead 15 seconds"
              className="w-11 h-11 items-center justify-center"
              style={{ opacity: phase === 'ready' ? 1 : 0.35 }}
            >
              <RotateCw size={20} color={colors.contentSecondary} />
            </Pressable>

            <View className="flex-1 ml-3">
              <View className="h-1.5 rounded-pill bg-surface-sunken overflow-hidden">
                <Animated.View className="h-full rounded-pill bg-brand-500" style={progressStyle} />
              </View>
              <View className="flex-row justify-between mt-1">
                {/* Trailing space + flexShrink:0 — Android under-measures short time labels and clips the last glyph; do NOT remove. */}
                <Text
                  className="text-caption text-content-tertiary"
                  style={{ flexShrink: 0, paddingRight: 2 }}
                >
                  {`${formatTime(displayTime)} `}
                </Text>
                {/* Trailing space + flexShrink:0 — Android under-measures short time labels and clips the last glyph; do NOT remove. */}
                <Text
                  className="text-caption text-content-tertiary"
                  style={{ flexShrink: 0, paddingRight: 2 }}
                >
                  {`${duration > 0 ? formatTime(duration) : '--:--'} `}
                </Text>
              </View>
            </View>
          </View>

          {segmentUrls.length > 1 && (
            <View className="flex-row flex-wrap mt-3 gap-2">
              {segmentUrls.map((_, i) => (
                <Pressable
                  key={i}
                  onPress={() => handleSelectSegment(i)}
                  accessibilityRole="button"
                  accessibilityLabel={`Play part ${i + 1}`}
                  className={`px-3 py-1.5 rounded-pill border ${
                    i === activeSegment ? 'bg-surface-sunken border-brand-500' : 'border-border-strong'
                  }`}
                  style={{ minHeight: 32 }}
                >
                  <Text
                    className={`text-caption ${
                      i === activeSegment ? 'text-brand-600 font-semibold' : 'text-content-secondary'
                    }`}
                  >
                    {AUDIO_PLAYER_COPY.part(i + 1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}
    </Card>
  );
}

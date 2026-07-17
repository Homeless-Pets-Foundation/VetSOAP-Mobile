import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
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

const SEEK_BAR_TOUCH_HEIGHT = 44;
const SEEK_BAR_TRACK_HEIGHT = 6;
const SEEK_BAR_THUMB_SIZE = 16;
const SCRUB_LABEL_THROTTLE_MS = 100;

interface SeekBarProps {
  currentTimeSV: SharedValue<number>;
  duration: number;
  displayTime: number;
  enabled: boolean;
  // Pan-scrub lifecycle: start pauses live playback, end commits the seek and
  // resumes after it settles, cancel resumes without seeking (gesture aborted).
  onScrubStart: () => void;
  onScrubEnd: (seconds: number) => void;
  onScrubCancel: () => void;
  // Direct seek with no pause/resume dance — used by tap and the a11y
  // increment/decrement actions (playback, if any, just continues).
  onSeekTo: (seconds: number) => void;
}

/**
 * Interactive timeline: tap anywhere or drag the thumb to scrub. Fill + thumb
 * are driven entirely on the UI thread (worklets) so the playhead slides at
 * 60 Hz with zero JS cost; only the mm:ss label hops to JS, throttled by
 * wall-clock so a fast drag can't spam React re-renders.
 *
 * While dragging, fill/thumb follow the finger (scrubProgressSV) instead of
 * currentTimeSV so live playback can't fight the drag. The pan pauses playback
 * on start and the parent resumes once the seek lands (or on cancel). The pan
 * uses an activeOffsetX so a vertical drag falls through to the surrounding
 * ScrollView; a separate Tap handles tap-to-seek.
 */
function SeekBar({
  currentTimeSV,
  duration,
  displayTime,
  enabled,
  onScrubStart,
  onScrubEnd,
  onScrubCancel,
  onSeekTo,
}: SeekBarProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [scrubLabel, setScrubLabel] = useState<number | null>(null);

  const trackWidthSV = useSharedValue(0);
  const durationSV = useSharedValue(duration);
  const scrubbingSV = useSharedValue(false);
  const scrubProgressSV = useSharedValue(0);
  const scrubStartedSV = useSharedValue(false);
  const committedSV = useSharedValue(false);
  const lastLabelMsSV = useSharedValue(0);

  useEffect(() => {
    trackWidthSV.value = trackWidth;
  }, [trackWidth, trackWidthSV]);
  useEffect(() => {
    durationSV.value = duration;
  }, [duration, durationSV]);

  // 0..1 progress: scrub position while dragging, else live playback position.
  // Inlined (not a shared helper) in each animated style: Reanimated only tracks
  // shared-value reads in the *direct* worklet body, so reading currentTimeSV via
  // a nested function would freeze the style at its first value (the playhead
  // wouldn't move during playback).
  const fillStyle = useAnimatedStyle(() => {
    const dur = durationSV.value > 0 ? durationSV.value : 1;
    const ratio = scrubbingSV.value
      ? scrubProgressSV.value
      : Math.min(1, Math.max(0, currentTimeSV.value / dur));
    return { width: `${ratio * 100}%` };
  });

  const thumbStyle = useAnimatedStyle(() => {
    const dur = durationSV.value > 0 ? durationSV.value : 1;
    const ratio = scrubbingSV.value
      ? scrubProgressSV.value
      : Math.min(1, Math.max(0, currentTimeSV.value / dur));
    return { left: ratio * trackWidthSV.value - SEEK_BAR_THUMB_SIZE / 2 };
  });

  // Pan = drag-to-scrub. activeOffsetX gates activation on horizontal travel so a
  // vertical drag that starts on the bar fails the pan and scrolls the page
  // instead. Pause/scrub-state begins in onStart (post-activation), never onBegin,
  // so a vertical scroll-through never pauses playback.
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-10, 10])
    .failOffsetY([-12, 12])
    .onStart((e) => {
      'worklet';
      const cw = trackWidthSV.value;
      if (cw <= 0) return;
      scrubbingSV.value = true;
      scrubStartedSV.value = true;
      committedSV.value = false;
      scrubProgressSV.value = Math.min(1, Math.max(0, e.x / cw));
      lastLabelMsSV.value = 0;
      runOnJS(onScrubStart)();
    })
    .onUpdate((e) => {
      'worklet';
      const cw = trackWidthSV.value;
      if (cw <= 0) return;
      const ratio = Math.min(1, Math.max(0, e.x / cw));
      scrubProgressSV.value = ratio;
      // Throttle the JS label hop by wall-clock (not by whole-second, which a fast
      // drag crosses every frame) so the scrub stays UI-thread-only.
      const now = Date.now();
      if (now - lastLabelMsSV.value >= SCRUB_LABEL_THROTTLE_MS) {
        lastLabelMsSV.value = now;
        runOnJS(setScrubLabel)(ratio * durationSV.value);
      }
    })
    .onEnd(() => {
      'worklet';
      const seconds = scrubProgressSV.value * durationSV.value;
      committedSV.value = true;
      // Pin the live playhead to the target now (UI thread) so when scrubbingSV
      // flips false in onFinalize the fill stays put — the async seekTo (parent)
      // writes the same value a few ms later, but this kills the 1-frame snap-back.
      currentTimeSV.value = seconds;
      runOnJS(onScrubEnd)(seconds);
    })
    .onFinalize(() => {
      'worklet';
      // onFinalize also fires for pans that fail before onStart (e.g. a vertical
      // scroll beginning over the bar). Only resume on cancel when THIS gesture
      // actually started — i.e. onStart ran and paused playback — and never
      // committed; otherwise merely scrolling over the bar could resume audio the
      // user had paused. Reset both flags so stale state can't leak to the next.
      scrubbingSV.value = false;
      runOnJS(setScrubLabel)(null);
      if (scrubStartedSV.value && !committedSV.value) runOnJS(onScrubCancel)();
      scrubStartedSV.value = false;
      committedSV.value = false;
    });

  // Tap = tap-to-seek. Separate from pan so the pan can require horizontal travel
  // (above) without losing the tap affordance.
  const tap = Gesture.Tap()
    .enabled(enabled)
    .maxDuration(300)
    // Cancel the tap on any finger travel so a short vertical scroll that starts
    // on the 44pt target (and trips the pan's failOffsetY) isn't reported as a
    // tap-to-seek and jump playback while the user meant to scroll the page.
    .maxDistance(10)
    .onEnd((e, success) => {
      'worklet';
      if (!success) return;
      const cw = trackWidthSV.value;
      if (cw <= 0) return;
      const seconds = Math.min(1, Math.max(0, e.x / cw)) * durationSV.value;
      currentTimeSV.value = seconds;
      runOnJS(onSeekTo)(seconds);
    });

  const gesture = Gesture.Exclusive(pan, tap);

  const leftLabel = scrubLabel ?? displayTime;

  // A11y: expose increment/decrement so screen-reader users get a working
  // adjustable control (swipe up/down seeks by the same 15s step as the buttons).
  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (!enabled) return;
      const delta = event.nativeEvent.actionName === 'increment' ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      const target = Math.min(duration, Math.max(0, displayTime + delta));
      onSeekTo(target);
    },
    [duration, displayTime, enabled, onSeekTo]
  );

  return (
    <View className="flex-1 ml-3">
      <GestureDetector gesture={gesture}>
        {/* Tall transparent hit area (44pt) wraps the thin visible track so the
            timeline is easy to grab; the track is vertically centered in it. */}
        <View
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel="Playback position"
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={handleAccessibilityAction}
          accessibilityValue={{
            min: 0,
            max: duration > 0 ? Math.floor(duration) : 0,
            now: Math.floor(Math.min(leftLabel, duration > 0 ? duration : leftLabel)),
          }}
          style={{ height: SEEK_BAR_TOUCH_HEIGHT, justifyContent: 'center' }}
        >
          <View
            className="rounded-pill bg-surface-sunken overflow-hidden"
            style={{ height: SEEK_BAR_TRACK_HEIGHT }}
          >
            <Animated.View className="h-full rounded-pill bg-brand-500" style={fillStyle} />
          </View>
          {enabled && trackWidth > 0 && (
            <Animated.View
              pointerEvents="none"
              className="rounded-full bg-brand-500"
              style={[
                {
                  position: 'absolute',
                  width: SEEK_BAR_THUMB_SIZE,
                  height: SEEK_BAR_THUMB_SIZE,
                },
                thumbStyle,
              ]}
            />
          )}
        </View>
      </GestureDetector>
      <View className="flex-row justify-between mt-1">
        {/* Trailing space + flexShrink:0 — Android under-measures short time labels and clips the last glyph; do NOT remove. */}
        <Text
          className="text-caption text-content-tertiary"
          style={{ flexShrink: 0, paddingRight: 2 }}
        >
          {`${formatTime(leftLabel)} `}
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
  );
}

interface RecordingAudioPlayerProps {
  recordingId: string;
  initialDurationSeconds?: number | null;
}

/**
 * Streams a recording's audio from R2 via short-lived presigned URLs
 * (`recordingsApi.getPlaybackUrl`). URLs are fetched lazily on the first Play
 * tap — not on mount — so opening a detail screen never issues (and audits)
 * a playback URL the vet doesn't use. On a load failure the URL is re-fetched
 * once (it may simply have expired), then degrades to an inline
 * "Audio unavailable" — never an Alert loop.
 */
export function RecordingAudioPlayer({
  recordingId,
  initialDurationSeconds,
}: RecordingAudioPlayerProps) {
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

  return (
    <ActiveAudioPlayer
      recordingId={recordingId}
      initialDurationSeconds={initialDurationSeconds}
    />
  );
}

function ActiveAudioPlayer({
  recordingId,
  initialDurationSeconds,
}: {
  recordingId: string;
  initialDurationSeconds?: number | null;
}) {
  const colors = useThemeColors();
  const playback = useAudioPlayback();
  const { isLoaded, isPlaying, duration, isBuffering, currentTimeSV, currentTimeRef, playbackRate, setPlaybackRate } = playback;
  const sanitizedInitialDuration =
    typeof initialDurationSeconds === 'number' &&
    Number.isFinite(initialDurationSeconds) &&
    initialDurationSeconds > 0
      ? initialDurationSeconds
      : 0;
  const displayDuration = duration > 0 ? duration : sanitizedInitialDuration;

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

  // Scrub: pause while the finger is down so live playback doesn't race the
  // drag, seek to the released position, then resume only if it was playing.
  const wasPlayingBeforeScrubRef = useRef(false);
  const handleScrubStart = useCallback(() => {
    wasPlayingBeforeScrubRef.current = isPlaying;
    if (isPlaying) playback.pause();
  }, [isPlaying, playback]);

  const handleScrubEnd = useCallback(
    (seconds: number) => {
      // Update the label immediately: when the recording is paused, isPlaying
      // never changes across a scrub, so the displayTime effect won't re-run —
      // without this the label would snap back to the pre-scrub time.
      setDisplayTime(seconds);
      // Resume ONLY after the seek lands. Resuming before seekTo settles can
      // replay from the pre-scrub position / emit stale status ticks (P2).
      playback
        .seekTo(seconds)
        .catch(() => {})
        .finally(() => {
          if (!wasPlayingBeforeScrubRef.current) return;
          // Don't resume when scrubbed to (or within 50ms of) the end: play()
          // treats currentTime >= dur - 0.05 as EOF and rewinds to 0, which would
          // restart the recording instead of leaving it parked at the end (P2).
          if (duration > 0 && seconds >= duration - 0.05) return;
          playback.play();
        });
    },
    [playback, duration]
  );

  // Pan cancelled before release (system interruption, backgrounding): no seek
  // happened, but onScrubStart already paused — resume so audio isn't stuck.
  const handleScrubCancel = useCallback(() => {
    if (wasPlayingBeforeScrubRef.current) playback.play();
  }, [playback]);

  // Tap / a11y seek: no pause happened, so just seek; playback (if any) continues.
  const handleSeekTo = useCallback(
    (seconds: number) => {
      setDisplayTime(seconds);
      playback.seekTo(seconds).catch(() => {});
    },
    [playback]
  );

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
      if (phase !== 'ready' || duration <= 0) return;
      const target = Math.min(duration, Math.max(0, (currentTimeRef.current ?? 0) + deltaSeconds));
      setDisplayTime(target);
      currentTimeSV.value = target;
      currentTimeRef.current = target;
      playback.seekTo(target).catch(() => {});
    },
    [phase, duration, playback, currentTimeRef, currentTimeSV]
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
  const canSeek = phase === 'ready' && duration > 0;
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
              disabled={!canSeek}
              accessibilityRole="button"
              accessibilityLabel="Rewind 15 seconds"
              className="w-11 h-11 items-center justify-center"
              style={{ opacity: canSeek ? 1 : 0.35 }}
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
              disabled={!canSeek}
              accessibilityRole="button"
              accessibilityLabel="Skip ahead 15 seconds"
              className="w-11 h-11 items-center justify-center"
              style={{ opacity: canSeek ? 1 : 0.35 }}
            >
              <RotateCw size={20} color={colors.contentSecondary} />
            </Pressable>

            <SeekBar
              currentTimeSV={currentTimeSV}
              duration={displayDuration}
              displayTime={displayTime}
              enabled={canSeek}
              onScrubStart={handleScrubStart}
              onScrubEnd={handleScrubEnd}
              onScrubCancel={handleScrubCancel}
              onSeekTo={handleSeekTo}
            />

            <Pressable
              onPress={() => {
                // Cycle 1x -> 1.25x -> 1.5x -> 2x -> 1x. Reviewing a full
                // consult at speed is the player's primary use.
                const rates = [1, 1.25, 1.5, 2];
                const next = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
                setPlaybackRate(next);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Playback speed, ${playbackRate}x. Tap to change.`}
              className={`ml-2 px-2 items-center justify-center rounded-pill border ${
                playbackRate !== 1 ? 'bg-surface-sunken border-brand-500' : 'border-border-strong'
              }`}
              style={{ minHeight: 44, minWidth: 44 }}
            >
              <Text
                className={`text-caption font-semibold ${
                  playbackRate !== 1 ? 'text-brand-600' : 'text-content-secondary'
                }`}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {AUDIO_PLAYER_COPY.speed(playbackRate)}
              </Text>
            </Pressable>
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
                  style={{ minHeight: 44, justifyContent: 'center' }}
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

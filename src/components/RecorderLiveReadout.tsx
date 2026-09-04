import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSharedValue, withTiming, cancelAnimation, Easing } from 'react-native-reanimated';
import { Text } from './ui/Text';
import { AudioWaveform } from './AudioWaveform';
import { normalizeMeteringDb } from '../lib/metering';
import {
  LONG_RECORDING_WARNING_COPY,
  LONG_RECORDING_WARNING_THRESHOLD_SEC,
} from '../constants/strings';
import { formatClockDuration } from '../lib/formatClock';

const styles = StyleSheet.create({
  timerText: {
    alignSelf: 'stretch',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0,
    includeFontPadding: false,
  },
});

/** Poll cadence for the live readout (4 Hz metering, timer changes once/s). */
const LIVE_TICK_MS = 250;

interface RecorderLiveReadoutProps {
  /** Stable getter from useAudioRecorder — reads refs/native, no React state. */
  getLiveStats: () => { meteringDb: number; durationSeconds: number };
  /** recording || paused — the leaf polls only while true. */
  isLive: boolean;
  isRecording: boolean;
  isPaused: boolean;
  /** Sum of the slot's previously captured segments. */
  baseDurationSeconds: number;
  /** recorder.duration — frozen-at-transition value shown when not live. */
  fallbackDurationSeconds: number;
}

/**
 * Waveform + timer + long-recording warning for the recorder-owner card.
 *
 * This leaf polls the recorder itself (via getLiveStats) so the live ticks
 * re-render ~this component only~ instead of the 7,000-line record screen.
 * Metering goes straight into a Reanimated SharedValue (one JS→UI message per
 * tick, no React commit); only the once-per-second timer text is React state,
 * and that commit stops at the memoized AudioWaveform. Keep it dumb: no
 * recorder control, no slot state — display only.
 */
export function RecorderLiveReadout({
  getLiveStats,
  isLive,
  isRecording,
  isPaused,
  baseDurationSeconds,
  fallbackDurationSeconds,
}: RecorderLiveReadoutProps) {
  const level = useSharedValue(0);
  const [durationSeconds, setDurationSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!isLive) {
      cancelAnimation(level);
      level.value = withTiming(0, { duration: 400 });
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const next = getLiveStats();
      if (!isPaused) {
        level.value = withTiming(normalizeMeteringDb(next.meteringDb), {
          duration: 150,
          easing: Easing.out(Easing.ease),
        });
      }
      // Functional update with a bail-out: the timer changes once per second,
      // so most ticks commit nothing.
      setDurationSeconds((prev) => (prev === next.durationSeconds ? prev : next.durationSeconds));
    };
    tick();
    if (isPaused) {
      // Paused: the clock is frozen and the bars hold their last level — one
      // sync is enough, no interval.
      cancelAnimation(level);
      return () => { cancelled = true; };
    }
    const interval = setInterval(tick, LIVE_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- level is a stable SharedValue ref
  }, [isLive, isPaused, getLiveStats]);

  // No haptic "heartbeat" during capture: a periodic motor buzz on a device
  // using the built-in mic (or resting on the same surface) bleeds into the
  // appointment audio and degrades transcription/SOAP. Not worth the
  // "feels alive" cue — the live waveform + timer already convey that.

  const liveSeconds = isLive ? durationSeconds : fallbackDurationSeconds;
  const totalSeconds = baseDurationSeconds + liveSeconds;

  return (
    <>
      <AudioWaveform isActive={isLive} isPaused={isPaused} level={level} />
      <Text
        className={`text-timer font-bold mb-5 ${
          isRecording ? 'text-brand-500 shadow-glow' : 'text-content-primary'
        }`}
        style={styles.timerText}
      >
        {formatClockDuration(totalSeconds)}
      </Text>
      {/* Non-blocking warning for multi-hour recordings. Peak extraction scales
          with FFmpeg seek cost on the edit path, which is slow on low-end
          Android (A7 Lite, MediaTek P22T). No cap — staff sometimes
          legitimately need long sessions. Lives here (not the parent card) so
          it appears DURING a long live recording, not only after a transition. */}
      {totalSeconds >= LONG_RECORDING_WARNING_THRESHOLD_SEC && (
        <View
          className="rounded-lg bg-status-warning border border-status-warning px-3 py-2 mb-4 self-stretch"
          accessibilityRole="alert"
        >
          <Text className="text-caption text-status-warning text-center">
            {LONG_RECORDING_WARNING_COPY.body}
          </Text>
        </View>
      )}
    </>
  );
}

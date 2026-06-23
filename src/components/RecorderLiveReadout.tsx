import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AudioWaveform } from './AudioWaveform';
import {
  LONG_RECORDING_WARNING_COPY,
  LONG_RECORDING_WARNING_THRESHOLD_SEC,
} from '../constants/strings';

const styles = StyleSheet.create({
  timerText: {
    alignSelf: 'stretch',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0,
    includeFontPadding: false,
  },
});

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

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
 * This leaf polls the recorder itself (via getLiveStats) so the 500ms
 * metering/duration ticks re-render ~this component only~ instead of the
 * 3,000+ line record screen. Keep it dumb: no recorder control, no slot
 * state — display only.
 */
export function RecorderLiveReadout({
  getLiveStats,
  isLive,
  isRecording,
  isPaused,
  baseDurationSeconds,
  fallbackDurationSeconds,
}: RecorderLiveReadoutProps) {
  const [stats, setStats] = React.useState<{ meteringDb: number; durationSeconds: number }>(
    () => ({ meteringDb: -160, durationSeconds: 0 })
  );

  React.useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const next = getLiveStats();
      // Functional update with a bail-out: most 250ms ticks change nothing
      // (metering samples land every 500ms, the timer once per second).
      setStats((prev) =>
        prev.meteringDb === next.meteringDb && prev.durationSeconds === next.durationSeconds
          ? prev
          : next
      );
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isLive, getLiveStats]);

  // No haptic "heartbeat" during capture: a periodic motor buzz on a device
  // using the built-in mic (or resting on the same surface) bleeds into the
  // appointment audio and degrades transcription/SOAP. Not worth the
  // "feels alive" cue — the live waveform + timer already convey that.

  const liveSeconds = isLive ? stats.durationSeconds : fallbackDurationSeconds;
  const totalSeconds = baseDurationSeconds + liveSeconds;

  return (
    <>
      <AudioWaveform
        isActive={isLive}
        isPaused={isPaused}
        metering={isLive ? stats.meteringDb : -160}
      />
      <Text
        className={`text-timer font-bold mb-5 ${
          isRecording ? 'text-brand-500 shadow-glow' : 'text-content-primary'
        }`}
        style={styles.timerText}
      >
        {formatDuration(totalSeconds)}
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

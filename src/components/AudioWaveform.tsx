import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useResponsive } from '../hooks/useResponsive';

const MIN_HEIGHT = 4;
const METERING_MIN = -60;
const METERING_MAX = 0;

interface AudioWaveformProps {
  isActive: boolean;
  isPaused?: boolean;
  metering?: number;
}

interface WaveBarProps {
  index: number;
  barCount: number;
  isActive: boolean;
  isPaused?: boolean;
  barWidth: number;
  barGap: number;
  maxHeight: number;
  targetHeight: number;
  jitter: number;
}

const WaveBar = React.memo(function WaveBar({ index, barCount, isActive, isPaused, barWidth, barGap, maxHeight, targetHeight, jitter }: WaveBarProps) {
  const height = useSharedValue(MIN_HEIGHT);

  useEffect(() => {
    if (isActive && !isPaused) {
      // Add per-bar variation: bars near center are taller, edges shorter
      const center = barCount / 2;
      const distFromCenter = Math.abs(index - center) / center;
      const variation = 1 - distFromCenter * 0.4;
      const finalHeight = Math.max(MIN_HEIGHT, targetHeight * variation * jitter);

      height.value = withTiming(finalHeight, {
        duration: 150,
        easing: Easing.out(Easing.ease),
      });
    } else if (isPaused) {
      cancelAnimation(height);
    } else {
      height.value = withTiming(MIN_HEIGHT, { duration: 400 });
    }
    return () => { cancelAnimation(height); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- height is a stable Reanimated SharedValue ref; barCount/index/jitter are stable per-bar props
  }, [isActive, isPaused, targetHeight, maxHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return (
    <Animated.View
      className={`rounded-full ${isActive ? 'bg-brand-500' : 'bg-border-strong'}`}
      style={[{ width: barWidth, marginHorizontal: barGap / 2 }, animatedStyle]}
    />
  );
});

/**
 * Slow breathing ring behind the bars — telegraphs "alive / capturing". Only
 * animates while the recorder is live (isActive && !isPaused); otherwise it
 * stays invisible. brand-tinted via bg-brand-500 at low opacity so it reads in
 * both light + dark and respects the dark-mode color guard.
 */
function BreathingRing({ active }: { active: boolean }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (active) {
      progress.value = withRepeat(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    } else {
      cancelAnimation(progress);
      progress.value = withTiming(0, { duration: 300 });
    }
    return () => { cancelAnimation(progress); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- progress is a stable SharedValue ref
  }, [active]);

  const style = useAnimatedStyle(() => ({
    // Opacity floors at 0 (progress=0 when idle) so the ring is fully invisible
    // until recording — no stray ghost behind the resting bars.
    opacity: progress.value * 0.18,
    // Fills the box (left:0/right:0 → symmetric, so it stays centered) and
    // breathes via scale. scaleX<1 keeps it a centered pill behind the bars.
    transform: [{ scaleX: 0.5 + progress.value * 0.08 }, { scaleY: 0.85 + progress.value * 0.15 }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      className="absolute rounded-full bg-brand-500"
      style={[{ left: 0, right: 0, top: 0, bottom: 0 }, style]}
    />
  );
}

export function AudioWaveform({ isActive, isPaused, metering = -160 }: AudioWaveformProps) {
  const { isTablet: isWide } = useResponsive();
  const barCount = isWide ? 36 : 24;
  const barWidth = isWide ? 4 : 3;
  const barGap = isWide ? 3 : 2;
  // Hero sizing: bars fill a much taller stage (≈120px tablet / 80px phone)
  // so the recording state reads as the app's energetic peak, not a footnote.
  const maxHeight = isWide ? 104 : 68;
  const containerHeight = isWide ? 120 : 80;

  // Pre-calculate per-bar jitter once (deterministic across renders)
  const jitterValues = useMemo(
    () => Array.from({ length: barCount }, () => 0.85 + Math.random() * 0.3),
    [barCount]
  );

  // Normalize metering from dB range to pixel height
  const clamped = Math.max(METERING_MIN, Math.min(METERING_MAX, metering));
  const normalized = (clamped - METERING_MIN) / (METERING_MAX - METERING_MIN);
  const targetHeight = MIN_HEIGHT + normalized * (maxHeight - MIN_HEIGHT);

  const live = isActive && !isPaused;

  return (
    <View
      className={`flex-row items-center justify-center my-3 rounded-card ${live ? 'shadow-glow' : ''}`}
      style={{ height: containerHeight }}
      accessibilityLabel="Audio recording waveform"
      accessibilityRole="image"
    >
      <BreathingRing active={live} />
      {Array.from({ length: barCount }).map((_, i) => (
        <WaveBar
          key={`wave-bar-${i}`}
          index={i}
          barCount={barCount}
          isActive={isActive}
          isPaused={isPaused}
          barWidth={barWidth}
          barGap={barGap}
          maxHeight={maxHeight}
          targetHeight={targetHeight}
          jitter={jitterValues[i]}
        />
      ))}
    </View>
  );
}

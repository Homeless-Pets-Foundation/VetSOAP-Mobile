import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
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
      className={`rounded-full ${isActive ? 'bg-brand-500' : 'bg-stone-300'}`}
      style={[{ width: barWidth, marginHorizontal: barGap / 2 }, animatedStyle]}
    />
  );
});

export function AudioWaveform({ isActive, isPaused, metering = -160 }: AudioWaveformProps) {
  const { isTablet: isWide } = useResponsive();
  const barCount = isWide ? 36 : 24;
  const barWidth = isWide ? 4 : 3;
  const barGap = isWide ? 3 : 2;
  const maxHeight = isWide ? 48 : 32;

  // Pre-calculate per-bar jitter once (deterministic across renders)
  const jitterValues = useMemo(
    () => Array.from({ length: barCount }, () => 0.85 + Math.random() * 0.3),
    [barCount]
  );

  // Normalize metering from dB range to pixel height
  const clamped = Math.max(METERING_MIN, Math.min(METERING_MAX, metering));
  const normalized = (clamped - METERING_MIN) / (METERING_MAX - METERING_MIN);
  const targetHeight = MIN_HEIGHT + normalized * (maxHeight - MIN_HEIGHT);

  return (
    <View
      className="flex-row items-center justify-center my-3"
      style={{ height: isWide ? 56 : 40 }}
      accessibilityLabel="Audio recording waveform"
      accessibilityRole="image"
    >
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

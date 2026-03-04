import React, { useEffect } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

const MIN_HEIGHT = 4;
const TABLET_BREAKPOINT = 600;

interface AudioWaveformProps {
  isActive: boolean;
  isPaused?: boolean;
}

interface WaveBarProps {
  index: number;
  isActive: boolean;
  isPaused?: boolean;
  barWidth: number;
  barGap: number;
  maxHeight: number;
}

function WaveBar({ index, isActive, isPaused, barWidth, barGap, maxHeight }: WaveBarProps) {
  const height = useSharedValue(MIN_HEIGHT);

  useEffect(() => {
    if (isActive && !isPaused) {
      const randomMax = MIN_HEIGHT + Math.random() * (maxHeight - MIN_HEIGHT);
      const duration = 300 + Math.random() * 400;

      height.value = withDelay(
        index * 30,
        withRepeat(
          withTiming(randomMax, { duration, easing: Easing.inOut(Easing.ease) }),
          -1,
          true
        )
      );
    } else if (isPaused) {
      // Freeze at current value — no-op, just stop animating
      cancelAnimation(height);
    } else {
      height.value = withTiming(MIN_HEIGHT, { duration: 400 });
    }
    return () => { cancelAnimation(height); };
  }, [isActive, isPaused, maxHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return (
    <Animated.View
      className={`rounded-full ${isActive ? 'bg-brand-500' : 'bg-stone-300'}`}
      style={[{ width: barWidth, marginHorizontal: barGap / 2 }, animatedStyle]}
    />
  );
}

export function AudioWaveform({ isActive, isPaused }: AudioWaveformProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= TABLET_BREAKPOINT;
  const barCount = isWide ? 36 : 24;
  const barWidth = isWide ? 4 : 3;
  const barGap = isWide ? 3 : 2;
  const maxHeight = isWide ? 48 : 32;

  return (
    <View
      className="flex-row items-center justify-center my-3"
      style={{ height: isWide ? 56 : 40 }}
    >
      {Array.from({ length: barCount }).map((_, i) => (
        <WaveBar
          key={i}
          index={i}
          isActive={isActive}
          isPaused={isPaused}
          barWidth={barWidth}
          barGap={barGap}
          maxHeight={maxHeight}
        />
      ))}
    </View>
  );
}

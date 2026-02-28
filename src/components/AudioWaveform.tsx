import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

const BAR_COUNT = 24;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MAX_HEIGHT = 32;
const MIN_HEIGHT = 4;

interface AudioWaveformProps {
  isActive: boolean;
  isPaused?: boolean;
}

function WaveBar({ index, isActive, isPaused }: { index: number; isActive: boolean; isPaused?: boolean }) {
  const height = useSharedValue(MIN_HEIGHT);

  useEffect(() => {
    if (isActive && !isPaused) {
      const randomMax = MIN_HEIGHT + Math.random() * (MAX_HEIGHT - MIN_HEIGHT);
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
  }, [isActive, isPaused]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return (
    <Animated.View
      className={`rounded-full ${isActive ? 'bg-brand-500' : 'bg-stone-300'}`}
      style={[{ width: BAR_WIDTH, marginHorizontal: BAR_GAP / 2 }, animatedStyle]}
    />
  );
}

export function AudioWaveform({ isActive, isPaused }: AudioWaveformProps) {
  return (
    <View className="flex-row items-center justify-center h-10 my-3">
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <WaveBar key={i} index={i} isActive={isActive} isPaused={isPaused} />
      ))}
    </View>
  );
}

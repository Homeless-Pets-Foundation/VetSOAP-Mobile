import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  className?: string;
}

export function Skeleton({
  width,
  height = 16,
  borderRadius = 8,
  className = '',
}: SkeletonProps) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.7, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className={`bg-stone-200 ${className}`}
      style={[
        {
          width: width as any,
          height,
          borderRadius,
        },
        animatedStyle,
      ]}
    />
  );
}

export function SkeletonText({
  lines = 3,
  lastLineWidth = '60%',
}: {
  lines?: number;
  lastLineWidth?: string;
}) {
  return (
    <View className="gap-2.5">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 ? (lastLineWidth as any) : '100%'}
          height={14}
        />
      ))}
    </View>
  );
}

export function SkeletonCard() {
  return (
    <View className="card mb-2">
      <View className="flex-row justify-between items-center">
        <View className="flex-1 mr-3">
          <Skeleton width="70%" height={18} className="mb-2" />
          <Skeleton width="50%" height={14} className="mb-1.5" />
          <Skeleton width="30%" height={12} />
        </View>
        <Skeleton width={72} height={24} borderRadius={12} />
      </View>
    </View>
  );
}

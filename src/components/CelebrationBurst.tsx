import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
  cancelAnimation,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { useThemeColors } from '../hooks/useThemeColors';

// Dep-free celebration: a one-shot radial burst of particles that fly outward
// and fade. ponytail: built with reanimated Animated.Views; swap in
// react-native-confetti-cannon only if a physics cannon is ever wanted.
// Colors pull from useThemeColors so the burst stays correct in dark mode and
// dodges the hardcoded-color guard (no inline hex color props).

const PARTICLE_COUNT = 14;
const DURATION = 900;

interface ParticleProps {
  angle: number;
  distance: number;
  size: number;
  color: string;
  progress: SharedValue<number>;
}

function Particle({ angle, distance, size, color, progress }: ParticleProps) {
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85,
      transform: [
        { translateX: dx * p },
        { translateY: dy * p },
        { scale: 1 - p * 0.4 },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
}

interface CelebrationBurstProps {
  /** Mount this component to fire the burst once. */
  onComplete?: () => void;
}

export function CelebrationBurst({ onComplete }: CelebrationBurstProps) {
  const colors = useThemeColors();
  const progress = useSharedValue(0);

  const palette = [colors.brand500, colors.brand600, colors.warning500, colors.success600];

  // Deterministic spread (no Math.random in render): even ring + per-index size.
  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    angle: (i / PARTICLE_COUNT) * Math.PI * 2,
    distance: 90 + (i % 3) * 28,
    size: 7 + (i % 4) * 2,
    color: palette[i % palette.length],
  }));

  useEffect(() => {
    progress.value = withDelay(
      30,
      withTiming(1, { duration: DURATION, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished && onComplete) runOnJS(onComplete)();
      })
    );
    return () => { cancelAnimation(progress); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- progress stable SharedValue ref; fire once on mount
  }, []);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} className="justify-center items-center">
      {/* 0-size anchor: centered by the parent, so the absolutely-positioned
          particles (which translate from their own 0,0) emanate from center. */}
      <View>
        {particles.map((p, i) => (
          <Particle key={`burst-${i}`} {...p} progress={progress} />
        ))}
      </View>
    </View>
  );
}

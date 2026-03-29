import React from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

interface TrimHandleProps {
  position: SharedValue<number>;
  otherPosition: SharedValue<number>;
  containerWidth: number;
  height: number;
  side: 'left' | 'right';
  minGapPx: number;
  timeSeconds: number;
  duration: number;
  onDragEnd?: () => void;
}

function triggerHaptic() {
  Haptics.selectionAsync().catch(() => {});
}

const HANDLE_WIDTH = 24;

export function TrimHandle({
  position,
  otherPosition,
  containerWidth,
  height,
  side,
  minGapPx,
  timeSeconds,
  duration,
  onDragEnd,
}: TrimHandleProps) {
  const HIT_SLOP = 20;
  const startPos = useSharedValue(0);

  const pan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      startPos.value = position.value;
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      'worklet';
      const newPos = startPos.value + event.translationX;
      // Clamp dynamically against the OTHER handle's current position
      if (side === 'left') {
        const max = otherPosition.value - minGapPx;
        position.value = Math.max(0, Math.min(newPos, max));
      } else {
        const min = otherPosition.value + minGapPx;
        position.value = Math.max(min, Math.min(newPos, containerWidth));
      }
    })
    .onEnd(() => {
      'worklet';
      if (onDragEnd) {
        runOnJS(onDragEnd)();
      }
    })
    .hitSlop({ left: HIT_SLOP, right: HIT_SLOP, top: 0, bottom: 0 })
    .minDistance(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          side === 'left'
            ? position.value - HANDLE_WIDTH
            : position.value,
      },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          styles.handle,
          {
            width: HANDLE_WIDTH,
            height,
          },
          animatedStyle,
        ]}
        accessibilityRole="adjustable"
        accessibilityLabel={`${side === 'left' ? 'Start' : 'End'} trim handle`}
        accessibilityHint={`Drag to adjust the ${side === 'left' ? 'start' : 'end'} of the trim region`}
        accessibilityValue={{
          min: 0,
          max: Math.round(duration),
          now: Math.round(timeSeconds),
          text: `${Math.floor(timeSeconds / 60)}:${String(Math.floor(timeSeconds % 60)).padStart(2, '0')}`,
        }}
      >
        {/* Grip indicator */}
        <Animated.View style={styles.grip}>
          <Animated.View style={styles.gripLine} />
          <Animated.View style={styles.gripLine} />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  handle: {
    position: 'absolute',
    top: 0,
    zIndex: 10,
    backgroundColor: '#0d8775',
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  grip: {
    gap: 3,
    alignItems: 'center',
  },
  gripLine: {
    width: 3,
    height: 12,
    backgroundColor: 'rgba(255, 255, 255, 1.0)',
    borderRadius: 1.5,
  },
});

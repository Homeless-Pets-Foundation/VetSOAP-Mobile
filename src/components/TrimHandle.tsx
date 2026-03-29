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
  /** Current position in seconds (shared value, mutated by drag) */
  positionSeconds: SharedValue<number>;
  /** Other handle's position in seconds (for clamping) */
  otherPositionSeconds: SharedValue<number>;
  /** Duration shared value (readable from worklet) */
  durationSV: SharedValue<number>;
  /** Container width shared value (readable from worklet) */
  containerWidthSV: SharedValue<number>;
  /** Container width for initial layout (plain number) */
  containerWidth: number;
  height: number;
  side: 'left' | 'right';
  /** Minimum gap between handles as fraction of duration */
  minGapFraction: number;
  timeSeconds: number;
  duration: number;
  onDragEnd?: () => void;
}

function triggerHaptic() {
  Haptics.selectionAsync().catch(() => {});
}

const HANDLE_WIDTH = 24;

export function TrimHandle({
  positionSeconds,
  otherPositionSeconds,
  durationSV,
  containerWidthSV,
  containerWidth,
  height,
  side,
  minGapFraction,
  timeSeconds,
  duration,
  onDragEnd,
}: TrimHandleProps) {
  const HIT_SLOP = 20;
  const dragStartSec = useSharedValue(0);

  const pan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      dragStartSec.value = positionSeconds.value;
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;

      // Convert pixel delta to seconds delta
      const deltaSec = (event.translationX / cw) * dur;
      const newSec = dragStartSec.value + deltaSec;
      const minGap = minGapFraction * dur;

      if (side === 'left') {
        const max = otherPositionSeconds.value - minGap;
        positionSeconds.value = Math.max(0, Math.min(newSec, max));
      } else {
        const min = otherPositionSeconds.value + minGap;
        positionSeconds.value = Math.max(min, Math.min(newSec, dur));
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

  // Convert seconds → pixels for the visual position
  const animatedStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const px = dur > 0 ? (positionSeconds.value / dur) * cw : 0;
    return {
      transform: [
        {
          translateX: side === 'left' ? px - HANDLE_WIDTH : px,
        },
      ],
    };
  });

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

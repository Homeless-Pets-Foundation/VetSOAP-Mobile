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

interface TrimOverlayProps {
  trimStartSV: SharedValue<number>;
  trimEndSV: SharedValue<number>;
  durationSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerWidth: number;
  height: number;
  duration: number;
  onTrimChange: (start: number, end: number) => void;
}

const HANDLE_WIDTH = 14;
const MIN_TRIM_GAP_SEC = 1;
const BORDER_THICKNESS = 3;

function triggerHaptic() {
  Haptics.selectionAsync().catch(() => {});
}

export function TrimOverlay({
  trimStartSV,
  trimEndSV,
  durationSV,
  containerWidthSV,
  containerWidth,
  height,
  duration,
  onTrimChange,
}: TrimOverlayProps) {
  // Which handle is being dragged: 0 = none, 1 = start, 2 = end
  const activeHandle = useSharedValue(0);

  const onTrimChangeRef = React.useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  function emitTrimChange(start: number, end: number) {
    onTrimChangeRef.current(start, end);
  }

  // --- Pan gesture: drag the nearest handle ---
  const pan = Gesture.Pan()
    .onStart((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;

      const touchSec = (event.x / cw) * dur;
      const distToStart = Math.abs(touchSec - trimStartSV.value);
      const distToEnd = Math.abs(touchSec - trimEndSV.value);

      activeHandle.value = distToStart <= distToEnd ? 1 : 2;
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0 || activeHandle.value === 0) return;

      const touchSec = (event.x / cw) * dur;

      if (activeHandle.value === 1) {
        // Dragging start handle
        const maxStart = trimEndSV.value - MIN_TRIM_GAP_SEC;
        trimStartSV.value = Math.max(0, Math.min(touchSec, maxStart));
      } else {
        // Dragging end handle
        const minEnd = trimStartSV.value + MIN_TRIM_GAP_SEC;
        trimEndSV.value = Math.max(minEnd, Math.min(touchSec, dur));
      }
    })
    .onEnd(() => {
      'worklet';
      activeHandle.value = 0;
      runOnJS(emitTrimChange)(trimStartSV.value, trimEndSV.value);
    })
    .activeOffsetX([-8, 8])
    .failOffsetY([-15, 15])
    .minPointers(1)
    .maxPointers(1);

  // --- Tap gesture: snap nearest handle to tap position ---
  const tap = Gesture.Tap()
    .onEnd((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;

      const touchSec = Math.max(0, Math.min((event.x / cw) * dur, dur));
      const distToStart = Math.abs(touchSec - trimStartSV.value);
      const distToEnd = Math.abs(touchSec - trimEndSV.value);

      if (distToStart <= distToEnd) {
        // Snap start handle (direct set — spring would be canceled by React sync effect)
        const maxStart = trimEndSV.value - MIN_TRIM_GAP_SEC;
        const clamped = Math.max(0, Math.min(touchSec, maxStart));
        trimStartSV.value = clamped;
        runOnJS(emitTrimChange)(clamped, trimEndSV.value);
      } else {
        // Snap end handle
        const minEnd = trimStartSV.value + MIN_TRIM_GAP_SEC;
        const clamped = Math.max(minEnd, Math.min(touchSec, dur));
        trimEndSV.value = clamped;
        runOnJS(emitTrimChange)(trimStartSV.value, clamped);
      }
      runOnJS(triggerHaptic)();
    })
    .maxDuration(300);

  const gesture = Gesture.Exclusive(pan, tap);

  // --- Animated styles ---

  // Left dimmed overlay (trimmed-out region)
  const leftDimStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const px = dur > 0 ? (trimStartSV.value / dur) * cw : 0;
    return { width: Math.max(0, px) };
  });

  // Right dimmed overlay (trimmed-out region)
  const rightDimStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const px = dur > 0 ? (trimEndSV.value / dur) * cw : cw;
    return { width: Math.max(0, cw - px), right: 0 };
  });

  // Left handle position — clamped to [0, containerWidth - HANDLE_WIDTH]
  const leftHandleStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const px = dur > 0 ? (trimStartSV.value / dur) * cw : 0;
    const x = Math.max(0, Math.min(cw - HANDLE_WIDTH, px - HANDLE_WIDTH / 2));
    return { transform: [{ translateX: x }] };
  });

  // Right handle position — clamped to [0, containerWidth - HANDLE_WIDTH]
  const rightHandleStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const px = dur > 0 ? (trimEndSV.value / dur) * cw : cw;
    const x = Math.max(0, Math.min(cw - HANDLE_WIDTH, px - HANDLE_WIDTH / 2));
    return { transform: [{ translateX: x }] };
  });

  // Top/bottom connecting bars between handles (the "frame")
  const topBarStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const startPx = dur > 0 ? (trimStartSV.value / dur) * cw : 0;
    const endPx = dur > 0 ? (trimEndSV.value / dur) * cw : cw;
    return {
      left: startPx,
      width: Math.max(0, endPx - startPx),
    };
  });

  const bottomBarStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    const startPx = dur > 0 ? (trimStartSV.value / dur) * cw : 0;
    const endPx = dur > 0 ? (trimEndSV.value / dur) * cw : cw;
    return {
      left: startPx,
      width: Math.max(0, endPx - startPx),
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.overlay, { height }]}>
        {/* Left dimmed region */}
        <Animated.View style={[styles.dimRegion, styles.dimLeft, leftDimStyle]} />

        {/* Right dimmed region */}
        <Animated.View style={[styles.dimRegion, styles.dimRight, rightDimStyle]} />

        {/* Top connecting bar */}
        <Animated.View style={[styles.connectingBar, styles.connectingBarTop, topBarStyle]} />

        {/* Bottom connecting bar */}
        <Animated.View style={[styles.connectingBar, styles.connectingBarBottom, bottomBarStyle]} />

        {/* Left handle — rounded on left, flat on right */}
        <Animated.View
          style={[styles.handle, styles.handleLeft, { height }, leftHandleStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel="Start trim handle"
          accessibilityHint="Drag or tap to adjust the start of the trim region"
        >
          <Animated.View style={styles.grip}>
            <Animated.View style={styles.gripLine} />
            <Animated.View style={styles.gripLine} />
          </Animated.View>
        </Animated.View>

        {/* Right handle — flat on left, rounded on right */}
        <Animated.View
          style={[styles.handle, styles.handleRight, { height }, rightHandleStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel="End trim handle"
          accessibilityHint="Drag or tap to adjust the end of the trim region"
        >
          <Animated.View style={styles.grip}>
            <Animated.View style={styles.gripLine} />
            <Animated.View style={styles.gripLine} />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  dimRegion: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(245, 245, 244, 0.65)',
  },
  dimLeft: {
    left: 0,
  },
  dimRight: {
    // right: 0 is set via animated style
  },
  connectingBar: {
    position: 'absolute',
    height: BORDER_THICKNESS,
    backgroundColor: '#0d8775',
    zIndex: 11,
  },
  connectingBarTop: {
    top: 0,
  },
  connectingBarBottom: {
    bottom: 0,
  },
  handle: {
    position: 'absolute',
    top: 0,
    width: HANDLE_WIDTH,
    backgroundColor: '#0d8775',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 12,
  },
  handleLeft: {
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  handleRight: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  grip: {
    gap: 4,
    alignItems: 'center',
  },
  gripLine: {
    width: 12,
    height: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 1.5,
  },
});

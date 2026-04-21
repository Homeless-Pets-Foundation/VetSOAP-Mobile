import React from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useAnimatedReaction,
  useSharedValue,
  type SharedValue,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const BADGE_WIDTH = 64;
const BADGE_OFFSET_Y = -28;

function formatHandleTime(seconds: number): string {
  'worklet';
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

interface TrimOverlayProps {
  trimStartSV: SharedValue<number>;
  trimEndSV: SharedValue<number>;
  durationSV: SharedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerWidth: number;
  height: number;
  duration: number;
  onTrimChange: (start: number, end: number) => void;
  // Scrub wiring (step 2b). When the user pans on the waveform far from either trim handle,
  // treat it as a playhead scrub: pause audio, drive currentTimeSV with the finger, then
  // on release call seekTo(time, wasPlaying). Pass null to disable scrub.
  currentTimeSV?: SharedValue<number>;
  onScrubStart?: () => void;
  onScrubEnd?: (seconds: number) => void;
  // Fires whenever a trim handle is touched (pan start or tap that snaps a handle). The
  // parent uses this to route nudge-button presses to the handle the user most recently
  // interacted with.
  onHandleActivate?: (which: 'start' | 'end') => void;
  // Zoom / pan wiring. Coordinate math maps pixel → second via the visible window
  // [panSV, panSV + duration/zoomSV] instead of the full duration. When zoomSV === 1 and
  // panSV === 0 (the default), the math reduces to the un-zoomed behaviour.
  zoomSV?: SharedValue<number>;
  panSV?: SharedValue<number>;
  // Double-tap zoom — receives the tapped time in seconds (within the current visible
  // window). Placed inside TrimOverlay's Exclusive group so it beats single-tap handle-snap.
  onZoomToggle?: (tapSec: number) => void;
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
  currentTimeSV,
  onScrubStart,
  onScrubEnd,
  onHandleActivate,
  zoomSV,
  panSV,
  onZoomToggle,
}: TrimOverlayProps) {
  // Which handle is being dragged: 0 = none, 1 = start, 2 = end, 3 = scrub playhead
  const activeHandle = useSharedValue(0);

  // Fallback SVs for when the caller doesn't pass zoom/pan (keeps the component usable
  // outside WaveformEditor). Default zoom = 1, pan = 0 reduces all math to the un-zoomed
  // behaviour — (event.x / cw) * dur, (sec / dur) * cw.
  const fallbackZoom = useSharedValue(1);
  const fallbackPan = useSharedValue(0);
  const zSV = zoomSV ?? fallbackZoom;
  const pSV = panSV ?? fallbackPan;

  const onTrimChangeRef = React.useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  const onScrubStartRef = React.useRef(onScrubStart);
  onScrubStartRef.current = onScrubStart;
  const onScrubEndRef = React.useRef(onScrubEnd);
  onScrubEndRef.current = onScrubEnd;
  const onHandleActivateRef = React.useRef(onHandleActivate);
  onHandleActivateRef.current = onHandleActivate;
  const onZoomToggleRef = React.useRef(onZoomToggle);
  onZoomToggleRef.current = onZoomToggle;

  function emitTrimChange(start: number, end: number) {
    onTrimChangeRef.current(start, end);
  }

  function emitScrubStart() {
    onScrubStartRef.current?.();
  }
  function emitScrubEnd(seconds: number) {
    onScrubEndRef.current?.(seconds);
  }
  function emitHandleActivate(which: 'start' | 'end') {
    onHandleActivateRef.current?.(which);
  }
  function emitZoomToggle(tapSec: number) {
    onZoomToggleRef.current?.(tapSec);
  }

  // --- Pan gesture: drag the nearest handle, or scrub the playhead if started far from both ---
  // SCRUB_PROXIMITY_PX defines how close to a handle (in device pixels) the touch must start
  // to grab that handle. Beyond that, the pan becomes a scrub gesture (if currentTimeSV was
  // passed in). This avoids a separate Gesture.Pan() that would fight the handle pan.
  // 44 ≈ Material 48dp touch target on a typical mdpi-equivalent device; gives ~3mm of
  // forgiveness on each side of the visible 14px handle.
  const SCRUB_PROXIMITY_PX = 44;
  const pan = Gesture.Pan()
    .onStart((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;

      const visibleDur = dur / zSV.value;
      const touchSec = pSV.value + (event.x / cw) * visibleDur;
      const startPx = ((trimStartSV.value - pSV.value) / visibleDur) * cw;
      const endPx = ((trimEndSV.value - pSV.value) / visibleDur) * cw;
      const distToStartPx = Math.abs(event.x - startPx);
      const distToEndPx = Math.abs(event.x - endPx);
      const nearestHandlePx = Math.min(distToStartPx, distToEndPx);

      if (currentTimeSV && nearestHandlePx > SCRUB_PROXIMITY_PX) {
        // Scrub mode — seek on release
        activeHandle.value = 3;
        currentTimeSV.value = Math.max(0, Math.min(touchSec, dur));
        runOnJS(emitScrubStart)();
        runOnJS(triggerHaptic)();
        return;
      }

      // Handle-drag mode — grab the nearer of start/end
      activeHandle.value = distToStartPx <= distToEndPx ? 1 : 2;
      runOnJS(emitHandleActivate)(activeHandle.value === 1 ? 'start' : 'end');
      runOnJS(triggerHaptic)();
    })
    .onUpdate((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0 || activeHandle.value === 0) return;

      const visibleDur = dur / zSV.value;
      const touchSec = pSV.value + (event.x / cw) * visibleDur;

      if (activeHandle.value === 1) {
        // Dragging start handle
        const maxStart = trimEndSV.value - MIN_TRIM_GAP_SEC;
        trimStartSV.value = Math.max(0, Math.min(touchSec, maxStart));
      } else if (activeHandle.value === 2) {
        // Dragging end handle
        const minEnd = trimStartSV.value + MIN_TRIM_GAP_SEC;
        trimEndSV.value = Math.max(minEnd, Math.min(touchSec, dur));
      } else if (activeHandle.value === 3 && currentTimeSV) {
        // Scrubbing — write directly to the playhead SV; no seekTo until release
        currentTimeSV.value = Math.max(0, Math.min(touchSec, dur));
      }
    })
    .onEnd(() => {
      'worklet';
      const wasScrubbing = activeHandle.value === 3;
      const finalScrubTime = currentTimeSV?.value ?? 0;
      activeHandle.value = 0;
      if (wasScrubbing) {
        runOnJS(emitScrubEnd)(finalScrubTime);
      } else {
        runOnJS(emitTrimChange)(trimStartSV.value, trimEndSV.value);
      }
    })
    .activeOffsetX([-8, 8])
    .failOffsetY([-15, 15])
    .minPointers(1)
    .maxPointers(1);

  // --- Tap gesture: snap nearest handle when the tap is near one, else seek playhead ---
  // Seek-on-tap mirrors the scrub behaviour of pan: only triggers when tap lands far from
  // both handles, so users can aim at a handle to snap it without accidentally jumping
  // the playhead.
  const tap = Gesture.Tap()
    .onEnd((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;

      const visibleDur = dur / zSV.value;
      const touchSec = Math.max(0, Math.min(pSV.value + (event.x / cw) * visibleDur, dur));
      const startPx = ((trimStartSV.value - pSV.value) / visibleDur) * cw;
      const endPx = ((trimEndSV.value - pSV.value) / visibleDur) * cw;
      const distToStartPx = Math.abs(event.x - startPx);
      const distToEndPx = Math.abs(event.x - endPx);
      const nearestPx = Math.min(distToStartPx, distToEndPx);

      if (currentTimeSV && nearestPx > SCRUB_PROXIMITY_PX) {
        // Far from handles — jump playhead to tap position (single-tap seek)
        currentTimeSV.value = touchSec;
        runOnJS(emitScrubEnd)(touchSec);
        runOnJS(triggerHaptic)();
        return;
      }

      if (distToStartPx <= distToEndPx) {
        // Snap start handle (direct set — spring would be canceled by React sync effect)
        const maxStart = trimEndSV.value - MIN_TRIM_GAP_SEC;
        const clamped = Math.max(0, Math.min(touchSec, maxStart));
        trimStartSV.value = clamped;
        runOnJS(emitHandleActivate)('start');
        runOnJS(emitTrimChange)(clamped, trimEndSV.value);
      } else {
        // Snap end handle
        const minEnd = trimStartSV.value + MIN_TRIM_GAP_SEC;
        const clamped = Math.max(minEnd, Math.min(touchSec, dur));
        trimEndSV.value = clamped;
        runOnJS(emitHandleActivate)('end');
        runOnJS(emitTrimChange)(trimStartSV.value, clamped);
      }
      runOnJS(triggerHaptic)();
    })
    .maxDuration(300);

  // Double-tap to toggle zoom, placed in the Exclusive group *before* single-tap so it
  // wins when two taps land within maxDelay. Single-tap (handle-snap / seek) still fires
  // normally if only one tap is received.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(250)
    .onEnd((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;
      const visibleDur = dur / zSV.value;
      const tapSec = pSV.value + (event.x / cw) * visibleDur;
      runOnJS(emitZoomToggle)(Math.max(0, Math.min(tapSec, dur)));
    });

  const gesture = Gesture.Exclusive(doubleTap, pan, tap);

  // --- Animated styles ---
  // All position math uses the visible window [pSV, pSV + durationSV/zSV]. When zoomed in,
  // handles outside the visible region render off-screen (clamped via overflow: hidden on
  // the parent); the connecting bars are truncated to [0, containerWidth].

  // Left dimmed overlay (trimmed-out region)
  const leftDimStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { width: 0 };
    const visibleDur = dur / zSV.value;
    const px = ((trimStartSV.value - pSV.value) / visibleDur) * cw;
    return { width: Math.max(0, Math.min(cw, px)) };
  });

  // Right dimmed overlay (trimmed-out region)
  const rightDimStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { width: 0, right: 0 };
    const visibleDur = dur / zSV.value;
    const px = ((trimEndSV.value - pSV.value) / visibleDur) * cw;
    const clamped = Math.max(0, Math.min(cw, px));
    return { width: Math.max(0, cw - clamped), right: 0 };
  });

  // Left handle position — clamped so it always stays within the visible container
  const leftHandleStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { transform: [{ translateX: 0 }] };
    const visibleDur = dur / zSV.value;
    const px = ((trimStartSV.value - pSV.value) / visibleDur) * cw;
    const x = Math.max(0, Math.min(cw - HANDLE_WIDTH, px - HANDLE_WIDTH / 2));
    return { transform: [{ translateX: x }] };
  });

  // Right handle position — clamped to [0, containerWidth - HANDLE_WIDTH]
  const rightHandleStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { transform: [{ translateX: 0 }] };
    const visibleDur = dur / zSV.value;
    const px = ((trimEndSV.value - pSV.value) / visibleDur) * cw;
    const x = Math.max(0, Math.min(cw - HANDLE_WIDTH, px - HANDLE_WIDTH / 2));
    return { transform: [{ translateX: x }] };
  });

  // Top/bottom connecting bars between handles (the "frame")
  const topBarStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { left: 0, width: 0 };
    const visibleDur = dur / zSV.value;
    const startPx = Math.max(0, ((trimStartSV.value - pSV.value) / visibleDur) * cw);
    const endPx = Math.min(cw, ((trimEndSV.value - pSV.value) / visibleDur) * cw);
    return {
      left: startPx,
      width: Math.max(0, endPx - startPx),
    };
  });

  const bottomBarStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (dur <= 0) return { left: 0, width: 0 };
    const visibleDur = dur / zSV.value;
    const startPx = Math.max(0, ((trimStartSV.value - pSV.value) / visibleDur) * cw);
    const endPx = Math.min(cw, ((trimEndSV.value - pSV.value) / visibleDur) * cw);
    return {
      left: startPx,
      width: Math.max(0, endPx - startPx),
    };
  });

  // Floating time badge — follows the currently-dragging handle with millisecond precision.
  // Position is worklet-driven; text content lives in React state and updates only when the
  // displayed value actually changes (once per millisecond change maximum, throttled further
  // because at 60Hz dragging through a 1-minute clip most pixels already represent >1 ms).
  const [badgeText, setBadgeText] = React.useState('00:00.000');
  useAnimatedReaction(
    () => {
      'worklet';
      if (activeHandle.value === 0) return -1;
      return activeHandle.value === 1 ? trimStartSV.value : trimEndSV.value;
    },
    (seconds, prev) => {
      'worklet';
      if (seconds < 0) return;
      // Round to milliseconds to avoid thrashing setState on sub-ms shared-value tremor
      const ms = Math.round(seconds * 1000);
      const prevMs = prev !== null && prev >= 0 ? Math.round(prev * 1000) : -1;
      if (ms !== prevMs) {
        runOnJS(setBadgeText)(formatHandleTime(seconds));
      }
    }
  );

  const badgeStyle = useAnimatedStyle(() => {
    const cw = containerWidthSV.value;
    const dur = durationSV.value;
    if (activeHandle.value === 0 || cw <= 0 || dur <= 0) {
      return { opacity: 0, transform: [{ translateX: 0 }] };
    }
    const seconds = activeHandle.value === 1 ? trimStartSV.value : trimEndSV.value;
    const visibleDur = dur / zSV.value;
    const handleCenterPx = ((seconds - pSV.value) / visibleDur) * cw;
    // Clamp so the badge never renders off-screen even when the handle itself is beyond
    // the visible window
    const x = Math.max(0, Math.min(cw - BADGE_WIDTH, handleCenterPx - BADGE_WIDTH / 2));
    return { opacity: 1, transform: [{ translateX: x }] };
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

        {/* Floating MM:SS.mmm badge — only visible while a handle is being dragged */}
        <Animated.View
          pointerEvents="none"
          style={[styles.badge, badgeStyle]}
        >
          <Animated.Text style={styles.badgeText}>{badgeText}</Animated.Text>
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
  badge: {
    position: 'absolute',
    top: BADGE_OFFSET_Y,
    left: 0,
    width: BADGE_WIDTH,
    paddingVertical: 3,
    paddingHorizontal: 6,
    backgroundColor: '#0d8775',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 13,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});

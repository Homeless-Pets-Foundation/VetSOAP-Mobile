import React, { useCallback } from 'react';
import { View, Text, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useAnimatedReaction,
  runOnJS,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { StaticWaveform } from './StaticWaveform';
import { TrimOverlay } from './TrimOverlay';

interface WaveformEditorProps {
  peaks: number[];
  duration: number;
  currentTimeSV: SharedValue<number>;
  trimStart: number;
  trimEnd: number;
  // Parent-owned shared values — mirror trimStart/trimEnd but live on the UI thread for
  // worklet-driven interactions (scrub, nudge, preview-stop reaction).
  trimStartSV: SharedValue<number>;
  trimEndSV: SharedValue<number>;
  onTrimChange: (start: number, end: number) => void;
  onSeek: (seconds: number) => void;
  // Scrub callbacks — forwarded to TrimOverlay. When a pan or tap lands far from both trim
  // handles, the gesture becomes a playhead scrub: onScrubStart pauses audio, onScrubEnd
  // seeks to the final position (and resumes if it was playing).
  onScrubStart?: () => void;
  onScrubEnd?: (seconds: number) => void;
  // Fires whenever a trim handle is activated (grabbed via pan or snapped via tap). Drives
  // the nudge-button target in the parent.
  onHandleActivate?: (which: 'start' | 'end') => void;
  isLoading?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const MAX_ZOOM = 10;
const MIN_ZOOM = 1;

export function WaveformEditor({
  peaks,
  duration,
  currentTimeSV,
  trimStart,
  trimEnd,
  trimStartSV,
  trimEndSV,
  onTrimChange,
  onSeek,
  onScrubStart,
  onScrubEnd,
  onHandleActivate,
  isLoading = false,
}: WaveformEditorProps) {
  const [containerWidth, setContainerWidth] = React.useState(0);
  const WAVEFORM_HEIGHT = 120;

  // Store containerWidth and duration in shared values so worklets can read them
  const containerWidthSV = useSharedValue(0);
  const durationSV = useSharedValue(duration);
  React.useEffect(() => {
    containerWidthSV.value = containerWidth;
  }, [containerWidth, containerWidthSV]);
  React.useEffect(() => {
    durationSV.value = duration;
  }, [duration, durationSV]);

  // Zoom / pan. zoomSV in [1, 10]; panSV is the visible-window left edge in seconds.
  // Visible range = [panSV, panSV + duration/zoomSV]. Scale/pan anchor on the pinch focal
  // point, keeping the time under the user's fingers stationary.
  // Visible bounds mirror into React state so StaticWaveform can re-window its peaks.
  const zoomSV = useSharedValue(1);
  const panSV = useSharedValue(0);
  const [visibleStartSec, setVisibleStartSec] = React.useState(0);
  const [visibleEndSec, setVisibleEndSec] = React.useState(duration);

  // Reset zoom/pan when a new segment loads (duration change is the signal)
  React.useEffect(() => {
    zoomSV.value = 1;
    panSV.value = 0;
    setVisibleStartSec(0);
    setVisibleEndSec(duration);
  }, [duration, zoomSV, panSV]);

  // Reflect zoom/pan into React state so StaticWaveform can pick the right peak slice.
  // Throttled: only fires when the integer-second window shifts, which is plenty to keep
  // the waveform visually matched to the handle/playhead positions without overrendering
  // during an active pinch.
  useAnimatedReaction(
    () => {
      'worklet';
      const dur = durationSV.value;
      if (dur <= 0) return { start: 0, end: 0 };
      const visible = dur / zoomSV.value;
      return { start: panSV.value, end: panSV.value + visible };
    },
    (val, prev) => {
      'worklet';
      if (val.end === 0) return;
      if (!prev || Math.abs(val.start - prev.start) > 0.05 || Math.abs(val.end - prev.end) > 0.05) {
        runOnJS(setVisibleStartSec)(val.start);
        runOnJS(setVisibleEndSec)(val.end);
      }
    }
  );

  // Playhead — driven entirely on the UI thread via Reanimated.
  // Uses the visible window so the playhead lines up with zoomed waveform + trim handles.
  const playheadX = useDerivedValue(() => {
    const dur = durationSV.value;
    const cw = containerWidthSV.value;
    if (dur <= 0 || cw <= 0) return 0;
    const visible = dur / zoomSV.value;
    return ((currentTimeSV.value - panSV.value) / visible) * cw;
  });

  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: playheadX.value }],
  }));

  // Stable ref for onTrimChange to avoid recreating TrimOverlay callbacks
  const onTrimChangeRef = React.useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  const handleTrimChange = useCallback((start: number, end: number) => {
    onTrimChangeRef.current(start, end);
  }, []);

  // Pinch gesture — zooms anchored on the focal point so the time under the user's fingers
  // stays fixed. Two-finger pan (minPointers=2) scrolls the visible window while zoomed.
  // Both compose with the trim overlay via Gesture.Simultaneous so single-finger pan/tap
  // still controls handles and scrub.
  const pinchZoomAtStart = useSharedValue(1);
  const pinchPanAtStart = useSharedValue(0);
  const pinchFocalSec = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onStart((event) => {
      'worklet';
      pinchZoomAtStart.value = zoomSV.value;
      pinchPanAtStart.value = panSV.value;
      const cw = containerWidthSV.value;
      if (cw <= 0) return;
      const visible = durationSV.value / zoomSV.value;
      pinchFocalSec.value = panSV.value + (event.focalX / cw) * visible;
    })
    .onUpdate((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0) return;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchZoomAtStart.value * event.scale));
      zoomSV.value = newZoom;
      // Keep the pinch focal point pinned to its original time
      const visible = dur / newZoom;
      const desiredLeftSec = pinchFocalSec.value - (event.focalX / cw) * visible;
      panSV.value = Math.max(0, Math.min(dur - visible, desiredLeftSec));
    });

  const twoFingerPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onUpdate((event) => {
      'worklet';
      const cw = containerWidthSV.value;
      const dur = durationSV.value;
      if (cw <= 0 || dur <= 0 || zoomSV.value <= 1) return;
      const visible = dur / zoomSV.value;
      const deltaSec = -(event.translationX / cw) * visible;
      const nextPan = Math.max(0, Math.min(dur - visible, pinchPanAtStart.value + deltaSec));
      panSV.value = nextPan;
    })
    .onBegin(() => {
      'worklet';
      pinchPanAtStart.value = panSV.value;
    });

  // Double-tap to toggle zoom (1x ↔ 3x around tap point). Lives *inside* TrimOverlay's
  // Exclusive group so it beats single-tap handle-snap; we just give it a JS callback here.
  const toggleZoomAt = useCallback(
    (tapSec: number) => {
      const dur = durationSV.value;
      if (dur <= 0) return;
      if (zoomSV.value > 1) {
        zoomSV.value = 1;
        panSV.value = 0;
      } else {
        const newZoom = 3;
        const visible = dur / newZoom;
        const desiredLeftSec = tapSec - visible / 2;
        zoomSV.value = newZoom;
        panSV.value = Math.max(0, Math.min(dur - visible, desiredLeftSec));
      }
    },
    [zoomSV, panSV, durationSV]
  );

  const zoomGesture = Gesture.Simultaneous(pinch, twoFingerPan);

  const keepDuration = Math.max(0, trimEnd - trimStart);
  const removeDuration = Math.max(0, duration - keepDuration);

  // Android only: tell the OS not to interpret edge swipes inside the waveform as
  // back-gestures. Without this, dragging the right trim handle near the screen edge
  // can be hijacked by Android's predictive-back system. iOS ignores the call.
  const containerRef = React.useRef<View>(null);
  React.useEffect(() => {
    if (Platform.OS !== 'android' || containerWidth <= 0) return;
    const node = containerRef.current as unknown as { setNativeProps?: (p: object) => void } | null;
    node?.setNativeProps?.({
      systemGestureExclusionRects: [
        { x: 0, y: 0, width: containerWidth, height: WAVEFORM_HEIGHT },
      ],
    });
  }, [containerWidth]);

  return (
    <View
      ref={containerRef}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      className="relative"
    >
      {/* Zoom/pan gesture wraps the waveform+overlay — single-finger pan/tap reach through
          to the trim overlay via Gesture.Simultaneous below; pinch + 2-finger pan + double
          tap only activate when their specific pointer-count / scale conditions are met. */}
      <GestureDetector gesture={zoomGesture}>
        <View>
          {/* Waveform — static SVG, re-renders when peaks, trim range, or visible window change */}
          <StaticWaveform
            peaks={peaks}
            duration={duration}
            trimStart={trimStart}
            trimEnd={trimEnd}
            height={WAVEFORM_HEIGHT}
            isLoading={isLoading}
            visibleStartSec={visibleStartSec}
            visibleEndSec={visibleEndSec}
          />

          {/* Playhead — 2px red line, moves on UI thread via Reanimated, zero JS cost */}
          {!isLoading && containerWidth > 0 && duration > 0 && (
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 2,
                  height: WAVEFORM_HEIGHT,
                  backgroundColor: '#ef4444',
                },
                playheadStyle,
              ]}
              pointerEvents="none"
            />
          )}

          {/* Unified trim overlay — handles all single-finger touch interactions.
              Rendered independently of isLoading so trim works while peaks are still
              extracting (or have failed). Trim math constrains on seconds vs duration,
              not on the peaks array — the visualization is an aid, not a data dep. */}
          {containerWidth > 0 && duration > 0 && (
            <TrimOverlay
              trimStartSV={trimStartSV}
              trimEndSV={trimEndSV}
              durationSV={durationSV}
              containerWidthSV={containerWidthSV}
              containerWidth={containerWidth}
              height={WAVEFORM_HEIGHT}
              duration={duration}
              onTrimChange={handleTrimChange}
              currentTimeSV={currentTimeSV}
              onScrubStart={onScrubStart}
              onScrubEnd={onScrubEnd}
              onHandleActivate={onHandleActivate}
              zoomSV={zoomSV}
              panSV={panSV}
              onZoomToggle={toggleZoomAt}
            />
          )}
        </View>
      </GestureDetector>

      {/* Time labels — visible whenever duration is known, even before peaks load,
          so users see Keep/Remove updates while dragging handles during extraction. */}
      {duration > 0 && (
        <View className="flex-row justify-between mt-2 px-1">
          <Text className="text-caption text-brand-600 font-medium">
            {formatTime(trimStart)}
          </Text>
          <Text className="text-caption text-stone-500">
            Keep {formatTime(keepDuration)}
            {removeDuration > 0 && ` · Remove ${formatTime(removeDuration)}`}
          </Text>
          <Text className="text-caption text-brand-600 font-medium">
            {formatTime(trimEnd)}
          </Text>
        </View>
      )}
    </View>
  );
}

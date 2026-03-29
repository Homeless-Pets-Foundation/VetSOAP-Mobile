import React, { useCallback, useMemo } from 'react';
import { View, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
import { StaticWaveform } from './StaticWaveform';
import { TrimHandle } from './TrimHandle';

interface WaveformEditorProps {
  peaks: number[];
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  onTrimChange: (start: number, end: number) => void;
  onSeek: (seconds: number) => void;
  isLoading?: boolean;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function WaveformEditor({
  peaks,
  duration,
  currentTime,
  trimStart,
  trimEnd,
  onTrimChange,
  onSeek,
  isLoading = false,
}: WaveformEditorProps) {
  const [containerWidth, setContainerWidth] = React.useState(0);
  const WAVEFORM_HEIGHT = 120;
  const MIN_TRIM_GAP_SECONDS = 1;

  // Store containerWidth and duration in shared values so worklets can read them
  const containerWidthSV = useSharedValue(0);
  const durationSV = useSharedValue(duration);
  React.useEffect(() => {
    containerWidthSV.value = containerWidth;
  }, [containerWidth, containerWidthSV]);
  React.useEffect(() => {
    durationSV.value = duration;
  }, [duration, durationSV]);

  // Shared values for handle positions (in seconds, not pixels)
  const trimStartSV = useSharedValue(trimStart);
  const trimEndSV = useSharedValue(trimEnd);

  // Sync shared values when React state props change (e.g., segment switch)
  React.useEffect(() => {
    trimStartSV.value = trimStart;
    trimEndSV.value = trimEnd;
  }, [trimStart, trimEnd, trimStartSV, trimEndSV]);

  // Callbacks for when a handle finishes dragging — read seconds from shared values
  const onTrimChangeRef = React.useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  const handleStartDragEnd = useCallback(() => {
    const newStart = Math.max(0, Math.min(trimStartSV.value, trimEndSV.value - MIN_TRIM_GAP_SECONDS));
    const currentEnd = trimEndSV.value;
    trimStartSV.value = newStart;
    onTrimChangeRef.current(newStart, currentEnd);
  }, [trimStartSV, trimEndSV]);

  const handleEndDragEnd = useCallback(() => {
    const currentStart = trimStartSV.value;
    const dur = durationSV.value;
    const newEnd = Math.max(currentStart + MIN_TRIM_GAP_SECONDS, Math.min(trimEndSV.value, dur));
    trimEndSV.value = newEnd;
    onTrimChangeRef.current(currentStart, newEnd);
  }, [trimStartSV, trimEndSV, durationSV]);

  const minGapFraction = duration > 0 ? MIN_TRIM_GAP_SECONDS / duration : 0;

  const keepDuration = Math.max(0, trimEnd - trimStart);
  const removeDuration = Math.max(0, duration - keepDuration);

  // Convert seconds → pixels for display
  const secToX = useCallback(
    (sec: number) => (duration > 0 ? (sec / duration) * containerWidth : 0),
    [duration, containerWidth]
  );

  return (
    <View
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      className="relative"
    >
      {/* Waveform */}
      <StaticWaveform
        peaks={peaks}
        duration={duration}
        currentTime={currentTime}
        trimStart={trimStart}
        trimEnd={trimEnd}
        onSeek={onSeek}
        height={WAVEFORM_HEIGHT}
        isLoading={isLoading}
      />

      {/* Trim handles overlay */}
      {!isLoading && containerWidth > 0 && duration > 0 && (
        <GestureHandlerRootView
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          pointerEvents="box-none"
        >
          <TrimHandle
            positionSeconds={trimStartSV}
            otherPositionSeconds={trimEndSV}
            durationSV={durationSV}
            containerWidthSV={containerWidthSV}
            containerWidth={containerWidth}
            height={WAVEFORM_HEIGHT}
            side="left"
            minGapFraction={minGapFraction}
            timeSeconds={trimStart}
            duration={duration}
            onDragEnd={handleStartDragEnd}
          />
          <TrimHandle
            positionSeconds={trimEndSV}
            otherPositionSeconds={trimStartSV}
            durationSV={durationSV}
            containerWidthSV={containerWidthSV}
            containerWidth={containerWidth}
            height={WAVEFORM_HEIGHT}
            side="right"
            minGapFraction={minGapFraction}
            timeSeconds={trimEnd}
            duration={duration}
            onDragEnd={handleEndDragEnd}
          />
        </GestureHandlerRootView>
      )}

      {/* Time labels */}
      {!isLoading && duration > 0 && (
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

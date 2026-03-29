import React, { useCallback } from 'react';
import { View, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
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

  // Convert seconds → pixels
  const secToX = useCallback(
    (sec: number) => (duration > 0 ? (sec / duration) * containerWidth : 0),
    [duration, containerWidth]
  );
  const xToSec = useCallback(
    (x: number) => (containerWidth > 0 ? (x / containerWidth) * duration : 0),
    [duration, containerWidth]
  );

  // Shared values for handle positions (in pixels)
  const startX = useSharedValue(secToX(trimStart));
  const endX = useSharedValue(secToX(trimEnd));

  // Sync shared values when props change
  React.useEffect(() => {
    if (containerWidth > 0) {
      startX.value = secToX(trimStart);
      endX.value = secToX(trimEnd);
    }
  }, [trimStart, trimEnd, containerWidth, duration, startX, endX, secToX]);

  const handleStartDragEnd = useCallback(() => {
    const newStart = xToSec(startX.value);
    const currentEnd = xToSec(endX.value);
    const clamped = Math.min(newStart, currentEnd - MIN_TRIM_GAP_SECONDS);
    onTrimChange(Math.max(0, clamped), currentEnd);
  }, [xToSec, startX, endX, onTrimChange]);

  const handleEndDragEnd = useCallback(() => {
    const currentStart = xToSec(startX.value);
    const newEnd = xToSec(endX.value);
    const clamped = Math.max(newEnd, currentStart + MIN_TRIM_GAP_SECONDS);
    onTrimChange(currentStart, Math.min(clamped, duration));
  }, [xToSec, startX, endX, duration, onTrimChange]);

  const keepDuration = Math.max(0, trimEnd - trimStart);
  const removeDuration = Math.max(0, duration - keepDuration);

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
            position={startX}
            minPosition={0}
            maxPosition={secToX(trimEnd - MIN_TRIM_GAP_SECONDS)}
            containerWidth={containerWidth}
            height={WAVEFORM_HEIGHT}
            side="left"
            timeSeconds={trimStart}
            duration={duration}
            onDragEnd={handleStartDragEnd}
          />
          <TrimHandle
            position={endX}
            minPosition={secToX(trimStart + MIN_TRIM_GAP_SECONDS)}
            maxPosition={containerWidth}
            containerWidth={containerWidth}
            height={WAVEFORM_HEIGHT}
            side="right"
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

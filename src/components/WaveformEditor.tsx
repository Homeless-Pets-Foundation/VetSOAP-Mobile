import React, { useCallback } from 'react';
import { View, Text } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { StaticWaveform } from './StaticWaveform';
import { TrimOverlay } from './TrimOverlay';

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
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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

  // Store containerWidth and duration in shared values so worklets can read them
  const containerWidthSV = useSharedValue(0);
  const durationSV = useSharedValue(duration);
  React.useEffect(() => {
    containerWidthSV.value = containerWidth;
  }, [containerWidth, containerWidthSV]);
  React.useEffect(() => {
    durationSV.value = duration;
  }, [duration, durationSV]);

  // Shared values for handle positions (in seconds)
  const trimStartSV = useSharedValue(trimStart);
  const trimEndSV = useSharedValue(trimEnd);

  // Sync shared values when React state props change (e.g., segment switch, reset)
  React.useEffect(() => {
    trimStartSV.value = trimStart;
    trimEndSV.value = trimEnd;
  }, [trimStart, trimEnd, trimStartSV, trimEndSV]);

  // Stable ref for onTrimChange to avoid recreating TrimOverlay callbacks
  const onTrimChangeRef = React.useRef(onTrimChange);
  onTrimChangeRef.current = onTrimChange;

  const handleTrimChange = useCallback((start: number, end: number) => {
    onTrimChangeRef.current(start, end);
  }, []);

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
        height={WAVEFORM_HEIGHT}
        isLoading={isLoading}
      />

      {/* Unified trim overlay — handles all touch interactions */}
      {!isLoading && containerWidth > 0 && duration > 0 && (
        <TrimOverlay
          trimStartSV={trimStartSV}
          trimEndSV={trimEndSV}
          durationSV={durationSV}
          containerWidthSV={containerWidthSV}
          containerWidth={containerWidth}
          height={WAVEFORM_HEIGHT}
          duration={duration}
          onTrimChange={handleTrimChange}
        />
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

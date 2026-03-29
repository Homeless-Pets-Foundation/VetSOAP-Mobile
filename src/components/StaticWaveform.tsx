import React from 'react';
import { View, Pressable } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
import { Skeleton } from './ui/Skeleton';

interface StaticWaveformProps {
  peaks: number[];
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  onSeek: (seconds: number) => void;
  height?: number;
  isLoading?: boolean;
}

export function StaticWaveform({
  peaks,
  duration,
  currentTime,
  trimStart,
  trimEnd,
  onSeek,
  height = 120,
  isLoading = false,
}: StaticWaveformProps) {
  const [layoutWidth, setLayoutWidth] = React.useState(0);

  if (isLoading) {
    return (
      <View style={{ height }} className="rounded-lg overflow-hidden">
        <Skeleton />
      </View>
    );
  }

  if (peaks.length === 0 || duration <= 0) {
    return (
      <View
        style={{ height }}
        className="rounded-lg bg-stone-100 items-center justify-center"
      />
    );
  }

  const barCount = peaks.length;
  const barWidth = layoutWidth > 0 ? Math.max(1, layoutWidth / barCount - 1) : 2;
  const barGap = 1;
  const halfHeight = height / 2;
  const minBarHeight = 2;

  // Compute positions
  const playheadX = duration > 0 ? (currentTime / duration) * layoutWidth : 0;
  const trimStartX = duration > 0 ? (trimStart / duration) * layoutWidth : 0;
  const trimEndX = duration > 0 ? (trimEnd / duration) * layoutWidth : layoutWidth;

  const handlePress = (event: { nativeEvent: { locationX: number } }) => {
    if (layoutWidth <= 0 || duration <= 0) return;
    const x = event.nativeEvent.locationX;
    const seconds = (x / layoutWidth) * duration;
    onSeek(Math.max(0, Math.min(seconds, duration)));
  };

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="adjustable"
      accessibilityLabel={`Audio waveform. Current position ${Math.floor(currentTime)} of ${Math.floor(duration)} seconds.`}
      onLayout={(e) => setLayoutWidth(e.nativeEvent.layout.width)}
      style={{ height }}
      className="rounded-lg bg-stone-100 overflow-hidden"
    >
      {layoutWidth > 0 && (
        <Svg width={layoutWidth} height={height}>
          {/* Waveform bars */}
          {peaks.map((peak, i) => {
            const x = i * (barWidth + barGap);
            const barHeight = Math.max(minBarHeight, peak * halfHeight * 0.9);
            const isInTrimRegion = x >= trimStartX && x <= trimEndX;
            const fill = isInTrimRegion ? '#0d8775' : '#a8a29e';
            const opacity = isInTrimRegion ? 1 : 0.4;

            return (
              <React.Fragment key={i}>
                {/* Top half (mirrored) */}
                <Rect
                  x={x}
                  y={halfHeight - barHeight}
                  width={barWidth}
                  height={barHeight}
                  fill={fill}
                  opacity={opacity}
                  rx={barWidth > 2 ? 1 : 0}
                />
                {/* Bottom half */}
                <Rect
                  x={x}
                  y={halfHeight}
                  width={barWidth}
                  height={barHeight}
                  fill={fill}
                  opacity={opacity}
                  rx={barWidth > 2 ? 1 : 0}
                />
              </React.Fragment>
            );
          })}

          {/* Playhead line */}
          <Line
            x1={playheadX}
            y1={0}
            x2={playheadX}
            y2={height}
            stroke="#ef4444"
            strokeWidth={2}
          />
        </Svg>
      )}
    </Pressable>
  );
}

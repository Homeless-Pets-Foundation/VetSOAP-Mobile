import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Line } from 'react-native-svg';
import { Skeleton } from './ui/Skeleton';

interface StaticWaveformProps {
  peaks: number[];
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  height?: number;
  isLoading?: boolean;
}

export function StaticWaveform({
  peaks,
  duration,
  currentTime,
  trimStart,
  trimEnd,
  height = 120,
  isLoading = false,
}: StaticWaveformProps) {
  const [layoutWidth, setLayoutWidth] = React.useState(0);

  const barCount = peaks.length;
  const barWidth = layoutWidth > 0 && barCount > 0 ? Math.max(1, layoutWidth / barCount - 1) : 2;
  const barGap = 1;
  const halfHeight = height / 2;
  const minBarHeight = 2;

  const trimStartX = duration > 0 ? (trimStart / duration) * layoutWidth : 0;
  const trimEndX = duration > 0 ? (trimEnd / duration) * layoutWidth : layoutWidth;

  // Build 2 SVG path strings (active + dimmed) instead of 600 individual Rect
  // elements. Each bar is a pair of M...h...v...h...Z subpaths (top + bottom
  // mirror). The native SVG renderer processes each path in a single C++ pass
  // with one GPU draw call, instead of 600 bridge crossings.
  const { activePath, dimmedPath } = React.useMemo(() => {
    if (peaks.length === 0 || duration <= 0) return { activePath: '', dimmedPath: '' };
    let active = '';
    let dimmed = '';
    for (let i = 0; i < peaks.length; i++) {
      const x = i * (barWidth + barGap);
      const barHeight = Math.max(minBarHeight, peaks[i] * halfHeight * 0.9);
      const isInTrimRegion = x >= trimStartX && x <= trimEndX;

      // Top half (mirrored above center)
      const topY = halfHeight - barHeight;
      const bar = `M${x},${topY}h${barWidth}v${barHeight}h${-barWidth}Z` +
                  `M${x},${halfHeight}h${barWidth}v${barHeight}h${-barWidth}Z`;

      if (isInTrimRegion) {
        active += bar;
      } else {
        dimmed += bar;
      }
    }
    return { activePath: active, dimmedPath: dimmed };
  }, [peaks, duration, barWidth, barGap, halfHeight, minBarHeight, trimStartX, trimEndX]);

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

  const playheadX = duration > 0 ? (currentTime / duration) * layoutWidth : 0;

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={`Audio waveform. Current position ${Math.floor(currentTime)} of ${Math.floor(duration)} seconds.`}
      onLayout={(e) => setLayoutWidth(e.nativeEvent.layout.width)}
      style={{ height }}
      className="rounded-lg bg-stone-100 overflow-hidden"
    >
      {layoutWidth > 0 && (
        <Svg width={layoutWidth} height={height}>
          {/* Waveform bars — 2 Path elements instead of N*2 Rects */}
          {dimmedPath.length > 0 && (
            <Path d={dimmedPath} fill="#a8a29e" opacity={0.4} />
          )}
          {activePath.length > 0 && (
            <Path d={activePath} fill="#0d8775" opacity={1} />
          )}

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
    </View>
  );
}

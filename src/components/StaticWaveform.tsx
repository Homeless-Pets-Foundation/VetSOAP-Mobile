import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Skeleton } from './ui/Skeleton';

interface StaticWaveformProps {
  peaks: number[];
  duration: number;
  trimStart: number;
  trimEnd: number;
  height?: number;
  isLoading?: boolean;
  // Zoom/pan window (in seconds). When provided and not equal to [0, duration], the waveform
  // renders only the windowed slice of peaks, stretched to the full layout width. Bar width
  // grows in proportion to (duration / visible) so zoomed-in regions get a larger visual.
  // Omitted values default to showing the full duration.
  visibleStartSec?: number;
  visibleEndSec?: number;
}

// Wrapped in React.memo — only re-renders when peaks or trim range change.
// The playhead is rendered separately in WaveformEditor as a Reanimated
// Animated.View, so currentTime updates never trigger an SVG re-render.
export const StaticWaveform = React.memo(function StaticWaveform({
  peaks,
  duration,
  trimStart,
  trimEnd,
  height = 120,
  isLoading = false,
  visibleStartSec,
  visibleEndSec,
}: StaticWaveformProps) {
  const [layoutWidth, setLayoutWidth] = React.useState(0);

  // Windowed view: compute which slice of peaks corresponds to the visible region, and
  // stretch it to full layout width. When unzoomed, this is [0, peaks.length] — identical
  // to the pre-zoom behaviour.
  const vStart = Math.max(0, Math.min(duration, visibleStartSec ?? 0));
  const vEnd = Math.max(vStart, Math.min(duration, visibleEndSec ?? duration));
  const n = peaks.length;
  const firstIdx = duration > 0 && n > 0 ? Math.max(0, Math.floor((vStart / duration) * n)) : 0;
  const lastIdx = duration > 0 && n > 0 ? Math.min(n, Math.ceil((vEnd / duration) * n)) : n;
  const visibleBarCount = Math.max(0, lastIdx - firstIdx);

  const barWidth = layoutWidth > 0 && visibleBarCount > 0 ? Math.max(1, layoutWidth / visibleBarCount - 1) : 2;
  const barGap = 1;
  const halfHeight = height / 2;
  const minBarHeight = 2;

  // Trim region in the visible coordinate space
  const visibleDur = vEnd - vStart;
  const trimStartX = visibleDur > 0 ? ((trimStart - vStart) / visibleDur) * layoutWidth : 0;
  const trimEndX = visibleDur > 0 ? ((trimEnd - vStart) / visibleDur) * layoutWidth : layoutWidth;

  // Build 2 SVG path strings (active + dimmed) instead of 600 individual Rect
  // elements. Each bar is a pair of M...h...v...h...Z subpaths (top + bottom
  // mirror). The native SVG renderer processes each path in a single C++ pass
  // with one GPU draw call, instead of 600 bridge crossings.
  const { activePath, dimmedPath } = React.useMemo(() => {
    if (visibleBarCount === 0 || visibleDur <= 0) return { activePath: '', dimmedPath: '' };
    let active = '';
    let dimmed = '';
    for (let i = 0; i < visibleBarCount; i++) {
      const peak = peaks[firstIdx + i] ?? 0;
      const x = i * (barWidth + barGap);
      const barHeight = Math.max(minBarHeight, peak * halfHeight * 0.9);
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
  }, [peaks, firstIdx, visibleBarCount, visibleDur, barWidth, barGap, halfHeight, minBarHeight, trimStartX, trimEndX]);

  if (isLoading) {
    return (
      <View style={{ height }} className="rounded-lg overflow-hidden">
        <Skeleton />
      </View>
    );
  }

  if (n === 0 || duration <= 0) {
    return (
      <View
        style={{ height }}
        className="rounded-lg bg-stone-100 items-center justify-center"
      />
    );
  }

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={`Audio waveform. Duration ${Math.floor(duration)} seconds.`}
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
        </Svg>
      )}
    </View>
  );
});

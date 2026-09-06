import React, { useMemo } from 'react';
import { View } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  Easing,
  cancelAnimation,
  type SharedValue,
} from 'react-native-reanimated';
import { useResponsive } from '../hooks/useResponsive';

const MIN_HEIGHT = 4;

interface AudioWaveformProps {
  isActive: boolean;
  isPaused?: boolean;
  /**
   * 0..1 level (see `normalizeMeteringDb`), owned by the caller. A metering
   * sample is written straight into this SharedValue, so it never passes
   * through React state on its way to the bars — the previous design fanned
   * one sample into 24–36 per-bar `withTiming` starts on a LAYOUT prop
   * (`height`) through a React re-render, which on the durable backend's 4 Hz
   * metering was ~100+ animation starts and a Yoga relayout per second on
   * low-end Android. Omit for a static (inactive) waveform.
   */
  level?: SharedValue<number>;
}

interface WaveBarProps {
  index: number;
  barCount: number;
  isActive: boolean;
  barWidth: number;
  barGap: number;
  maxHeight: number;
  level: SharedValue<number>;
  jitter: number;
}

/**
 * One bar. Fixed layout height, animated via `scaleY` on the UI thread from the
 * shared level — no per-bar effect, no per-bar animation start, no layout pass.
 */
const WaveBar = React.memo(function WaveBar({ index, barCount, isActive, barWidth, barGap, maxHeight, level, jitter }: WaveBarProps) {
  // Per-bar constant: bars near the center are taller, edges shorter.
  const center = barCount / 2;
  const distFromCenter = Math.abs(index - center) / center;
  const variation = (1 - distFromCenter * 0.4) * jitter;
  const minScale = MIN_HEIGHT / maxHeight;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: Math.max(minScale, Math.min(1, level.value * variation)) }],
  }));

  return (
    <Animated.View
      className={`rounded-full ${isActive ? 'bg-brand-500' : 'bg-border-strong'}`}
      style={[
        // Explicit radius: `rounded-full` resolves against the un-scaled box, so
        // pin it to the bar width to keep the pill ends round at low scale.
        { width: barWidth, height: maxHeight, marginHorizontal: barGap / 2, borderRadius: barWidth / 2 },
        animatedStyle,
      ]}
    />
  );
});

/**
 * Slow breathing ring behind the bars — telegraphs "alive / capturing". Only
 * animates while the recorder is live (isActive && !isPaused); otherwise it
 * stays invisible. brand-tinted via bg-brand-500 at low opacity so it reads in
 * both light + dark and respects the dark-mode color guard.
 */
function BreathingRing({ active }: { active: boolean }) {
  const progress = useSharedValue(0);

  React.useEffect(() => {
    if (active) {
      progress.value = withRepeat(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    } else {
      cancelAnimation(progress);
      progress.value = withTiming(0, { duration: 300 });
    }
    return () => { cancelAnimation(progress); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- progress is a stable SharedValue ref
  }, [active]);

  const style = useAnimatedStyle(() => ({
    // Opacity floors at 0 (progress=0 when idle) so the ring is fully invisible
    // until recording — no stray ghost behind the resting bars.
    opacity: progress.value * 0.18,
    // Fills the box (left:0/right:0 → symmetric, so it stays centered) and
    // breathes via scale. scaleX<1 keeps it a centered pill behind the bars.
    transform: [{ scaleX: 0.5 + progress.value * 0.08 }, { scaleY: 0.85 + progress.value * 0.15 }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      className="absolute rounded-full bg-brand-500"
      style={[{ left: 0, right: 0, top: 0, bottom: 0 }, style]}
    />
  );
}

/**
 * Memoized: its props are `isActive`, `isPaused` and a stable SharedValue, so
 * the once-per-second timer commit in RecorderLiveReadout never reaches the
 * bars.
 */
export const AudioWaveform = React.memo(function AudioWaveform({ isActive, isPaused, level }: AudioWaveformProps) {
  const { isTablet: isWide } = useResponsive();
  const barCount = isWide ? 36 : 24;
  const barWidth = isWide ? 4 : 3;
  const barGap = isWide ? 3 : 2;
  // Hero sizing: bars fill a much taller stage (≈120px tablet / 80px phone)
  // so the recording state reads as the app's energetic peak, not a footnote.
  const maxHeight = isWide ? 104 : 68;
  const containerHeight = isWide ? 120 : 80;

  // A static waveform (non-owner card) has no caller-owned level: rest at 0.
  const idleLevel = useSharedValue(0);
  const barLevel = level ?? idleLevel;

  // Pre-calculate per-bar jitter once (deterministic across renders)
  const jitterValues = useMemo(
    () => Array.from({ length: barCount }, () => 0.85 + Math.random() * 0.3),
    [barCount]
  );

  const live = isActive && !isPaused;

  return (
    <View
      // The glow stays on THIS node: iOS draws a legacy shadow from the layer's
      // content alpha, so an empty sibling would render no glow at all, and on
      // Android the elevation shadow comes from the outline, not the children.
      //
      // It is an inline style, NOT a conditional `shadow-glow` class, and the
      // className on this node must stay CONSTANT. Under
      // `jsxImportSource: 'nativewind'` every element renders through
      // cssInterop; on this node a className that CHANGES ends up handing the
      // plain host View a Reanimated animated style, whose dev-only
      // `_requiresAnimatedComponent` getter throws "trying to pass an animated
      // style to a non-animated component" as soon as it is read. `live` flips
      // exactly when capture starts, so in a dev build the Record screen died
      // on the first frame of every recording and took the running capture with
      // it. Bisected on an Android emulator 2026-09-05: conditional
      // `shadow-glow` throws; the SAME className held constant does not, with
      // or without `shadow-glow`; and toggling the identical glow through the
      // inline style below does not. Release builds never throw — that getter
      // exists only under __DEV__ — which is why no vet hit it and Sentry saw
      // nothing. (Other conditional `shadow-glow` sites — StatusBadge,
      // PatientSlotCard, RecorderLiveReadout — did not reproduce it, so treat
      // this as the node-specific hazard it was measured to be, not a blanket
      // rule about conditional classNames.)
      className="flex-row items-center justify-center my-3 rounded-card"
      style={{
        height: containerHeight,
        // Mirrors tailwind.config.js theme.extend.boxShadow.glow — keep in sync.
        ...(live ? { boxShadow: '0 0 16px rgba(13,135,117,0.35)' } : null),
      }}
      accessibilityLabel="Audio recording waveform"
      accessibilityRole="image"
    >
      <BreathingRing active={live} />
      {Array.from({ length: barCount }).map((_, i) => (
        <WaveBar
          key={`wave-bar-${i}`}
          index={i}
          barCount={barCount}
          isActive={isActive}
          barWidth={barWidth}
          barGap={barGap}
          maxHeight={maxHeight}
          level={barLevel}
          jitter={jitterValues[i]}
        />
      ))}
    </View>
  );
});

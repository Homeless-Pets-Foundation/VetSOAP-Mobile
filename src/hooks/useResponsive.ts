import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

/** Standard phone width baseline for proportional scaling */
const BASE_WIDTH = 375;
const TABLET_BREAKPOINT = 600;
const TABLET_LG_BREAKPOINT = 800;

/** Clamp factor so scaling never shrinks/grows unreasonably */
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.4;

export function useResponsive() {
  const { width, height } = useWindowDimensions();

  // Memoized on the dimensions: the returned object (and the `scale` closure)
  // is referentially stable across renders, so memoized consumers such as the
  // slot card and the waveform do not see a fresh value every commit.
  return useMemo(() => {
    const isTablet = width >= TABLET_BREAKPOINT;
    const isTabletLg = width >= TABLET_LG_BREAKPOINT;

    /** Proportionally scale a base dp value relative to screen width */
    const scale = (base: number): number => {
      const factor = Math.min(Math.max(width / BASE_WIDTH, MIN_SCALE), MAX_SCALE);
      return Math.round(base * factor);
    };

    // Responsive icon size tiers
    const iconSm = isTabletLg ? 24 : isTablet ? 22 : 20;
    const iconMd = isTabletLg ? 32 : isTablet ? 28 : 24;
    const iconLg = isTabletLg ? 64 : isTablet ? 56 : 48;

    return {
      width,
      height,
      isTablet,
      isTabletLg,
      scale,
      iconSm,
      iconMd,
      iconLg,
    };
  }, [width, height]);
}

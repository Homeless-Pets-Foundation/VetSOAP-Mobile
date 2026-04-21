// -30 dBFS in linear amplitude: 10^(-30/20) ≈ 0.0316.
// Conservative enough to skip only very quiet regions (room tone, breath pauses) without
// clipping soft speech like a whispered intro. Matches the "Conservative" default the user
// picked when this feature was scoped.
export const SILENCE_THRESHOLD_LINEAR = 0.0316;

export interface SilenceBounds {
  start: number;
  end: number;
}

/**
 * Find the first and last indices in `peaks` whose amplitude is above the silence threshold,
 * converted back to seconds. Returns null if the entire clip is silent (don't auto-trim — we
 * have nothing signal-bearing to keep).
 *
 * `peaks` is expected to be in 0..1 linear amplitude as produced by `extractWaveformPeaks`.
 */
export function detectSilenceBounds(
  peaks: number[],
  duration: number,
  threshold: number = SILENCE_THRESHOLD_LINEAR
): SilenceBounds | null {
  const n = peaks.length;
  if (n === 0 || duration <= 0) return null;

  let first = 0;
  while (first < n && peaks[first] < threshold) first++;
  if (first >= n) return null;

  let last = n - 1;
  while (last > first && peaks[last] < threshold) last--;

  return {
    start: (first / n) * duration,
    end: ((last + 1) / n) * duration,
  };
}

/**
 * Pure metering helpers shared by the live waveform and its readout.
 *
 * RN-free on purpose: the waveform derives every bar's height from ONE
 * normalized level on the UI thread (Reanimated worklet), so the dB→0..1 step
 * has to be a plain function the JS side can run once per sample.
 */

/** Quietest level the waveform still shows movement for (dBFS). */
export const METERING_MIN_DB = -60;
/** Full-scale level (dBFS). */
export const METERING_MAX_DB = 0;

/**
 * Map a metering sample in dBFS to a 0..1 level. Anything below
 * `METERING_MIN_DB` (including the -160 "no signal" sentinel) is 0; anything
 * at or above full scale is 1; a non-finite input fails closed to 0 so a
 * broken native sample can never leave a bar stretched.
 */
export function normalizeMeteringDb(db: number | undefined | null): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  const clamped = Math.max(METERING_MIN_DB, Math.min(METERING_MAX_DB, db));
  return (clamped - METERING_MIN_DB) / (METERING_MAX_DB - METERING_MIN_DB);
}

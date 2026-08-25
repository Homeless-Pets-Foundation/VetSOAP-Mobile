/**
 * Global OS-text-scaling cap.
 *
 * Dense clinical layouts break above ~130% OS text scale. The original answer
 * was to disable font scaling per element, which froze 12–15px text outright
 * for low-vision users on exactly the screens they most need to read. The cap
 * lets everything scale up to 1.3x instead of freezing. Never disable scaling
 * again — tests/font-scaling-guard.test.mjs fences it.
 *
 * WHY this lives in a plain .ts module rather than inside the component: the
 * previous implementation monkey-patched `Text.render` / `TextInput.render` from
 * `app/_layout.tsx`. RN 0.83 exports both as plain function components with no
 * `.render` static, so the patch silently no-oped and the cap was never applied
 * — measured at 3.58x on a physical-geometry iOS simulator while
 * `tests/font-scaling-guard.test.mjs` was green, because that guard only grepped
 * for source strings. Keeping the arithmetic in an importable, side-effect-free
 * module means the guard can EXECUTE it instead of reading it.
 */

/** Hard ceiling on the OS font-scale multiplier. */
export const GLOBAL_MAX_FONT_SIZE_MULTIPLIER = 1.3;

/**
 * Resolve the cap for one element.
 *
 * A SMALLER per-element cap wins — some pills genuinely break before 1.3x. A
 * larger one does not: exceeding the ceiling is the overflow the cap exists to
 * prevent, and a caller cannot opt out by asking for more. Anything that is not
 * a usable positive finite number (null, 0, negative, NaN, Infinity) falls back
 * to the global cap rather than disabling scaling. RN types the prop as
 * `number | null | undefined`, so null has to be handled, not just undefined.
 */
export function resolveMaxFontSizeMultiplier(explicit?: number | null): number {
  if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit <= 0) {
    return GLOBAL_MAX_FONT_SIZE_MULTIPLIER;
  }
  return Math.min(explicit, GLOBAL_MAX_FONT_SIZE_MULTIPLIER);
}

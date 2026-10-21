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
 * Ceiling for long-form READING text only: SOAP/translation markdown bodies,
 * transcript chunks, the client-email body. These are reflowing paragraphs in
 * auto-height containers, so they wrap rather than clip, and capping them at
 * 1.3x left a low-vision vet at 200% OS text reading clinical notes at 130%
 * (WCAG 1.4.4 asks for 200%). UI chrome — labels, buttons, badges, headers —
 * keeps the 1.3x ceiling, because that is where dense layouts actually break.
 * Opt-in is `scaling="reading"` on the ui/Text wrapper, and the guard fences it
 * to an allowlist of files so it cannot spread to chrome.
 */
export const READING_MAX_FONT_SIZE_MULTIPLIER = 2.0;

/** Which ceiling a Text element is capped by. Omitted = the global 1.3x cap. */
export type TextScaling = 'reading';

/**
 * Resolve the cap for one element.
 *
 * `scaling` picks the ceiling (1.3x by default, 2.0x for 'reading'). A
 * SMALLER per-element cap wins — some pills genuinely break before 1.3x. A
 * larger one does not: exceeding the ceiling is the overflow the cap exists to
 * prevent, and a caller cannot opt out by asking for more. Anything that is not
 * a usable positive finite number (null, 0, negative, NaN, Infinity) falls back
 * to the ceiling rather than disabling scaling. RN types the prop as
 * `number | null | undefined`, so null has to be handled, not just undefined.
 */
export function resolveMaxFontSizeMultiplier(
  explicit?: number | null,
  scaling?: TextScaling,
): number {
  // Only the exact 'reading' opt-in raises the ceiling; anything else (an
  // untyped JS caller, a typo) gets the global cap, never a higher one.
  const ceiling =
    scaling === 'reading' ? READING_MAX_FONT_SIZE_MULTIPLIER : GLOBAL_MAX_FONT_SIZE_MULTIPLIER;
  if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit <= 0) {
    return ceiling;
  }
  return Math.min(explicit, ceiling);
}

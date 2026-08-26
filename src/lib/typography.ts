/**
 * The app typeface.
 *
 * Inter is embedded at build time by the `expo-font` plugin (app.config.ts) and
 * applied by `src/components/ui/Text.tsx` — the same wrapper that applies the
 * font-scaling cap, because RN `<Text>` does NOT inherit `fontFamily` from a
 * parent `<View>`, so there is no styling layer above the element itself.
 *
 * HISTORY: this used to ride on a monkey-patch of `Text.render` in
 * `app/_layout.tsx`. RN 0.83 exports Text as a plain function component with no
 * `.render` static, so the patch never ran and Inter never rendered — the app
 * shipped in the system font from the day the font was embedded. The guard in
 * `tests/font-scaling-guard.test.mjs` now parses the TTF's own name table and
 * checks it against `APP_FONT_FAMILY`, so a swapped, renamed, or unregistered
 * font file fails CI instead of silently falling back to the system face.
 *
 * The file is a VARIABLE font with a `wght` axis (100–900, 9 named instances).
 * That matters: the app uses `font-medium`/`font-semibold`/`font-bold` across
 * ~174 call sites, and a static Regular-only file would collapse all of them to
 * one weight. Verified on iOS by measuring glyph advance widths of one string at
 * four weights — 121.67 / 123.67 / 125.67 / 127.67 pt, a clean +2.00 pt per
 * step, which is real axis interpolation rather than synthetic emboldening.
 */

/** Family name as it appears in the embedded font's name table (nameID 1). */
export const APP_FONT_FAMILY = 'Inter';

/** Repo-relative path to the embedded font, as registered in app.config.ts. */
export const APP_FONT_ASSET = 'assets/fonts/Inter.ttf';

import type { GestureResponderEvent } from 'react-native';

export const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 } as const;

export const TOUCH_TARGET = 'min-h-[44px]';

/**
 * Measured-width headroom for the Android "Bold text" overrun (CLAUDE.md > UI Gotchas).
 *
 * With `Configuration.fontWeightAdjustment=300`, Yoga measures a <Text> with the
 * UNADJUSTED font and fixes its height at one line; Android then paints every glyph
 * wider, the run overruns, and whatever falls past the box is laid out out of view
 * with no ellipsis. Only labels with no width slack are affected, so the fix is slack.
 *
 * Use on a label that must shrink-wrap. A label that can take real width should get
 * `flex-1` (row child) or `w-full` (centred column child) instead — that is strictly
 * better, because it removes the overrun rather than absorbing it.
 */
export const CLIP_SAFE = { flexShrink: 0, paddingRight: 2 } as const;

/**
 * Appends the trailing space that pairs with {@link CLIP_SAFE}. It is load-bearing —
 * it widens the measured box so the bold overrun cannot reach a wrap point. A bare
 * literal here reads as lint debris and gets "cleaned up"; the call carries the reason.
 *
 * Never pass the result to `accessibilityLabel` — screen readers should get the
 * unpadded string.
 */
export function clipSafe(label: string) {
  return `${label} `;
}

type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]) {
  return values.filter(Boolean).join(' ');
}

export function reportUiCallbackError(scope: string, error: unknown) {
  if (__DEV__) {
    console.error(`[UI] ${scope} failed:`, error);
  }
}

export function runMaybeAsync(
  scope: string,
  callback: (() => void | Promise<void>) | undefined
) {
  if (!callback) return;
  try {
    const result = callback();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((error) => reportUiCallbackError(scope, error));
    }
  } catch (error) {
    reportUiCallbackError(scope, error);
  }
}

export function runMaybeAsyncEvent(
  scope: string,
  callback: ((event: GestureResponderEvent) => void | Promise<void>) | undefined,
  event: GestureResponderEvent
) {
  if (!callback) return;
  try {
    const result = callback(event);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((error) => reportUiCallbackError(scope, error));
    }
  } catch (error) {
    reportUiCallbackError(scope, error);
  }
}

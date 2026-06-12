import type { GestureResponderEvent } from 'react-native';

export const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 } as const;

export const TOUCH_TARGET = 'min-h-[44px]';

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

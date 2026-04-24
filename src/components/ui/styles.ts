import type { GestureResponderEvent } from 'react-native';

export const UI_COLORS = {
  brand: '#0d8775',
  brandDark: '#095e53',
  stone: '#78716c',
  stoneDark: '#1c1917',
  stoneMuted: '#a8a29e',
  danger: '#dc2626',
  warning: '#b45309',
  success: '#15803d',
  info: '#1d4ed8',
  white: '#fff',
} as const;

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

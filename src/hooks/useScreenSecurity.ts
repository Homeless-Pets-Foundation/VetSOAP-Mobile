import { useEffect } from 'react';
import * as ScreenCapture from 'expo-screen-capture';

/**
 * Prevents screenshots and screen recording on screens with sensitive data.
 *
 * Uses expo-screen-capture which leverages:
 * - Android: FLAG_SECURE on the window
 * - iOS: Prevents screen capture APIs
 *
 * For screens displaying patient health information (SOAP notes),
 * this is a HIPAA best practice.
 */
export function useScreenSecurity(enabled = true) {
  useEffect(() => {
    if (!enabled || __DEV__) return;

    ScreenCapture.preventScreenCaptureAsync().catch(() => {});

    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, [enabled]);
}

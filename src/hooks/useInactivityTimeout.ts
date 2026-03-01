import { useEffect, useRef, useCallback } from 'react';
import { PanResponder, AppState } from 'react-native';
import type { AppStateStatus, GestureResponderEvent } from 'react-native';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface UseInactivityTimeoutOptions {
  timeoutMs?: number;
  onTimeout: () => void;
  enabled?: boolean;
}

/**
 * Tracks user activity and triggers a callback after inactivity.
 *
 * Activity is detected via:
 * - Touch/gesture events (via PanResponder)
 * - App returning to foreground
 *
 * Use this to sign users out after extended inactivity (HIPAA best practice
 * for apps handling patient health information).
 */
export function useInactivityTimeout({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onTimeout,
  enabled = true,
}: UseInactivityTimeoutOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef(Date.now());

  const resetTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    if (enabled) {
      timerRef.current = setTimeout(onTimeout, timeoutMs);
    }
  }, [timeoutMs, onTimeout, enabled]);

  // Track app state changes
  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === 'active') {
        // Check if we've been inactive too long while backgrounded
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= timeoutMs) {
          onTimeout();
        } else {
          resetTimer();
        }
      } else if (state === 'background') {
        // Pause the timer; we'll check elapsed time on resume
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => subscription.remove();
  }, [resetTimer, timeoutMs, onTimeout]);

  // Start timer on mount
  useEffect(() => {
    resetTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [resetTimer]);

  // PanResponder to detect user touches
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => {
        resetTimer();
        return false; // Don't capture - just observe
      },
      onMoveShouldSetPanResponderCapture: () => {
        resetTimer();
        return false;
      },
    })
  ).current;

  return {
    panHandlers: panResponder.panHandlers,
    resetTimer,
  };
}

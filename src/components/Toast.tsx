import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ToastProps {
  message: string;
  visible: boolean;
  /** Called after the auto-dismiss timer elapses so the parent can hide it. */
  onHide: () => void;
  durationMs?: number;
}

/** Longer messages get more read time; short ones stay snappy. */
function defaultDurationMs(message: string): number {
  return Math.min(4000, 1500 + message.length * 30);
}

/**
 * Lightweight transient toast. Reuses the toast.bg/fg tokens (dark-mode aware)
 * and auto-dismisses. Mount it (visible) and provide onHide to unmount.
 */
export function Toast({ message, visible, onHide, durationMs }: ToastProps) {
  const insets = useSafeAreaInsets();
  const effectiveDuration = durationMs ?? defaultDurationMs(message);

  // Latest-callback ref: callers pass inline onHide closures whose identity
  // changes every parent render (UploadOverlay re-renders on each progress
  // tick), and depending on it restarted this timer continually — a success
  // toast could stay pinned for an entire long upload instead of
  // auto-dismissing (Codex P2, PR #143).
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => onHideRef.current(), effectiveDuration);
    return () => clearTimeout(id);
  }, [visible, effectiveDuration]);

  // accessibilityLiveRegion is Android-only, so announce explicitly on iOS.
  // Android must NOT also announce here or TalkBack speaks every toast twice.
  useEffect(() => {
    if (Platform.OS === 'ios' && visible && message) {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [visible, message]);

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      exiting={FadeOutDown.duration(200)}
      pointerEvents="none"
      style={{
        position: 'absolute',
        // Clear the home-indicator / gesture-nav area instead of overlapping it.
        bottom: Math.max(48, insets.bottom + 16),
        alignSelf: 'center',
        maxWidth: '85%',
        zIndex: 50,
      }}
      className="bg-toast-bg rounded-pill px-5 py-3 shadow-card-md"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text className="text-body-sm font-semibold text-toast-fg text-center">
        {message}
      </Text>
    </Animated.View>
  );
}

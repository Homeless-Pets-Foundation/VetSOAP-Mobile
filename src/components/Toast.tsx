import React, { useEffect } from 'react';
import { Text, StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

interface ToastProps {
  message: string;
  visible: boolean;
  /** Called after the auto-dismiss timer elapses so the parent can hide it. */
  onHide: () => void;
  durationMs?: number;
}

/**
 * Lightweight transient toast. Reuses the toast.bg/fg tokens (dark-mode aware)
 * and auto-dismisses. Mount it (visible) and provide onHide to unmount.
 */
export function Toast({ message, visible, onHide, durationMs = 2000 }: ToastProps) {
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(onHide, durationMs);
    return () => clearTimeout(id);
  }, [visible, durationMs, onHide]);

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      exiting={FadeOutDown.duration(200)}
      pointerEvents="none"
      style={[styles.wrap]}
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

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    maxWidth: '85%',
    zIndex: 50,
  },
});

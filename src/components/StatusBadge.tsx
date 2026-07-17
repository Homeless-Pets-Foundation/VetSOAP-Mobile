import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import type { RecordingStatus } from '../types';
import { useThemeColors } from '../hooks/useThemeColors';

type BadgeVariant = 'info' | 'warning' | 'success' | 'danger';

const STATUS_CONFIG: Record<RecordingStatus, { label: string; variant: BadgeVariant; inProgress?: boolean }> = {
  draft: { label: 'Not Submitted', variant: 'warning' },
  uploading: { label: 'Uploading', variant: 'info', inProgress: true },
  uploaded: { label: 'Uploaded', variant: 'info' },
  transcribing: { label: 'Transcribing', variant: 'warning', inProgress: true },
  transcribed: { label: 'Transcribed', variant: 'warning' },
  generating: { label: 'Generating', variant: 'success', inProgress: true },
  retry_scheduled: { label: 'Retry Scheduled', variant: 'warning', inProgress: true },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  pending_metadata: { label: 'Awaiting Details', variant: 'warning' },
};

const variantClasses: Record<BadgeVariant, { bg: string; text: string }> = {
  info: { bg: 'bg-status-info', text: 'text-status-info' },
  warning: { bg: 'bg-status-warning', text: 'text-status-warning' },
  success: { bg: 'bg-status-success', text: 'text-status-success' },
  danger: { bg: 'bg-status-danger', text: 'text-status-danger' },
};

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => { cancelAnimation(opacity); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacity is a stable Reanimated SharedValue ref
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          width: 7,
          height: 7,
          borderRadius: 3.5,
          backgroundColor: color,
          marginRight: 5,
          // Soft glow so the live state reads at a glance. shadowColor is a
          // raw value (not class-driven); dark-mode guard doesn't scan it.
          shadowColor: color,
          shadowOpacity: 0.9,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 0 },
          elevation: 3,
        },
        style,
      ]}
    />
  );
}

interface StatusBadgeProps {
  status: RecordingStatus;
}

/** Title-cased raw status for values the config doesn't know yet. */
function neutralFallback(status: string): { label: string; variant: 'info'; inProgress: false } {
  const label = status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { label, variant: 'info', inProgress: false };
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const colors = useThemeColors();
  // Unknown/future server statuses used to fall back to a pulsing
  // "Uploading" badge — actively misleading. Render them neutrally instead.
  const config = STATUS_CONFIG[status] || neutralFallback(status);
  const v = variantClasses[config.variant];
  const dotColor = {
    info: colors.statusInfoFg,
    warning: colors.statusWarningFg,
    success: colors.statusSuccessFg,
    danger: colors.statusDangerFg,
  }[config.variant];

  // In-progress states (recording/uploading/transcribing/generating) get a
  // larger badge + glow so the live state reads at a glance vs the resting
  // caption-sized badge.
  return (
    <View
      className={`rounded-badge flex-row items-center ${v.bg} ${
        config.inProgress ? 'px-2.5 py-1 shadow-glow' : 'px-2 py-0.5'
      }`}
      accessibilityLabel={`Status: ${config.label}`}
    >
      {config.inProgress && <PulsingDot color={dotColor} />}
      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph (e.g. "Uploadin"); do NOT remove. */}
      <Text
        className={`font-semibold ${config.inProgress ? 'text-body-sm' : 'text-caption'} ${v.text}`}
        style={{ flexShrink: 0, paddingRight: 2 }}
      >
        {`${config.label} `}
      </Text>
    </View>
  );
}

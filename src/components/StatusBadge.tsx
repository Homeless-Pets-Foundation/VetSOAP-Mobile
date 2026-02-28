import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import type { RecordingStatus } from '../types';

type BadgeVariant = 'info' | 'warning' | 'success' | 'danger';

const STATUS_CONFIG: Record<RecordingStatus, { label: string; variant: BadgeVariant; inProgress?: boolean }> = {
  uploading: { label: 'Uploading', variant: 'info', inProgress: true },
  uploaded: { label: 'Uploaded', variant: 'info' },
  transcribing: { label: 'Transcribing', variant: 'warning', inProgress: true },
  transcribed: { label: 'Transcribed', variant: 'warning' },
  generating: { label: 'Generating', variant: 'success', inProgress: true },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
};

const variantClasses: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  info: { bg: 'bg-info-100', text: 'text-info-700', dot: '#1d4ed8' },
  warning: { bg: 'bg-warning-100', text: 'text-warning-700', dot: '#b45309' },
  success: { bg: 'bg-success-100', text: 'text-success-700', dot: '#15803d' },
  danger: { bg: 'bg-danger-100', text: 'text-danger-700', dot: '#b91c1c' },
};

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: 5 }, style]}
    />
  );
}

interface StatusBadgeProps {
  status: RecordingStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.uploading;
  const v = variantClasses[config.variant];

  return (
    <View
      className={`px-2 py-0.5 rounded-badge flex-row items-center ${v.bg}`}
      accessibilityLabel={`Status: ${config.label}`}
    >
      {config.inProgress && <PulsingDot color={v.dot} />}
      <Text className={`text-caption font-semibold ${v.text}`}>
        {config.label}
      </Text>
    </View>
  );
}

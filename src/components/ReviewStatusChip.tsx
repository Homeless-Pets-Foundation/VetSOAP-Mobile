import React from 'react';
import { ActivityIndicator, Pressable, Text, type GestureResponderEvent } from 'react-native';
import { CheckCircle2, Circle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import type { ReviewStatus } from '../types';
import { useThemeColors } from '../hooks/useThemeColors';
import { REVIEW_STATUS_COPY } from '../constants/strings';

interface ReviewStatusChipProps {
  status: ReviewStatus;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  onPress?: (event: GestureResponderEvent) => void;
}

export function ReviewStatusChip({
  status,
  loading = false,
  disabled = false,
  className = '',
  onPress,
}: ReviewStatusChipProps) {
  const colors = useThemeColors();
  const isReviewed = status === 'reviewed';
  const Icon = isReviewed ? CheckCircle2 : Circle;
  const canPress = !!onPress && !disabled && !loading;
  const containerClass = isReviewed
    ? 'bg-status-success border-status-success'
    : 'bg-status-warning border-status-warning';
  const textClass = isReviewed ? 'text-status-success' : 'text-status-warning';
  const iconColor = isReviewed ? colors.statusSuccessFg : colors.statusWarningFg;
  const label = isReviewed ? REVIEW_STATUS_COPY.reviewed : REVIEW_STATUS_COPY.needsReview;

  return (
    <Pressable
      onPress={(event) => {
        if (!canPress || !onPress) return;
        Haptics.selectionAsync().catch(() => {});
        onPress(event);
      }}
      disabled={!canPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={isReviewed ? REVIEW_STATUS_COPY.markedReviewed : REVIEW_STATUS_COPY.markReview}
      accessibilityState={{ disabled: !canPress, busy: loading, checked: isReviewed }}
      className={`px-2.5 py-1 rounded-badge border flex-row items-center self-end ${containerClass} ${className}`}
      hitSlop={8}
    >
      {loading ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <Icon color={iconColor} size={13} strokeWidth={2.4} />
      )}
      <Text
        className={`text-caption font-semibold ml-1 ${textClass}`}
        numberOfLines={1}
        // flexShrink:0 + paddingRight stops Android clipping the single-word "Reviewed" label in this self-end flex-row chip
        style={{ flexShrink: 0, paddingRight: 2 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

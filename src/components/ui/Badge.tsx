import React from 'react';
import { View, Text } from 'react-native';

type BadgeVariant = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface BadgeProps {
  children: string;
  variant?: BadgeVariant;
  accessibilityLabel?: string;
}

const variantClasses: Record<BadgeVariant, { bg: string; text: string }> = {
  brand: { bg: 'bg-brand-100 dark:bg-surface-sunken', text: 'text-brand-700 dark:text-brand-500' },
  success: { bg: 'bg-status-success', text: 'text-status-success' },
  warning: { bg: 'bg-status-warning', text: 'text-status-warning' },
  danger: { bg: 'bg-status-danger', text: 'text-status-danger' },
  info: { bg: 'bg-status-info', text: 'text-status-info' },
  neutral: { bg: 'bg-surface-sunken', text: 'text-content-secondary' },
};

export function Badge({ children, variant = 'neutral', accessibilityLabel }: BadgeProps) {
  const v = variantClasses[variant];

  return (
    <View
      className={`px-2 py-0.5 rounded-badge ${v.bg}`}
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityRole="text"
    >
      <Text className={`text-caption font-semibold ${v.text}`} numberOfLines={1}>{children}</Text>
    </View>
  );
}

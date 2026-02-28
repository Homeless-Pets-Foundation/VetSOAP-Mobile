import React from 'react';
import { View, Text } from 'react-native';

type BadgeVariant = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface BadgeProps {
  children: string;
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, { bg: string; text: string }> = {
  brand: { bg: 'bg-brand-100', text: 'text-brand-700' },
  success: { bg: 'bg-success-100', text: 'text-success-700' },
  warning: { bg: 'bg-warning-100', text: 'text-warning-700' },
  danger: { bg: 'bg-danger-100', text: 'text-danger-700' },
  info: { bg: 'bg-info-100', text: 'text-info-700' },
  neutral: { bg: 'bg-stone-100', text: 'text-stone-600' },
};

export function Badge({ children, variant = 'neutral' }: BadgeProps) {
  const v = variantClasses[variant];

  return (
    <View className={`px-2 py-0.5 rounded-badge ${v.bg}`}>
      <Text className={`text-caption font-semibold ${v.text}`}>{children}</Text>
    </View>
  );
}

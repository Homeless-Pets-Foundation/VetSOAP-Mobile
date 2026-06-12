import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { X, type LucideIcon } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';
import { useThemeColors } from '../../hooks/useThemeColors';

export type BannerVariant = 'info' | 'warning' | 'error';

const VARIANT_CLASSES: Record<
  BannerVariant,
  { container: string; text: string; ctaText: string }
> = {
  info: {
    container: 'bg-status-info border-status-info',
    text: 'text-status-info',
    ctaText: 'text-status-info',
  },
  warning: {
    container: 'bg-status-warning border-status-warning',
    text: 'text-status-warning',
    ctaText: 'text-status-warning',
  },
  error: {
    container: 'bg-status-danger border-status-danger',
    text: 'text-status-danger',
    ctaText: 'text-status-danger',
  },
};

interface BannerProps {
  variant?: BannerVariant;
  message: string;
  icon?: LucideIcon;
  cta?: { label: string; onPress: () => void };
  dismissible?: boolean;
}

/**
 * Inline alert banner for non-blocking warnings (e.g. device-limit approaching).
 * Variants map to the same color tokens used by StatusBadge so the visual
 * vocabulary stays consistent across the app.
 *
 * Dismissal is component-local — re-shows on next mount. Persistent dismissal
 * is intentionally out of scope for v1: warnings should re-surface every
 * session so the user doesn't forget about a half-resolved problem.
 */
export function Banner({
  variant = 'warning',
  message,
  icon: Icon,
  cta,
  dismissible = false,
}: BannerProps) {
  const { iconSm } = useResponsive();
  const colors = useThemeColors();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const v = VARIANT_CLASSES[variant];
  const iconColor =
    variant === 'info'
      ? colors.statusInfoFg
      : variant === 'warning'
        ? colors.statusWarningFg
        : colors.statusDangerFg;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className={`flex-row items-center rounded-card border px-3 py-3 ${v.container}`}
      accessibilityRole="alert"
      accessibilityLabel={message}
    >
      {Icon ? (
        <View className="mr-2">
          <Icon color={iconColor} size={iconSm} />
        </View>
      ) : null}
      <View className="flex-1">
        <Text className={`text-body-sm ${v.text}`}>{message}</Text>
      </View>
      {cta ? (
        <Pressable
          onPress={cta.onPress}
          accessibilityRole="button"
          accessibilityLabel={cta.label}
          hitSlop={8}
          className="ml-2"
        >
          <Text className={`text-body-sm font-semibold ${v.ctaText}`}>{cta.label}</Text>
        </Pressable>
      ) : null}
      {dismissible ? (
        <Pressable
          onPress={() => setDismissed(true)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
          className="ml-2"
        >
          <X color={iconColor} size={iconSm} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

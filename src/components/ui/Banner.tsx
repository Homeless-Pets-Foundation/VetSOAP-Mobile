import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { X, type LucideIcon } from 'lucide-react-native';
import { useResponsive } from '../../hooks/useResponsive';
import { useThemeColors } from '../../hooks/useThemeColors';
import { HIT_SLOP } from './styles';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Canonical variant vocabulary is `info | success | warning | danger`
 * (matching Badge/StatusBadge — WP31 convergence). `error` is a legacy
 * alias for `danger` kept so existing call sites need no migration.
 */
export type BannerVariant = 'info' | 'success' | 'warning' | 'danger' | 'error';

const VARIANT_CLASSES: Record<
  Exclude<BannerVariant, 'error'>,
  { container: string; text: string; ctaText: string }
> = {
  info: {
    container: 'bg-status-info border-status-info',
    text: 'text-status-info',
    ctaText: 'text-status-info',
  },
  success: {
    container: 'bg-status-success border-status-success',
    text: 'text-status-success',
    ctaText: 'text-status-success',
  },
  warning: {
    container: 'bg-status-warning border-status-warning',
    text: 'text-status-warning',
    ctaText: 'text-status-warning',
  },
  danger: {
    container: 'bg-status-danger border-status-danger',
    text: 'text-status-danger',
    ctaText: 'text-status-danger',
  },
};

function resolveVariant(variant: BannerVariant): Exclude<BannerVariant, 'error'> {
  return variant === 'error' ? 'danger' : variant;
}

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
  const ctaScale = useSharedValue(1);
  const ctaAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: ctaScale.value }] }));
  if (dismissed) return null;

  const resolved = resolveVariant(variant);
  const v = VARIANT_CLASSES[resolved];
  const iconColor =
    resolved === 'info'
      ? colors.statusInfoFg
      : resolved === 'success'
        ? colors.statusSuccessFg
        : resolved === 'warning'
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
        <AnimatedPressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            cta.onPress();
          }}
          onPressIn={() => {
            ctaScale.value = withSpring(0.96, { damping: 15, stiffness: 300 });
          }}
          onPressOut={() => {
            ctaScale.value = withSpring(1, { damping: 15, stiffness: 300 });
          }}
          accessibilityRole="button"
          accessibilityLabel={cta.label}
          hitSlop={HIT_SLOP}
          className="ml-2 justify-center min-h-[44px]"
          style={ctaAnimStyle}
        >
          {/* Trailing space + flexShrink:0 — Android under-measures single-word
              Text ("Manage", "Retry") in flex-rows and clips the last glyph;
              fixing it here covers every Banner call site. Do NOT remove. */}
          <Text
            className={`text-body-sm font-semibold ${v.ctaText}`}
            style={{ flexShrink: 0, paddingRight: 2 }}
          >
            {`${cta.label} `}
          </Text>
        </AnimatedPressable>
      ) : null}
      {dismissible ? (
        <Pressable
          onPress={() => setDismissed(true)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={HIT_SLOP}
          className="ml-2 justify-center min-h-[44px]"
        >
          <X color={iconColor} size={iconSm} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

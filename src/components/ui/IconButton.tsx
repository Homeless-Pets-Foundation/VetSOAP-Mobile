import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useThemeColors } from '../../hooks/useThemeColors';
import { cx, HIT_SLOP, runMaybeAsyncEvent } from './styles';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type IconButtonVariant = 'ghost' | 'secondary' | 'danger' | 'primary';
type IconButtonSize = 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<PressableProps, 'children' | 'style' | 'onPress'> {
  icon: React.ReactNode;
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  haptic?: boolean;
  className?: string;
  onPress?: (event: GestureResponderEvent) => void | Promise<void>;
}

const variantClasses: Record<IconButtonVariant, string> = {
  ghost: 'bg-transparent',
  secondary: 'bg-surface-raised border border-border-strong',
  danger: 'bg-status-danger border border-status-danger',
  primary: 'bg-brand-500',
};

const sizeClasses: Record<IconButtonSize, string> = {
  sm: 'w-9 h-9',
  md: 'w-11 h-11',
  lg: 'w-12 h-12',
};

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  loading = false,
  haptic = true,
  disabled,
  className,
  onPress,
  ...rest
}: IconButtonProps) {
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const isDisabled = disabled || loading;
  const spinnerColors: Record<IconButtonVariant, string> = {
    ghost: colors.contentPrimary,
    secondary: colors.contentPrimary,
    danger: colors.statusDangerFg,
    primary: colors.contentOnBrand,
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = (event: GestureResponderEvent) => {
    if (haptic) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    runMaybeAsyncEvent('IconButton onPress', onPress, event);
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      disabled={isDisabled}
      hitSlop={HIT_SLOP}
      pressRetentionOffset={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      className={cx(
        'items-center justify-center rounded-full',
        sizeClasses[size],
        variantClasses[variant],
        isDisabled && 'opacity-50',
        className
      )}
      style={animatedStyle}
      {...rest}
    >
      {loading ? <ActivityIndicator color={spinnerColors[variant]} size="small" /> : icon}
    </AnimatedPressable>
  );
}

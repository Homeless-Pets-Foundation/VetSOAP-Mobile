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
import { cx, HIT_SLOP, runMaybeAsyncEvent, UI_COLORS } from './styles';

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
  secondary: 'bg-white border border-stone-300',
  danger: 'bg-danger-50 border border-danger-100',
  primary: 'bg-brand-500',
};

const spinnerColors: Record<IconButtonVariant, string> = {
  ghost: UI_COLORS.stoneDark,
  secondary: UI_COLORS.stoneDark,
  danger: UI_COLORS.danger,
  primary: UI_COLORS.white,
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
  const scale = useSharedValue(1);
  const isDisabled = disabled || loading;

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

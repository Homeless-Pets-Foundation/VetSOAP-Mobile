import React from 'react';
import { Pressable, Text, View, ActivityIndicator, type PressableProps, type GestureResponderEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { cx, HIT_SLOP, runMaybeAsyncEvent } from './styles';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'dangerGhost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<PressableProps, 'style' | 'children' | 'onPress'> {
  children: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  haptic?: boolean;
  icon?: React.ReactNode;
  className?: string;
  onPress?: (event: GestureResponderEvent) => void | Promise<void>;
}

const variantClasses: Record<ButtonVariant, { container: string; text: string }> = {
  primary: {
    container: 'bg-brand-500',
    text: 'text-white',
  },
  secondary: {
    container: 'bg-white border border-stone-300',
    text: 'text-stone-700',
  },
  danger: {
    container: 'bg-danger-500',
    text: 'text-white',
  },
  ghost: {
    container: 'bg-transparent',
    text: 'text-stone-700',
  },
  dangerGhost: {
    container: 'bg-transparent',
    text: 'text-danger-600',
  },
};

const sizeClasses: Record<ButtonSize, { container: string; text: string }> = {
  sm: { container: 'px-3 py-2', text: 'text-body-sm font-semibold' },
  md: { container: 'px-5 py-3', text: 'text-body font-semibold' },
  lg: { container: 'px-6 py-4', text: 'text-body-lg font-semibold' },
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  haptic = true,
  icon,
  disabled,
  onPress,
  accessibilityLabel,
  className,
  ...rest
}: ButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 300 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 300 });
  };

  const handlePress = (e: GestureResponderEvent) => {
    if (haptic) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    runMaybeAsyncEvent('Button onPress', onPress, e);
  };

  const v = variantClasses[variant];
  const s = sizeClasses[size];

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
      hitSlop={HIT_SLOP}
      pressRetentionOffset={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || children}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      className={cx(
        'rounded-btn items-center justify-center flex-row min-h-[44px]',
        variant !== 'ghost' && variant !== 'dangerGhost' && 'shadow-btn',
        v.container,
        s.container,
        (disabled || loading) && 'opacity-50',
        className
      )}
      style={animatedStyle}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'secondary' || variant === 'ghost' ? '#44403c' : variant === 'dangerGhost' ? '#dc2626' : '#fff'}
          size="small"
        />
      ) : (
        <>
          {icon && <View className="mr-2">{icon}</View>}
          <Text className={`${v.text} ${s.text}`}>{children}</Text>
        </>
      )}
    </AnimatedPressable>
  );
}

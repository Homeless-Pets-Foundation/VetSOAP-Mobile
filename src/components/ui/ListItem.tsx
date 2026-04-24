import React from 'react';
import { Pressable, Text, View, type GestureResponderEvent, type PressableProps } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ChevronRight } from 'lucide-react-native';
import { cx, HIT_SLOP, runMaybeAsyncEvent } from './styles';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ListItemProps extends Omit<PressableProps, 'children' | 'style' | 'onPress'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  badge?: React.ReactNode;
  showChevron?: boolean;
  disabled?: boolean;
  haptic?: boolean;
  className?: string;
  contentClassName?: string;
  titleClassName?: string;
  subtitleClassName?: string;
  metaClassName?: string;
  onPress?: (event: GestureResponderEvent) => void | Promise<void>;
}

function renderText(value: React.ReactNode, className: string, numberOfLines = 1) {
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <Text className={className} numberOfLines={numberOfLines} ellipsizeMode="tail">
        {value}
      </Text>
    );
  }
  return value;
}

export function ListItem({
  title,
  subtitle,
  meta,
  leading,
  trailing,
  badge,
  showChevron = false,
  disabled = false,
  haptic = true,
  className,
  contentClassName,
  titleClassName,
  subtitleClassName,
  metaClassName,
  onPress,
  accessibilityLabel,
  ...rest
}: ListItemProps) {
  const scale = useSharedValue(1);
  const canPress = !!onPress && !disabled;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = (event: GestureResponderEvent) => {
    if (haptic) {
      Haptics.selectionAsync().catch(() => {});
    }
    runMaybeAsyncEvent('ListItem onPress', onPress, event);
  };

  const body = (
    <View className="flex-row items-center">
      {leading ? <View className="mr-3">{leading}</View> : null}
      <View className={cx('flex-1 mr-3', contentClassName)}>
        <View className="flex-row items-center">
          <View className="shrink flex-1">
            {renderText(title, cx('text-body font-semibold text-stone-900', titleClassName))}
          </View>
          {badge ? <View className="ml-2">{badge}</View> : null}
        </View>
        {subtitle ? (
          <View className="mt-0.5">
            {renderText(subtitle, cx('text-body-sm text-stone-500', subtitleClassName), 2)}
          </View>
        ) : null}
        {meta ? (
          <View className="mt-1">
            {renderText(meta, cx('text-caption text-stone-500', metaClassName))}
          </View>
        ) : null}
      </View>
      {trailing ? <View>{trailing}</View> : null}
      {showChevron ? <ChevronRight color="#a8a29e" size={18} /> : null}
    </View>
  );

  if (!onPress) {
    return (
      <Animated.View
        className={cx('card mb-2', disabled && 'opacity-50', className)}
        accessibilityLabel={accessibilityLabel}
        style={animatedStyle}
        {...rest}
      >
        {body}
      </Animated.View>
    );
  }

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => {
        if (canPress) scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      disabled={!canPress}
      hitSlop={HIT_SLOP}
      pressRetentionOffset={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      className={cx('card mb-2', disabled && 'opacity-50', className)}
      style={animatedStyle}
      {...rest}
    >
      {body}
    </AnimatedPressable>
  );
}

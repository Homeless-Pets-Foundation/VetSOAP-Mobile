import React from 'react';
import { Pressable, View, type GestureResponderEvent, type PressableProps } from 'react-native';
import { Text } from './Text';
import * as Haptics from 'expo-haptics';
import { ChevronRight } from 'lucide-react-native';
import { useThemeColors } from '../../hooks/useThemeColors';
import { cx, HIT_SLOP, runMaybeAsyncEvent } from './styles';

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
  /** Attention rows pass 3 — their descriptions ellipsized mid-sentence at 2. */
  subtitleNumberOfLines?: number;
  onPress?: (event: GestureResponderEvent) => void | Promise<void>;
}

// Only a string/number title gets numberOfLines here; a ReactNode title passes through
// untouched. Today that is safe because every slot below sits in a box with real width
// (`shrink flex-1`, or a full-width column), which is what keeps the Android "Bold text"
// overrun from having anywhere to wrap (CLAUDE.md > UI Gotchas). The invariant is
// implicit, so: do not add `items-center` to those wrappers, and if a ReactNode title
// ever needs to shrink-wrap, give it CLIP_SAFE at its own site.
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
  subtitleNumberOfLines = 2,
  onPress,
  accessibilityLabel,
  ...rest
}: ListItemProps) {
  const colors = useThemeColors();
  const canPress = !!onPress && !disabled;

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
            {renderText(title, cx('text-body font-semibold text-content-primary', titleClassName))}
          </View>
          {/* flexShrink:0 — the title beside it is the flexible one, so a badge
              must never be compressed into an ellipsis by a long title. */}
          {badge ? (
            <View className="ml-2" style={{ flexShrink: 0 }}>
              {badge}
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <View className="mt-0.5">
            {renderText(
              subtitle,
              cx('text-body-sm text-content-tertiary', subtitleClassName),
              subtitleNumberOfLines
            )}
          </View>
        ) : null}
        {meta ? (
          <View className="mt-1">
            {renderText(meta, cx('text-caption text-content-tertiary', metaClassName))}
          </View>
        ) : null}
      </View>
      {/* flexShrink:0 — mirrors the badge slot above. Every consumer passes an icon or
          a Toggle today, so nothing is exposed yet; the moment one passes a Text, the
          content column beside it is flex-1 and would squeeze this to nothing. */}
      {trailing ? <View style={{ flexShrink: 0 }}>{trailing}</View> : null}
      {showChevron ? <ChevronRight color={colors.contentTertiary} size={18} /> : null}
    </View>
  );

  if (!onPress) {
    return (
      <View
        className={cx('card mb-2', disabled && 'opacity-50', className)}
        accessibilityLabel={accessibilityLabel}
        {...rest}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={!canPress}
      hitSlop={HIT_SLOP}
      pressRetentionOffset={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      className={cx('card mb-2', disabled && 'opacity-50', className)}
      style={({ pressed }) => ({ opacity: pressed && canPress ? 0.96 : 1 })}
      {...rest}
    >
      {body}
    </Pressable>
  );
}

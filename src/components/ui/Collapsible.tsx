import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ChevronDown } from 'lucide-react-native';
import { Text } from './Text';
import { useThemeColors } from '../../hooks/useThemeColors';
import { CLIP_SAFE, clipSafe, cx, HIT_SLOP, TOUCH_TARGET } from './styles';

/**
 * Controlled disclosure row: header (leading · title/headline · badge · chevron)
 * over a body that is mounted only while expanded.
 *
 * Extracted for the home layout reorg (2026-09-02) — the app had nine bespoke
 * expand affordances and no reusable one. Modelled on
 * `SoapNoteView.AccordionSection` (reanimated chevron, `accessibilityState`),
 * minus the edit state and accent tint. Deliberately container-less: callers
 * wrap it in their own `Card` so one card can hold the header and the body.
 *
 * - No `LayoutAnimation` (Android jank under Fabric) and no `FadeIn` on the body
 *   (Home renders this inside a long ScrollView on weak tablets).
 * - Unmounting the body on collapse is what resets nested rows for free.
 * - `headline` is a caption (≤2 lines) for a long summary; `badge` is a short pill
 *   ("5 suggestions", "269 rec") and carries the bold-text headroom mitigation.
 */
interface CollapsibleProps {
  /** Icon circle rendered before the title. */
  leading?: React.ReactNode;
  title: string;
  /** Shown under the title only while expanded (explanatory copy). */
  subtitle?: string;
  /** Summary caption under the title (visible collapsed and expanded); wraps to two lines. */
  headline?: string;
  /** Short pill to the right of the title. Multi-token allowed; it never wraps. */
  badge?: string;
  expanded: boolean;
  onToggle: () => void;
  /** Unpadded. Defaults to the title (plus headline when present). */
  accessibilityLabel?: string;
  /** Always-visible content between the header and the body (a progress bar, a count line). */
  belowHeader?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Nested rows use the body type scale instead of the card heading. */
  compact?: boolean;
  children: React.ReactNode;
}

export function Collapsible({
  leading,
  title,
  subtitle,
  headline,
  badge,
  expanded,
  onToggle,
  accessibilityLabel,
  belowHeader,
  className,
  bodyClassName,
  compact = false,
  children,
}: CollapsibleProps) {
  const colors = useThemeColors();
  const rotation = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 1 : 0, { duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rotation is a stable Reanimated SharedValue ref
  }, [expanded]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 180}deg` }],
  }));

  const label = accessibilityLabel ?? (headline ? `${title}. ${headline}` : title);

  return (
    <View className={className}>
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={label}
        hitSlop={HIT_SLOP}
        className={cx('flex-row items-center', TOUCH_TARGET)}
      >
        {leading ? (
          <View className="mr-3" style={{ flexShrink: 0 }}>
            {leading}
          </View>
        ) : null}
        <View className="flex-1">
          {/* w-full + numberOfLines={1} — the column is flex-1, but a Text child
              still shrink-wraps its measured width, and Android "Bold text" then
              drops the trailing word (CLAUDE.md > UI Gotchas). Two literal
              classNames rather than one computed string so ui-clip-guard can see
              the mitigation. */}
          {compact ? (
            <Text className="text-body-sm font-semibold text-content-primary w-full" numberOfLines={1}>
              {title}
            </Text>
          ) : (
            <Text className="text-heading font-bold text-content-primary w-full" numberOfLines={1}>
              {title}
            </Text>
          )}
          {headline ? (
            // Two lines, not one: the Clinic Quality summary ellipsized at
            // "7 min t…" on a 411 dp phone. Every number stays visible.
            <Text className="text-caption text-content-tertiary mt-0.5 w-full" numberOfLines={2}>
              {headline}
            </Text>
          ) : null}
          {expanded && subtitle ? (
            <Text className="text-caption text-content-tertiary mt-0.5 w-full">{subtitle}</Text>
          ) : null}
        </View>
        {badge ? (
          <View className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5" style={{ flexShrink: 0 }}>
            {/* clipSafe + CLIP_SAFE — this pill shrink-wraps by design. The
                accessibilityLabel above stays unpadded. */}
            <Text
              className="text-caption font-semibold text-content-secondary"
              style={CLIP_SAFE}
              numberOfLines={1}
            >
              {clipSafe(badge)}
            </Text>
          </View>
        ) : null}
        <Animated.View className="ml-2" style={[chevronStyle, { flexShrink: 0 }]}>
          <ChevronDown color={colors.contentTertiary} size={20} />
        </Animated.View>
      </Pressable>
      {belowHeader}
      {expanded ? <View className={bodyClassName}>{children}</View> : null}
    </View>
  );
}

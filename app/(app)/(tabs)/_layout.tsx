import React from 'react';
import { Alert } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Home, Mic, FileText, Users, type LucideIcon } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useAuthUser } from '../../../src/hooks/useAuth';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../src/lib/recordingPermissions';
import { useThemeColors } from '../../../src/hooks/useThemeColors';
import { Text } from '../../../src/components/ui/Text';

// Active-tab indicator (plan option a): scale + lift the focused icon on the
// brand color. No custom tabBar — just an animated tabBarIcon.
function TabBarIcon({ Icon, color, focused, size }: { Icon: LucideIcon; color: string; focused: boolean; size: number }) {
  const scale = useSharedValue(focused ? 1.15 : 1);
  React.useEffect(() => {
    scale.value = withSpring(focused ? 1.15 : 1, { damping: 15, stiffness: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scale is a stable SharedValue ref
  }, [focused]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }, { translateY: focused ? -1 : 0 }] }));
  return (
    <Animated.View style={style}>
      <Icon color={color} size={size} strokeWidth={focused ? 2.6 : 2} />
    </Animated.View>
  );
}

// React Navigation renders the tab labels itself, from the `title` screen
// options, so they reach neither of the two things src/components/ui/Text.tsx
// applies to every other string in the app: the 1.3x OS-text-scaling cap and
// Inter. The typeface half could be fixed with `tabBarLabelStyle`, but the cap
// is a PROP (`maxFontSizeMultiplier`), not a style, and bottom-tabs exposes only
// `tabBarAllowFontScaling` — a hard on/off, and disabling scaling is the exact
// regression the cap exists to undo. The render prop below is the one supported
// hook that reaches the label element, so the label goes through the wrapper.
//
// The cost of that is owning the label's styling: BottomTabItem applies its own
// per-position metrics only on the STRING branch of `tabBarLabel`. That cost is
// small here, because the `tabBarLabelStyle` this replaces was merged last and
// so ALREADY overrode both of React Navigation's sizes (labelBeneath 10,
// labelBesideUikit 13) with a single 11.

/** Deliberate exception to the semantic type scale: 11px is the
 *  platform-conventional tab-label size and four labels must fit. */
const TAB_BAR_LABEL_STYLE = { fontSize: 11, fontWeight: '600', textAlign: 'center' } as const;

/** styles.labelBeside + styles.labelBesideUikit, minus the fontSize we override.
 *  Reached on tablets (width >= 768) and in landscape, not just hypothetically. */
const TAB_BAR_LABEL_BESIDE_STYLE = { marginStart: 5, marginEnd: 12, lineHeight: 24 } as const;

function TabBarLabel({
  color,
  position,
  children,
}: {
  color: string;
  position: 'below-icon' | 'beside-icon';
  children: string;
}) {
  return (
    <Text
      // Matches React Navigation's own Label. On these one-token labels it is a
      // visible-ellipsis backstop rather than the fix (per CLAUDE.md); dropping
      // it would let a scaled label wrap to a second line and fall outside the
      // fixed tab-bar height.
      numberOfLines={1}
      style={[
        TAB_BAR_LABEL_STYLE,
        position === 'beside-icon' && TAB_BAR_LABEL_BESIDE_STYLE,
        { color },
      ]}
    >
      {children}
    </Text>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const user = useAuthUser();
  const colors = useThemeColors();

  const showRecordPermissionAlert = React.useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert(RECORD_APPOINTMENT_PERMISSION_TITLE, RECORD_APPOINTMENT_PERMISSION_MESSAGE);
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand500,
        tabBarInactiveTintColor: colors.contentTertiary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.borderDefault,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
          height: 64 + insets.bottom,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.04,
          shadowRadius: 4,
          elevation: 4,
        },
        tabBarLabel: (props) => <TabBarLabel {...props} />,
      }}
      screenListeners={{
        tabPress: () => {
          Haptics.selectionAsync().catch(() => {});
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          // Per-screen freeze (never the global react-native-screens switch, never
          // screenOptions — both would also freeze this whole tab navigator when a
          // stack screen is pushed over it mid-recording): while the
          // user is on Record, cache invalidations from finish/draft-save/
          // upload no longer re-render this tree behind it. The record tab is
          // deliberately excluded — its AppState/audio-focus/recorder effects
          // must keep committing while a recording runs from another tab.
          freezeOnBlur: true,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={Home} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'Home dashboard',
        }}
      />
      <Tabs.Screen
        name="record"
        listeners={{
          tabPress: (event) => {
            if (canRecordAppointments(user?.role)) return;
            event.preventDefault();
            showRecordPermissionAlert();
          },
        }}
        options={{
          title: 'Record',
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={Mic} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'Record new appointment',
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: 'Recordings',
          freezeOnBlur: true,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={FileText} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'View all recordings',
        }}
      />
      <Tabs.Screen
        name="patient"
        options={{
          title: 'Patients',
          freezeOnBlur: true,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={Users} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'Browse patients',
        }}
      />
    </Tabs>
  );
}

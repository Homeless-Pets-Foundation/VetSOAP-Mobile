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
import { useAuth } from '../../../src/hooks/useAuth';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../src/lib/recordingPermissions';
import { useThemeColors } from '../../../src/hooks/useThemeColors';

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

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
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
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
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
          title: 'Records',
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={FileText} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'View all recordings',
        }}
      />
      <Tabs.Screen
        name="patient"
        options={{
          title: 'Patients',
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon Icon={Users} color={color} size={size} focused={focused} />,
          tabBarAccessibilityLabel: 'Browse patients',
        }}
      />
      {/* Hide settings from tab bar */}
      <Tabs.Screen
        name="settings"
        options={{ href: null }}
      />
    </Tabs>
  );
}

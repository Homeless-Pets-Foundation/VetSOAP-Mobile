import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CloudOff } from 'lucide-react-native';
import { useAuth } from '../hooks/useAuth';
import { useThemeColors } from '../hooks/useThemeColors';
import { OFFLINE_BANNER_COPY } from '../constants/strings';

/**
 * Shown while the app runs on the cached account profile (AuthContext
 * `profileSource === 'cache'`, 1B startup resilience). Purely informational —
 * AuthProvider's NetInfo/backoff loop owns the reconnect, so there is no
 * retry CTA here. Disappears on its own when the live profile loads.
 */
export function OfflineBanner() {
  const { profileSource, deviceRegistrationPending, deviceRegistrationBlock } = useAuth();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  if (profileSource !== 'cache') return null;

  // DeviceRegistrationBanner (rendered above this one) already pads for the
  // status bar when visible; only pad for it here when this banner is topmost.
  const registrationBannerVisible = deviceRegistrationPending && !deviceRegistrationBlock;

  return (
    <View
      className="bg-status-info border-b border-status-info px-4 pb-3 flex-row items-center"
      style={{ paddingTop: registrationBannerVisible ? 12 : insets.top + 12 }}
    >
      <CloudOff size={18} color={colors.statusInfoFg} style={{ flexShrink: 0 }} />
      {/* flex-1 so the label claims row space and wraps instead of clipping (Android Text-in-flex-row gotcha) */}
      <Text className="flex-1 ml-3 text-status-info text-body-sm" numberOfLines={2}>
        {OFFLINE_BANNER_COPY.body}
      </Text>
      <ActivityIndicator size="small" color={colors.statusInfoFg} style={{ flexShrink: 0, marginLeft: 8 }} />
    </View>
  );
}

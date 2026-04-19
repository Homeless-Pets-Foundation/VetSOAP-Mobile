import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../hooks/useAuth';
import { DEVICE_REGISTRATION_BANNER_COPY } from '../constants/strings';

export function DeviceRegistrationBanner() {
  const { deviceRegistrationPending, deviceRegistrationBlock, retryDeviceRegistration } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);
  const insets = useSafeAreaInsets();

  // The hard-limit modal owns that UX — never stack the banner on top of it.
  const shouldRender = deviceRegistrationPending && !deviceRegistrationBlock;

  const handleRetry = useCallback(() => {
    if (isRetrying) return;
    Haptics.selectionAsync().catch(() => {});
    setIsRetrying(true);
    retryDeviceRegistration()
      .catch(() => false)
      .finally(() => setIsRetrying(false));
  }, [isRetrying, retryDeviceRegistration]);

  if (!shouldRender) return null;

  return (
    <View
      className="bg-amber-100 border-b border-amber-300 px-4 pb-3 flex-row items-center"
      style={{ paddingTop: insets.top + 12 }}
    >
      <AlertTriangle size={20} color="#b45309" />
      <View className="flex-1 ml-3">
        <Text className="text-amber-900 font-semibold text-sm" numberOfLines={1}>
          {DEVICE_REGISTRATION_BANNER_COPY.title}
        </Text>
        <Text className="text-amber-800 text-xs mt-0.5" numberOfLines={2}>
          {DEVICE_REGISTRATION_BANNER_COPY.body}
        </Text>
      </View>
      <Pressable
        onPress={handleRetry}
        disabled={isRetrying}
        className="ml-3 bg-amber-600 rounded-md px-3 py-2"
        style={{ opacity: isRetrying ? 0.6 : 1, flexShrink: 0 }}
      >
        {isRetrying ? (
          <ActivityIndicator color="#ffffff" size="small" />
        ) : (
          <Text
            className="text-white font-semibold text-xs"
            style={{ flexShrink: 0, paddingRight: 2 }}
          >
            {`${DEVICE_REGISTRATION_BANNER_COPY.retry} `}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

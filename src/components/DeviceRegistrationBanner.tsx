import React, { useCallback, useState } from 'react';
import { View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthDeviceRegistration } from '../hooks/useAuth';
import { useThemeColors } from '../hooks/useThemeColors';
import { Button } from './ui/Button';
import { DEVICE_REGISTRATION_BANNER_COPY } from '../constants/strings';

export function DeviceRegistrationBanner() {
  const colors = useThemeColors();
  const { deviceRegistrationPending, deviceRegistrationBlock, retryDeviceRegistration } = useAuthDeviceRegistration();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const insets = useSafeAreaInsets();

  // The hard-limit modal owns that UX — never stack the banner on top of it.
  const shouldRender = deviceRegistrationPending && !deviceRegistrationBlock;

  const handleRetry = useCallback(() => {
    if (isRetrying) return;
    Haptics.selectionAsync().catch(() => {});
    setIsRetrying(true);
    setRetryFailed(false);
    retryDeviceRegistration()
      .then((ok) => {
        // Surface failure — the swallowed .catch(() => false) left the
        // spinner stopping with zero feedback, indistinguishable from
        // nothing having happened.
        if (!ok) setRetryFailed(true);
      })
      .catch(() => setRetryFailed(true))
      .finally(() => setIsRetrying(false));
  }, [isRetrying, retryDeviceRegistration]);

  if (!shouldRender) return null;

  return (
    <View
      className="bg-status-warning border-b border-status-warning px-4 pb-3 flex-row items-center"
      style={{ paddingTop: insets.top + 12 }}
    >
      <AlertTriangle size={20} color={colors.statusWarningFg} />
      <View className="flex-1 ml-3">
        <Text className="text-status-warning font-semibold text-body-sm" numberOfLines={2}>
          {DEVICE_REGISTRATION_BANNER_COPY.title}
        </Text>
        <Text className="text-status-warning text-caption mt-0.5" numberOfLines={2}>
          {retryFailed ? DEVICE_REGISTRATION_BANNER_COPY.retryFailed : DEVICE_REGISTRATION_BANNER_COPY.body}
        </Text>
      </View>
      <View className="ml-3" style={{ flexShrink: 0 }}>
        <Button
          variant="secondary"
          size="sm"
          onPress={handleRetry}
          loading={isRetrying}
          disabled={isRetrying}
          accessibilityLabel="Retry device registration"
        >
          {DEVICE_REGISTRATION_BANNER_COPY.retry}
        </Button>
      </View>
    </View>
  );
}

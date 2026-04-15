import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, Alert, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { ChevronLeft, Smartphone, Tablet, Monitor, ShieldAlert } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useDeviceCapacity } from '../../src/hooks/useDeviceCapacity';
import { devicesApi, type DeviceSession } from '../../src/api/devices';
import { secureStorage } from '../../src/lib/secureStorage';
import { useResponsive } from '../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { SkeletonCard } from '../../src/components/ui/Skeleton';
import { Button } from '../../src/components/ui/Button';

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDeviceIcon(deviceType: string | null) {
  if (!deviceType) return Smartphone;
  if (deviceType.includes('tablet')) return Tablet;
  if (deviceType === 'web') return Monitor;
  return Smartphone;
}

function formatDeviceTypeLabel(deviceType: string | null): string {
  if (!deviceType) return 'Device';
  switch (deviceType) {
    case 'ios_tablet':
      return 'iPad';
    case 'android_tablet':
      return 'Android Tablet';
    case 'ios_phone':
      return 'iPhone';
    case 'android_phone':
      return 'Android Phone';
    case 'web':
      return 'Web Browser';
    default:
      return deviceType;
  }
}

interface DeviceRowProps {
  device: DeviceSession;
  isCurrent: boolean;
  onRevoke: () => void;
  isRevoking: boolean;
}

function DeviceRow({ device, isCurrent, onRevoke, isRevoking }: DeviceRowProps) {
  const { iconMd } = useResponsive();
  const Icon = getDeviceIcon(device.deviceType);
  const typeLabel = formatDeviceTypeLabel(device.deviceType);

  return (
    <Card className="mb-2">
      <View className="flex-row items-center">
        <View className="w-10 h-10 rounded-full bg-stone-100 justify-center items-center mr-3">
          <Icon color="#0d8775" size={iconMd} />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center">
            <Text className="text-body font-semibold text-stone-900">
              {device.deviceName || typeLabel}
            </Text>
            {isCurrent ? (
              <View className="ml-2 px-2 py-0.5 rounded-badge bg-success-100">
                <Text className="text-caption font-semibold text-success-700">
                  This device
                </Text>
              </View>
            ) : null}
          </View>
          <Text className="text-caption text-stone-500 mt-0.5">
            {typeLabel}
            {device.appVersion ? ` · v${device.appVersion}` : ''}
          </Text>
          <Text className="text-caption text-stone-400 mt-0.5">
            Last active {formatRelativeTime(device.lastSeenAt)}
          </Text>
        </View>
        {!isCurrent ? (
          <Pressable
            onPress={onRevoke}
            disabled={isRevoking}
            accessibilityRole="button"
            accessibilityLabel={`Revoke ${device.deviceName || typeLabel}`}
            hitSlop={8}
            className="ml-2 px-3 py-2"
          >
            <Text
              className={`text-body-sm font-semibold ${
                isRevoking ? 'text-stone-400' : 'text-danger-500'
              }`}
            >
              Revoke
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}

export default function DevicesScreen() {
  const router = useRouter();
  const { iconMd, iconLg } = useResponsive();
  const queryClient = useQueryClient();
  const { devices, capacity, isLoading, isError, refetch } = useDeviceCapacity();
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    secureStorage
      .getDeviceId()
      .then((id) => setCurrentDeviceId(id))
      .catch(() => {});
  }, []);

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => devicesApi.revoke(sessionId),
    onMutate: (sessionId) => {
      setRevokingId(sessionId);
    },
    onSuccess: () => {
      // Invalidate both device-sessions and recordings so the Home banner +
      // recordings list react immediately if revoke unblocks the user.
      queryClient.invalidateQueries({ queryKey: ['device-sessions'] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Could not revoke this device.';
      Alert.alert('Revoke Failed', message);
    },
    onSettled: () => {
      setRevokingId(null);
    },
  });

  const handleRevoke = useCallback(
    (device: DeviceSession) => {
      const label = device.deviceName || formatDeviceTypeLabel(device.deviceType);
      Alert.alert(
        'Revoke Device?',
        `${label} will be signed out and need to register again to access your account.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Revoke',
            style: 'destructive',
            onPress: () => {
              revokeMutation.mutate(device.id);
            },
          },
        ]
      );
    },
    [revokeMutation]
  );

  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    refetch()
      .finally(() => setIsRefreshing(false))
      .catch(() => {});
  }, [refetch]);

  const capacityRatio = capacity ? capacity.count / Math.max(1, capacity.limit) : 0;
  const barTone = capacity?.isAtLimit
    ? 'bg-danger-500'
    : capacity?.isNearLimit
      ? 'bg-warning-500'
      : 'bg-success-500';

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5">
          <View className="flex-row items-center mb-6">
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              className="mr-3 w-11 h-11 items-center justify-center"
            >
              <ChevronLeft color="#1c1917" size={iconMd} />
            </Pressable>
            <Text
              className="text-display font-bold text-stone-900"
              accessibilityRole="header"
            >
              Manage Devices
            </Text>
          </View>

          {capacity ? (
            <Card className="mb-4">
              <View className="flex-row items-baseline justify-between mb-2">
                <Text className="text-body font-semibold text-stone-900">
                  {capacity.count} of {capacity.limit} devices in use
                </Text>
                {capacity.isAtLimit ? (
                  <Text className="text-caption font-semibold text-danger-600">
                    Limit reached
                  </Text>
                ) : capacity.isNearLimit ? (
                  <Text className="text-caption font-semibold text-warning-600">
                    Approaching limit
                  </Text>
                ) : (
                  <Text className="text-caption text-stone-500">
                    {capacity.remaining} remaining
                  </Text>
                )}
              </View>
              <View className="h-2 rounded-full bg-stone-200 overflow-hidden">
                <View
                  className={`h-full ${barTone}`}
                  style={{ width: `${Math.min(100, Math.round(capacityRatio * 100))}%` }}
                />
              </View>
            </Card>
          ) : null}
        </View>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} />
          }
        >
          {isLoading ? (
            <View>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </View>
          ) : isError ? (
            <Card className="items-center py-6">
              <ShieldAlert color="#dc2626" size={iconLg} />
              <Text className="text-body text-stone-600 mt-3 text-center">
                Could not load your devices.
              </Text>
              <View className="mt-3">
                <Button variant="secondary" size="sm" onPress={() => { refetch().catch(() => {}); }}>
                  Retry
                </Button>
              </View>
            </Card>
          ) : devices.length === 0 ? (
            <Card className="items-center py-6">
              <Smartphone color="#a8a29e" size={iconLg} />
              <Text className="text-body text-stone-500 mt-3 text-center">
                No active devices.
              </Text>
            </Card>
          ) : (
            devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                isCurrent={!!currentDeviceId && device.deviceId === currentDeviceId}
                onRevoke={() => handleRevoke(device)}
                isRevoking={revokingId === device.id}
              />
            ))
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

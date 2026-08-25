import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Alert, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { ChevronLeft, Smartphone, Tablet, Monitor, ShieldAlert } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useDeviceCapacity } from '../../src/hooks/useDeviceCapacity';
import { devicesApi, type DeviceSession } from '../../src/api/devices';
import { ApiError } from '../../src/api/client';
import { secureStorage } from '../../src/lib/secureStorage';
import { useResponsive } from '../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { SkeletonCard } from '../../src/components/ui/Skeleton';
import { Button } from '../../src/components/ui/Button';
import { Badge } from '../../src/components/ui/Badge';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { IconButton } from '../../src/components/ui/IconButton';
import { ListItem } from '../../src/components/ui/ListItem';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { Toast } from '../../src/components/Toast';
import { friendlyErrorMessage } from '../../src/lib/errorCopy';
import { CLIP_SAFE, clipSafe } from '../../src/components/ui/styles';

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
  // Include the year for anything outside the current one — "Mar 5" is
  // ambiguous on exactly the stale rows users most need to revoke.
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
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
  const colors = useThemeColors();
  const Icon = getDeviceIcon(device.deviceType);
  const typeLabel = formatDeviceTypeLabel(device.deviceType);

  return (
    <ListItem
      title={device.deviceName || typeLabel}
      subtitle={`${typeLabel}${device.appVersion ? ` · v${device.appVersion}` : ''}`}
      meta={`Last active ${formatRelativeTime(device.lastSeenAt)}`}
      leading={
        <View className="w-10 h-10 rounded-full bg-surface-sunken justify-center items-center">
          <Icon color={colors.brand500} size={iconMd} />
        </View>
      }
      badge={isCurrent ? <Badge variant="success">This device</Badge> : undefined}
      trailing={
        !isCurrent ? (
          <Button
            variant="dangerGhost"
            size="sm"
            loading={isRevoking}
            onPress={onRevoke}
            accessibilityLabel={`Revoke ${device.deviceName || typeLabel}`}
          >
            Revoke
          </Button>
        ) : undefined
      }
    />
  );
}

export default function DevicesScreen() {
  const router = useRouter();
  const { iconMd, iconLg } = useResponsive();
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const { devices, capacity, isLoading, isError, refetch } = useDeviceCapacity({ mode: 'manage' });
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [mfaToastVisible, setMfaToastVisible] = useState(false);

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
      queryClient.invalidateQueries({ queryKey: ['device-sessions'] }).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        // The global MFA flow takes over; show a breadcrumb so the tap
        // doesn't appear dead if that flow is delayed.
        setMfaToastVisible(true);
        return;
      }
      if (__DEV__) console.error('[Devices] revoke failed:', error);
      Alert.alert('Revoke Failed', friendlyErrorMessage(error));
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
    ? 'bg-status-danger'
    : capacity?.isNearLimit
      ? 'bg-status-warning'
      : 'bg-status-success';

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5">
          <View className="flex-row items-center mb-6">
            <IconButton
              icon={<ChevronLeft color={colors.contentPrimary} size={iconMd} />}
              label="Go back"
              onPress={() => router.back()}
              className="mr-3"
            />
            {/* flex-1 — #171 fixed the capacity row below but not this header, which
                has the same shrink-wrapped shape and would drop "Devices"
                (CLAUDE.md > UI Gotchas). */}
            <Text
              className="text-display font-bold text-content-primary flex-1"
              accessibilityRole="header"
              numberOfLines={1}
            >
              Manage Devices
            </Text>
          </View>

          {capacity ? (
            <Card className="mb-4">
              {/* Android "Bold text" (Settings > Accessibility, Configuration
                  fontWeightAdjustment=300) paints glyphs wider than Yoga
                  measured them. Yoga sizes these labels for ONE line, Android
                  then overruns, wraps at a space, and line 2 is clipped by the
                  already-fixed one-line height — the whole trailing word just
                  disappears with no ellipsis ("7 remaining" rendered as "7").
                  Verified on a physical Pixel 10 Pro XL: identical build renders
                  correctly at fontWeightAdjustment=0 and clips at 300.
                  The trailing space buys measured-width headroom so the bold
                  overrun cannot reach a wrap point; numberOfLines={1} makes any
                  residual overrun ellipsize visibly instead of vanishing.
                  flexShrink:0 keeps the row from squeezing them further. */}
              <View className="flex-row items-baseline justify-between mb-2">
                <Text className="text-body font-semibold text-content-primary flex-1">
                  {capacity.count} of {capacity.limit} devices in use
                </Text>
                {capacity.isAtLimit ? (
                  <Text
                    className="text-caption font-semibold text-status-danger"
                    style={CLIP_SAFE}
                    numberOfLines={1}
                  >
                    {clipSafe('Limit reached')}
                  </Text>
                ) : capacity.isNearLimit ? (
                  <Text
                    className="text-caption font-semibold text-status-warning"
                    style={CLIP_SAFE}
                    numberOfLines={1}
                  >
                    {clipSafe('Approaching limit')}
                  </Text>
                ) : (
                  <Text
                    className="text-caption text-content-tertiary"
                    style={CLIP_SAFE}
                    numberOfLines={1}
                  >
                    {clipSafe(`${capacity.remaining} remaining`)}
                  </Text>
                )}
              </View>
              <View className="h-2 rounded-full bg-surface-sunken overflow-hidden">
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
            <EmptyState
              contained
              icon={ShieldAlert}
              iconColor={colors.statusDangerFg}
              iconSize={iconLg}
              description="Could not load your devices."
              action={{
                label: 'Retry',
                variant: 'secondary',
                onPress: () => {
                  refetch().catch(() => {});
                },
              }}
            />
          ) : devices.length === 0 ? (
            <EmptyState
              contained
              icon={Smartphone}
              iconSize={iconLg}
              description="No active devices."
            />
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
      <Toast
        message="Verify with MFA to revoke devices"
        visible={mfaToastVisible}
        onHide={() => setMfaToastVisible(false)}
      />
    </SafeAreaView>
  );
}

import React, { useEffect, useState, useMemo } from 'react';
import { Modal, View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Smartphone, Tablet, Monitor, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../hooks/useAuth';
import { useResponsive } from '../hooks/useResponsive';
import { useDeviceCapacity } from '../hooks/useDeviceCapacity';
import { devicesApi, type DeviceSession } from '../api/devices';
import { Button } from './ui/Button';

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

/**
 * Mounted at the root of the authenticated app tree. Renders only when
 * `deviceRegistrationBlock` is set on the auth context — i.e. the server
 * returned 403 DEVICE_LIMIT_REACHED on POST /api/device-sessions/register.
 *
 * The modal lets the user revoke one of their existing devices, then
 * automatically retries registration. On success it dismisses itself.
 */
export function DeviceLimitModal() {
  const {
    deviceRegistrationBlock,
    dismissDeviceRegistrationBlock,
    retryDeviceRegistration,
  } = useAuth();
  const { iconMd, iconSm } = useResponsive();
  const queryClient = useQueryClient();
  const { devices: liveDevices, capacity: liveCapacity } = useDeviceCapacity();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const visible = !!deviceRegistrationBlock;

  // Reset transient state whenever the block clears.
  useEffect(() => {
    if (!visible) {
      setRevokingId(null);
      setRetrying(false);
    }
  }, [visible]);

  // Prefer the live device-sessions query when it has data so revokes from
  // elsewhere reflect immediately. Fall back to the 403-body snapshot for
  // the first paint so the modal is usable before the query resolves.
  const existingDevices = useMemo<DeviceSession[]>(() => {
    if (liveDevices && liveDevices.length > 0) return liveDevices;
    return deviceRegistrationBlock?.existingDevices ?? [];
  }, [liveDevices, deviceRegistrationBlock]);

  const capacity = liveCapacity ?? deviceRegistrationBlock?.capacity ?? null;
  const isBusy = revokingId !== null || retrying;

  if (!deviceRegistrationBlock) return null;

  const handleRetry = () => {
    (async () => {
      if (isBusy) return;
      setRetrying(true);
      try {
        const ok = await retryDeviceRegistration();
        if (ok) {
          queryClient
            .invalidateQueries({ queryKey: ['recordings'] })
            .catch(() => {});
        }
      } finally {
        setRetrying(false);
      }
    })().catch(() => {});
  };

  const handleRevoke = (device: DeviceSession) => {
    if (isBusy) return;
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
            (async () => {
              setRevokingId(device.id);
              try {
                await devicesApi.revoke(device.id);
                Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Success
                ).catch(() => {});
                // Refresh the device-sessions list everywhere.
                queryClient
                  .invalidateQueries({ queryKey: ['device-sessions'] })
                  .catch(() => {});

                // Now that a slot opened up, retry register. On success the
                // AuthProvider clears the block state; on failure the modal
                // stays open with a refreshed device list (next render).
                setRetrying(true);
                const ok = await retryDeviceRegistration();
                if (ok) {
                  // Recordings may have been blocked by 428 prior to this —
                  // unblock them now that the device is registered.
                  queryClient
                    .invalidateQueries({ queryKey: ['recordings'] })
                    .catch(() => {});
                }
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : 'Could not revoke this device.';
                Alert.alert('Revoke Failed', message);
              } finally {
                setRevokingId(null);
                setRetrying(false);
              }
            })().catch(() => {});
          },
        },
      ]
    );
  };

  // Don't let the user dismiss mid-operation — we'd leave a stale modal state
  // if the revoke + retry landed after dismissal. The system back gesture
  // (Android) routes through onRequestClose so we guard it too.
  const handleDismiss = () => {
    if (isBusy) return;
    dismissDeviceRegistrationBlock();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <View
        className="flex-1 bg-black/50 justify-center items-center p-5"
        accessibilityViewIsModal
      >
        <View className="w-full max-w-[420px] bg-white rounded-card overflow-hidden">
          {/* Header */}
          <View className="flex-row items-start p-5 border-b border-stone-200">
            <View className="w-10 h-10 rounded-full bg-danger-100 justify-center items-center mr-3">
              <ShieldAlert color="#b91c1c" size={iconMd} />
            </View>
            <View className="flex-1">
              <Text
                className="text-heading font-bold text-stone-900"
                accessibilityRole="header"
              >
                Device limit reached
              </Text>
              <Text className="text-body-sm text-stone-600 mt-1">
                {capacity
                  ? `${capacity.count} of ${capacity.limit} devices in use. Remove one to register this device.`
                  : `Remove one device to register this one.`}
              </Text>
            </View>
            <Pressable
              onPress={handleDismiss}
              disabled={isBusy}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              hitSlop={8}
              className="ml-2"
            >
              <X color={isBusy ? '#d6d3d1' : '#78716c'} size={iconSm} />
            </Pressable>
          </View>

          {/* Device list */}
          <ScrollView
            className="max-h-[360px]"
            contentContainerStyle={{ paddingVertical: 8 }}
          >
            {existingDevices.length === 0 ? (
              <View className="p-5 items-center">
                <Text className="text-body text-stone-600 text-center mb-3">
                  No other devices are registered to this account. The slot
                  may have been freed elsewhere — try registering again.
                </Text>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={handleRetry}
                  disabled={isBusy}
                >
                  {retrying ? 'Retrying…' : 'Retry Registration'}
                </Button>
                <Text className="text-caption text-stone-400 text-center mt-3">
                  Still blocked? Ask an admin to raise the device limit for
                  your account.
                </Text>
              </View>
            ) : (
              existingDevices.map((device) => {
                const Icon = getDeviceIcon(device.deviceType);
                const typeLabel = formatDeviceTypeLabel(device.deviceType);
                const isThisRowBusy = revokingId === device.id;
                const otherBusy = revokingId !== null && !isThisRowBusy;
                return (
                  <View
                    key={device.id}
                    className="flex-row items-center px-5 py-3"
                  >
                    <View className="w-9 h-9 rounded-full bg-stone-100 justify-center items-center mr-3">
                      <Icon color="#0d8775" size={iconSm} />
                    </View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-stone-900">
                        {device.deviceName || typeLabel}
                      </Text>
                      <Text className="text-caption text-stone-500 mt-0.5">
                        {typeLabel}
                        {device.appVersion ? ` · v${device.appVersion}` : ''}
                      </Text>
                      <Text className="text-caption text-stone-400 mt-0.5">
                        Last active {formatRelativeTime(device.lastSeenAt)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleRevoke(device)}
                      disabled={revokingId !== null}
                      accessibilityRole="button"
                      accessibilityLabel={`Revoke ${device.deviceName || typeLabel}`}
                      hitSlop={8}
                      className="ml-2 px-3 py-2"
                    >
                      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                      <Text
                        className={`text-body-sm font-semibold ${
                          otherBusy
                            ? 'text-stone-300'
                            : isThisRowBusy
                              ? 'text-stone-400'
                              : 'text-danger-500'
                        }`}
                        allowFontScaling={false}
                        style={{ flexShrink: 0, paddingRight: 2 }}
                      >
                        {`${isThisRowBusy ? 'Revoking…' : 'Revoke'} `}
                      </Text>
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>

          {/* Footer */}
          <View className="px-5 py-3 border-t border-stone-200">
            <Text className="text-caption text-stone-500 text-center">
              {retrying
                ? 'Reconnecting this device…'
                : 'Revoking a device will sign it out everywhere.'}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

import React, { useEffect, useState, useMemo } from 'react';
import { Modal, View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Smartphone, Tablet, Monitor } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthActions, useAuthDeviceRegistration, useAuthUser } from '../hooks/useAuth';
import type { SignOutRecoveryMode } from '../auth/AuthProvider';
import { useResponsive } from '../hooks/useResponsive';
import { useDeviceCapacity } from '../hooks/useDeviceCapacity';
import { useThemeColors } from '../hooks/useThemeColors';
import { devicesApi, type DeviceSession } from '../api/devices';
import { Button } from './ui/Button';
import { invalidateRecordingCaches } from '../lib/recordingQueryCache';
import { breadcrumb } from '../lib/monitoring';
import { SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED } from '../lib/supportStaffRecoveryVault';
import { DEVICE_LIMIT_COPY } from '../constants/strings';

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
    retryDeviceRegistration,
  } = useAuthDeviceRegistration();
  const { signOut } = useAuthActions();
  const user = useAuthUser();
  const { iconMd, iconSm } = useResponsive();
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const { devices: liveDevices, capacity: liveCapacity } = useDeviceCapacity({ mode: 'manage' });
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const visible = !!deviceRegistrationBlock;

  // Reset transient state whenever the block clears.
  useEffect(() => {
    if (!visible) {
      setRevokingId(null);
      setRetrying(false);
      setRetryFailed(false);
      setSigningOut(false);
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
  // signingOut is part of the shared busy guard: during support_staff recovery
  // preservation the API token is still valid, so a device Revoke tapped mid
  // sign-out could revoke another clinic device (Codex P2, PR #143).
  const isBusy = revokingId !== null || retrying || signingOut;

  if (!deviceRegistrationBlock) return null;

  const handleRetry = () => {
    (async () => {
      if (isBusy) return;
      setRetrying(true);
      setRetryFailed(false);
      try {
        const ok = await retryDeviceRegistration();
        if (ok) {
          queryClient
            .invalidateQueries({ queryKey: ['device-sessions'] })
            .catch(() => {});
          invalidateRecordingCaches(queryClient, 'device_registration_recovered');
        } else {
          // Without this the footer text just stops saying "Reconnecting…"
          // and the user can't tell a failed retry from nothing happening.
          setRetryFailed(true);
        }
      } catch {
        setRetryFailed(true);
      } finally {
        setRetrying(false);
      }
    })().catch(() => {});
  };

  // Escape hatch: a user unwilling to revoke a colleague's device on a shared
  // account is otherwise permanently stuck in this hard-block modal. Standard
  // sign-out preserves drafts/stashes (CLAUDE.md rule 8). support_staff use
  // recoveryMode 'required' so a failed recovery-vault save blocks sign-out
  // and surfaces the same retry/destructive choice as Settings — otherwise a
  // storage-full recovery failure silently strands per-user drafts from the
  // owner/admin who signs in next (Codex P2, PR #143).
  const runSignOut = (recoveryMode: SignOutRecoveryMode) => {
    if (isBusy) return;
    setSigningOut(true);
    signOut({ recoveryMode })
      .catch((error) => {
        if (
          recoveryMode === 'required' &&
          error instanceof Error &&
          error.message === SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED
        ) {
          Alert.alert(
            'Recovery Save Failed',
            'The app could not save a recovery copy of the local recordings. Local storage may be full or unavailable. Stay signed in and try again, or sign out and permanently delete the local recordings on this tablet.',
            [
              { text: 'Stay Signed In', style: 'cancel' },
              { text: 'Retry', onPress: () => runSignOut('required') },
              {
                text: 'Sign Out & Delete',
                style: 'destructive',
                onPress: () => {
                  Alert.alert(
                    'Delete Local Recordings?',
                    'This signs out without saving a recovery copy. Any unsent local recordings for this support staff account may be permanently removed from this tablet.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete & Sign Out',
                        style: 'destructive',
                        onPress: () => runSignOut('destructive'),
                      },
                    ]
                  );
                },
              },
            ]
          );
          return;
        }
        if (__DEV__) console.error('[DeviceLimitModal] signOut failed:', error);
      })
      .finally(() => setSigningOut(false));
  };

  const handleSignOut = () => {
    runSignOut(user?.role === 'support_staff' ? 'required' : 'best_effort');
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
              setRetryFailed(false);
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
                  queryClient
                    .invalidateQueries({ queryKey: ['device-sessions'] })
                    .catch(() => {});
                  invalidateRecordingCaches(queryClient, 'device_registration_recovered');
                } else {
                  // The revoke worked but registration still failed (e.g.
                  // connectivity died) — surface it exactly like the manual
                  // retry path, or the next apparent action is revoking
                  // ANOTHER working device unnecessarily.
                  setRetryFailed(true);
                }
              } catch (error) {
                // Never surface raw API error text to users; keep the detail
                // in dev logs + a Sentry breadcrumb (no PHI — error name only).
                if (__DEV__) console.error('[DeviceLimitModal] revoke failed:', error);
                breadcrumb('auth', 'device_limit_revoke_failed', {
                  error_name: error instanceof Error ? error.name : 'unknown',
                });
                Alert.alert('Revoke Failed', DEVICE_LIMIT_COPY.revokeFailed);
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

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Hard block: this device cannot use server APIs until registration succeeds.
      onRequestClose={() => {}}
    >
      <View
        className="flex-1 bg-scrim justify-center items-center p-5"
        accessibilityViewIsModal
      >
        <View className="w-full max-w-[420px] bg-surface-raised rounded-card overflow-hidden">
          {/* Header */}
          <View className="flex-row items-start p-5 border-b border-border-default">
            <View className="w-10 h-10 rounded-full bg-status-danger justify-center items-center mr-3">
              <ShieldAlert color={colors.statusDangerFg} size={iconMd} />
            </View>
            <View className="flex-1">
              <Text
                className="text-heading font-bold text-content-primary"
                accessibilityRole="header"
              >
                Device limit reached
              </Text>
              <Text className="text-body-sm text-content-secondary mt-1">
                {capacity
                  ? `${capacity.count} of ${capacity.limit} devices in use. Remove one to register this device.`
                  : `Remove one device to register this one.`}
              </Text>
            </View>
          </View>

          {/* Device list */}
          <ScrollView
            className="max-h-[360px]"
            contentContainerStyle={{ paddingVertical: 8 }}
          >
            {existingDevices.length === 0 ? (
              <View className="p-5 items-center">
                <Text className="text-body text-content-secondary text-center mb-3">
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
                <Text className="text-caption text-content-tertiary text-center mt-3">
                  Still blocked? Ask an admin to raise the device limit for
                  your account.
                </Text>
              </View>
            ) : (
              existingDevices.map((device) => {
                const Icon = getDeviceIcon(device.deviceType);
                const typeLabel = formatDeviceTypeLabel(device.deviceType);
                const isThisRowBusy = revokingId === device.id;
                // Dim + disable this row while any other action (a different
                // revoke, a retry, or sign-out) holds the busy guard.
                const otherBusy = isBusy && !isThisRowBusy;
                return (
                  <View
                    key={device.id}
                    className="flex-row items-center px-5 py-3"
                  >
                    <View className="w-9 h-9 rounded-full bg-surface-sunken justify-center items-center mr-3">
                      <Icon color={colors.brand500} size={iconSm} />
                    </View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-content-primary">
                        {device.deviceName || typeLabel}
                      </Text>
                      <Text className="text-caption text-content-tertiary mt-0.5">
                        {typeLabel}
                        {device.appVersion ? ` · v${device.appVersion}` : ''}
                      </Text>
                      <Text className="text-caption text-content-tertiary mt-0.5">
                        Last active {formatRelativeTime(device.lastSeenAt)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => handleRevoke(device)}
                      disabled={isBusy}
                      accessibilityRole="button"
                      accessibilityLabel={`Revoke ${device.deviceName || typeLabel}`}
                      accessibilityState={{ disabled: isBusy }}
                      hitSlop={8}
                      className="ml-2 px-3 py-2"
                    >
                      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                      <Text
                        className={`text-body-sm font-semibold ${
                          otherBusy
                            ? 'text-content-tertiary'
                            : isThisRowBusy
                              ? 'text-content-tertiary'
                              : 'text-status-danger'
                        }`}
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
          <View className="px-5 py-3 border-t border-border-default">
            {retryFailed && !retrying && (
              <Text
                className="text-caption text-status-danger text-center mb-2"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {DEVICE_LIMIT_COPY.stillAtLimit}
              </Text>
            )}
            <Text className="text-caption text-content-tertiary text-center">
              {retrying
                ? 'Reconnecting this device…'
                : 'Revoking a device will sign it out everywhere.'}
            </Text>
            <View className="mt-2">
              <Button
                variant="ghost"
                size="sm"
                onPress={handleSignOut}
                loading={signingOut}
                disabled={isBusy}
              >
                {DEVICE_LIMIT_COPY.signOut}
              </Button>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

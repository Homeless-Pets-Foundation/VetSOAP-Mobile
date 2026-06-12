import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Alert, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileClock,
  FileText,
  HelpCircle,
  LifeBuoy,
  LogOut,
  Mail,
  Monitor,
  Shield,
  Smartphone,
  Trash2,
  User,
  UserRound,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../../src/hooks/useAuth';
import type { SignOutRecoveryMode } from '../../../src/auth/AuthProvider';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { biometrics } from '../../../src/lib/biometrics';
import { canRecordAppointments } from '../../../src/lib/recordingPermissions';
import {
  SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED,
  supportStaffRecoveryVault,
} from '../../../src/lib/supportStaffRecoveryVault';
import { CONTENT_MAX_WIDTH } from '../../../src/components/ui/ScreenContainer';
import { Card } from '../../../src/components/ui/Card';
import { IconButton } from '../../../src/components/ui/IconButton';
import { ListItem } from '../../../src/components/ui/ListItem';
import { Toggle } from '../../../src/components/ui/Toggle';
import { SegmentedControl } from '../../../src/components/ui/SegmentedControl';
import { countUnsentRecordings } from '../../../src/lib/localRecordings';
import { trackEvent } from '../../../src/lib/analytics';
import { THEME_COPY } from '../../../src/constants/strings';
import {
  HELP_CENTER_URL,
  PRIVACY_POLICY_URL,
  SUPPORT_CONTACT_URL,
  TERMS_URL,
} from '../../../src/config';
import { useThemeColors } from '../../../src/hooks/useThemeColors';
import { useThemePreference } from '../../../src/hooks/useThemePreference';
import type { ThemePreference } from '../../../src/lib/themePreference';
import Constants from 'expo-constants';

function SectionHeading({ children, className = '' }: { children: string; className?: string }) {
  return (
    <Text className={`text-caption text-content-tertiary font-semibold mb-2 px-1 ${className}`}>
      {children}
    </Text>
  );
}

const THEME_OPTIONS = [
  { value: 'system', label: THEME_COPY.system },
  { value: 'light', label: THEME_COPY.light },
  { value: 'dark', label: THEME_COPY.dark },
] as const;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { iconSm, iconMd } = useResponsive();
  const colors = useThemeColors();
  const { preference: themePreference, setPreference: setThemePreference } = useThemePreference();

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricType, setBiometricType] = useState('Biometric');
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const openLink = useCallback((url: string, link: 'help_center' | 'contact' | 'terms' | 'privacy') => {
    Linking.openURL(url)
      .then(() => {
        if (link === 'help_center' || link === 'contact') {
          trackEvent({ name: 'support_link_opened', props: { link } });
        }
      })
      .catch(() => {
        Alert.alert('Could Not Open Link', 'Please try again in a moment.');
      });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const available = await biometrics.isAvailable();
        setBiometricAvailable(available);
        if (available) {
          const [enabled, type] = await Promise.all([
            biometrics.isEnabled(),
            biometrics.getType(),
          ]);
          setBiometricEnabled(enabled);
          setBiometricType(type);
        }
      } catch (error) {
        if (__DEV__) console.error('[Settings] Failed to load biometric state:', error);
      }
    })().catch(() => {});
  }, []);

  useEffect(() => {
    if (!canRecordAppointments(user?.role)) {
      setRecoveryCount(0);
      return;
    }
    supportStaffRecoveryVault.countItemsForUser(user)
      .then(setRecoveryCount)
      .catch(() => setRecoveryCount(0));
  }, [user]);

  const toggleBiometric = useCallback(async (value: boolean) => {
    try {
      if (value) {
        const success = await biometrics.authenticate(
          'Verify your identity to enable biometric lock'
        );
        if (!success) return;
      }
      const saved = await biometrics.setEnabled(value);
      if (!saved) {
        Alert.alert(
          'Update Failed',
          `Could not ${value ? 'enable' : 'disable'} biometric lock. Please try again.`
        );
        return;
      }
      setBiometricEnabled(value);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      if (__DEV__) console.error('[Settings] toggleBiometric failed:', error);
    }
  }, []);

  const runSignOut = (recoveryMode: SignOutRecoveryMode = 'best_effort') => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    (async () => {
      await signOut({ recoveryMode });
    })()
      .catch((error) => {
        if (__DEV__) console.error('[Settings] signOut failed:', error);
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
        Alert.alert('Sign Out Failed', 'Could not sign out. Please try again.');
      })
      .finally(() => {
        setIsSigningOut(false);
      });
  };

  const showStandardSignOutPrompt = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => runSignOut(user?.role === 'support_staff' ? 'required' : 'best_effort'),
      },
    ]);
  };

  const handleSignOut = () => {
    if (user?.role !== 'support_staff') {
      // Non-support-staff: recordings now SURVIVE logout (2026-05-29 decision).
      // Warn the vet that unsent work stays parked on this device, with a path
      // to go review/submit it. Best-effort count; never blocks sign-out.
      countUnsentRecordings()
        .then((unsentCount) => {
          if (unsentCount > 0) {
            // Haptic only on the warning path; showStandardSignOutPrompt fires
            // its own Warning haptic, so firing here too would double-pulse.
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            Alert.alert(
              'Unsent Recordings',
              `You have ${unsentCount} recording${unsentCount === 1 ? '' : 's'} on this device not yet sent for SOAP notes. They'll stay on this device — sign out anyway?`,
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Review', onPress: () => { router.replace('/(app)/(tabs)/record'); } },
                { text: 'Sign Out', style: 'destructive', onPress: () => runSignOut('best_effort') },
              ]
            );
          } else {
            showStandardSignOutPrompt();
          }
        })
        .catch(() => {
          showStandardSignOutPrompt();
        });
      return;
    }

    supportStaffRecoveryVault.countScopedUserRecoverableRecordings()
      .then((count) => {
        if (count === 0) {
          showStandardSignOutPrompt();
          return;
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert(
          'Recover Recordings First?',
          `${count} local recording${count === 1 ? '' : 's'} from this account may still be on this tablet. Signing out will save a recovery copy for an owner, administrator, or veterinarian on this device.`,
          [
            { text: 'Stay Signed In', style: 'cancel' },
            {
              text: 'Save & Sign Out',
              style: 'destructive',
              onPress: () => runSignOut('required'),
            },
          ]
        );
      })
      .catch(() => {
        showStandardSignOutPrompt();
      });
  };

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
            <Text
              className="text-display font-bold text-content-primary"
              accessibilityRole="header"
            >
              Settings
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 28 }}
          keyboardShouldPersistTaps="handled"
        >
          <Card className="p-5 mb-5">
            <View className="flex-row items-center">
              <View className="w-12 h-12 rounded-full bg-brand-500 justify-center items-center mr-3.5">
                <User color={colors.contentOnBrand} size={iconMd} />
              </View>
              <View className="flex-1">
                <Text className="text-body-lg font-semibold text-content-primary" numberOfLines={1}>
                  {user?.fullName || 'User'}
                </Text>
                <Text className="text-body-sm text-content-tertiary mt-0.5" numberOfLines={1}>
                  {user?.email || ''}
                </Text>
                {user?.role ? (
                  <Text className="text-caption text-content-tertiary mt-0.5 capitalize">
                    {user.role.replace(/_/g, ' ')}
                  </Text>
                ) : null}
              </View>
            </View>
          </Card>

          <SectionHeading>ACCOUNT</SectionHeading>
          <ListItem
            onPress={() => {
              router.push('/profile' as never);
            }}
            accessibilityLabel="Edit profile"
            title="Edit Profile"
            subtitle="Name and password"
            leading={<UserRound color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
          />
          <ListItem
            onPress={() => {
              router.push('/subscription' as never);
            }}
            accessibilityLabel="View subscription"
            title="Subscription"
            subtitle="Plan, trial, renewal, and billing portal"
            leading={<CreditCard color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
            className="mb-5"
          />

          <SectionHeading>APP</SectionHeading>
          <Card className="mb-5">
            <View className="flex-row items-start mb-3">
              <View className="mr-3 mt-0.5">
                <Monitor color={colors.brand500} size={iconSm} />
              </View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-content-primary">
                  {THEME_COPY.title}
                </Text>
                <Text className="text-body-sm text-content-tertiary mt-0.5">
                  {THEME_COPY.subtitle}
                </Text>
              </View>
            </View>
            <SegmentedControl<ThemePreference>
              options={THEME_OPTIONS}
              value={themePreference}
              onValueChange={(value) => {
                if (value) setThemePreference(value);
              }}
              columns={3}
              accessibilityLabel="Choose app appearance"
            />
          </Card>

          <SectionHeading>SECURITY</SectionHeading>
          {biometricAvailable ? (
            <ListItem
              title={`${biometricType} Lock`}
              subtitle={`Require ${biometricType.toLowerCase()} when returning to the app`}
              leading={<Shield color={colors.brand500} size={iconSm} />}
              trailing={
                <Toggle
                  value={biometricEnabled}
                  onValueChange={toggleBiometric}
                  accessibilityLabel={`Toggle ${biometricType} lock`}
                />
              }
            />
          ) : null}

          <ListItem
            onPress={() => {
              router.push('/devices' as never);
            }}
            accessibilityLabel="Manage active devices"
            title="Manage Devices"
            subtitle="View and revoke devices signed in to your account"
            leading={<Smartphone color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
            className="mb-5"
          />

          <SectionHeading>SUPPORT</SectionHeading>
          <ListItem
            onPress={() => openLink(HELP_CENTER_URL, 'help_center')}
            accessibilityLabel="Open help center"
            title="Help Center"
            subtitle="Guides and troubleshooting"
            leading={<HelpCircle color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
          />
          <ListItem
            onPress={() => openLink(SUPPORT_CONTACT_URL, 'contact')}
            accessibilityLabel="Contact support"
            title="Contact"
            subtitle="Email Captivet support"
            leading={<Mail color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
            className="mb-5"
          />

          <SectionHeading>LEGAL</SectionHeading>
          <ListItem
            onPress={() => openLink(TERMS_URL, 'terms')}
            accessibilityLabel="Open terms of service"
            title="Terms"
            subtitle="Captivet service terms"
            leading={<FileText color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
          />
          <ListItem
            onPress={() => openLink(PRIVACY_POLICY_URL, 'privacy')}
            accessibilityLabel="Open privacy policy"
            title="Privacy"
            subtitle="How Captivet handles data"
            leading={<LifeBuoy color={colors.brand500} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
            className="mb-5"
          />

          {canRecordAppointments(user?.role) ? (
            <>
              <SectionHeading>LOCAL RECOVERY</SectionHeading>
              <ListItem
                onPress={() => {
                  router.push('/recording-recovery' as never);
                }}
                accessibilityLabel="Recover local recordings on this tablet"
                title="Recover Local Recordings"
                subtitle={
                  recoveryCount > 0
                    ? `${recoveryCount} recovery item${recoveryCount === 1 ? '' : 's'} saved on this tablet`
                    : 'Recover recordings protected during support staff sign-out'
                }
                leading={<FileClock color={colors.brand500} size={iconSm} />}
                trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
                className="mb-5"
              />
            </>
          ) : null}

          <SectionHeading>DANGER ZONE</SectionHeading>
          <ListItem
            onPress={() => {
              router.push('/delete-account' as never);
            }}
            accessibilityLabel="Delete account"
            title={<Text className="text-body font-semibold text-status-danger">Delete Account</Text>}
            subtitle="Request permanent account deletion"
            leading={<Trash2 color={colors.danger600} size={iconSm} />}
            trailing={<ChevronRight color={colors.contentTertiary} size={iconSm} />}
            className="mb-5 border border-status-danger"
          />

          <ListItem
            onPress={handleSignOut}
            accessibilityLabel="Sign out of your account"
            title={<Text className="text-body font-medium text-status-danger">Sign Out</Text>}
            leading={<LogOut color={colors.danger500} size={iconSm} />}
            disabled={isSigningOut}
            haptic={false}
          />

          <Text className="text-caption text-content-tertiary text-center mt-8">
            Captivet v{Constants.expoConfig?.version || '1.0.0'}
          </Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

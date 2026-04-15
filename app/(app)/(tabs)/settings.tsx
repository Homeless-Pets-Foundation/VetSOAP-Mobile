import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LogOut, User, ChevronLeft, Shield, Smartphone, ChevronRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../../src/hooks/useAuth';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { biometrics } from '../../../src/lib/biometrics';
import { CONTENT_MAX_WIDTH } from '../../../src/components/ui/ScreenContainer';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { iconSm, iconMd } = useResponsive();

  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricType, setBiometricType] = useState('Biometric');

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

  const handleSignOut = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          (async () => {
            try {
              await biometrics.clear();
              await signOut();
            } catch (error) {
              if (__DEV__) console.error('[Settings] signOut failed:', error);
            }
          })().catch(() => {});
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="screen items-center">
      <View className="p-5" style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        {/* Header */}
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
            Settings
          </Text>
        </View>

        {/* User Info */}
        <View className="card p-5 mb-4">
          <View className="flex-row items-center">
            <View className="w-12 h-12 rounded-full bg-brand-500 justify-center items-center mr-3.5">
              <User color="#fff" size={iconMd} />
            </View>
            <View>
              <Text className="text-body-lg font-semibold text-stone-900">
                {user?.fullName || 'User'}
              </Text>
              <Text className="text-body-sm text-stone-500 mt-0.5">
                {user?.email || ''}
              </Text>
              {user?.role && (
                <Text className="text-caption text-stone-400 mt-0.5 capitalize">
                  {user.role}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Security Section */}
        <Text className="text-caption text-stone-400 font-semibold mb-2 px-1">
          SECURITY
        </Text>

        {biometricAvailable && (
          <View className="card flex-row items-center justify-between min-h-[44px] mb-2">
            <View className="flex-row items-center flex-1">
              <Shield color="#0d8775" size={iconSm} style={{ marginRight: 12 }} />
              <View className="flex-1">
                <Text className="text-body font-medium text-stone-900">
                  {biometricType} Lock
                </Text>
                <Text className="text-caption text-stone-500">
                  Require {biometricType.toLowerCase()} when returning to the app
                </Text>
              </View>
            </View>
            <Switch
              value={biometricEnabled}
              onValueChange={(v) => { toggleBiometric(v).catch(() => {}); }}
              trackColor={{ false: '#d6d3d1', true: '#0d8775' }}
              thumbColor="#fff"
              accessibilityLabel={`Toggle ${biometricType} lock`}
              accessibilityValue={{ text: biometricEnabled ? 'on' : 'off' }}
            />
          </View>
        )}

        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            router.push('/devices' as never);
          }}
          accessibilityRole="button"
          accessibilityLabel="Manage active devices"
          className="card flex-row items-center min-h-[44px] mb-4"
        >
          <Smartphone color="#0d8775" size={iconSm} style={{ marginRight: 12 }} />
          <View className="flex-1">
            <Text className="text-body font-medium text-stone-900">
              Manage Devices
            </Text>
            <Text className="text-caption text-stone-500">
              View and revoke devices signed in to your account
            </Text>
          </View>
          <ChevronRight color="#a8a29e" size={iconSm} />
        </Pressable>

        {/* Sign Out */}
        <Pressable
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out of your account"
          className="card flex-row items-center min-h-[44px]"
        >
          <LogOut color="#ef4444" size={iconSm} style={{ marginRight: 12 }} />
          <Text className="text-body font-medium text-danger-500">Sign Out</Text>
        </Pressable>

        {/* App Info */}
        <Text className="text-caption text-stone-400 text-center mt-10">
          Captivet v{Constants.expoConfig?.version || '1.0.0'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

import React from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LogOut, User, ChevronLeft } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../src/hooks/useAuth';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();

  const handleSignOut = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="screen">
      <View className="p-5">
        {/* Header */}
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="mr-3 w-11 h-11 items-center justify-center"
          >
            <ChevronLeft color="#1c1917" size={24} />
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
              <User color="#fff" size={24} />
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

        {/* Sign Out */}
        <Pressable
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out of your account"
          className="card flex-row items-center min-h-[44px]"
        >
          <LogOut color="#ef4444" size={20} style={{ marginRight: 12 }} />
          <Text className="text-body font-medium text-danger-500">Sign Out</Text>
        </Pressable>

        {/* App Info */}
        <Text className="text-caption text-stone-400 text-center mt-10">
          VetSOAP Mobile v{Constants.expoConfig?.version || '1.0.0'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

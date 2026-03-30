import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, ActivityIndicator } from 'react-native';
import { AppLockGuard } from '../../src/components/AppLockGuard';

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (__DEV__) console.log('[AppLayout] render: isLoading=', isLoading, 'isAuthenticated=', isAuthenticated);

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center bg-stone-50">
        <ActivityIndicator size="large" color="#0d8775" />
      </View>
    );
  }

  if (!isAuthenticated) {
    if (__DEV__) console.log('[AppLayout] REDIRECTING to login — isAuthenticated is false');
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <AppLockGuard>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="audio-editor" />
        </Stack>
      </View>
    </AppLockGuard>
  );
}

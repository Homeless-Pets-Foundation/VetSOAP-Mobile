import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, ActivityIndicator } from 'react-native';
import { useThemeColors } from '../../src/hooks/useThemeColors';

export default function AuthLayout() {
  const { isAuthenticated, isPasswordRecovery, isLoading, mfaRequired } = useAuth();
  const colors = useThemeColors();

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center bg-surface">
        <ActivityIndicator size="large" color={colors.brand500} />
      </View>
    );
  }

  // Allow reset-password screen when the user tapped a recovery deep link.
  // The session is authenticated but the user hasn't set a new password yet.
  if (isAuthenticated && !isPasswordRecovery && !mfaRequired) {
    return <Redirect href="/" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="reset-password" />
      <Stack.Screen name="mfa" />
    </Stack>
  );
}

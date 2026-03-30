import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/auth/AuthProvider';
import { StatusBar } from 'expo-status-bar';
import { CONFIG_MISSING } from '../src/config';
import { queryClient } from '../src/lib/queryClient';
import '../global.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const displayMessage = __DEV__
        ? (this.state.error?.message || 'An unexpected error occurred.')
        : 'Something unexpected happened. Please try again.';

      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center', marginBottom: 16 }}>
            {displayMessage}
          </Text>
          <Pressable
            onPress={() => this.setState({ hasError: false, error: null })}
            style={{ backgroundColor: '#0d8775', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  if (CONFIG_MISSING) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fef2f2' }}>
        <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#991b1b', marginBottom: 12 }}>
          Configuration Error
        </Text>
        <Text style={{ fontSize: 14, color: '#7f1d1d', textAlign: 'center' }}>
          Required environment variables are missing. Please check your build configuration and rebuild the app.
        </Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="dark" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(app)" />
            </Stack>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

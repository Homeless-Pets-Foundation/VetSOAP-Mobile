import React, { useEffect } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/auth/AuthProvider';
import { StatusBar } from 'expo-status-bar';
import { CONFIG_MISSING } from '../src/config';
import { supabase } from '../src/auth/supabase';
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
  const router = useRouter();

  useEffect(() => {
    // Handle deep link for password reset
    const handleUrl = async (url: string) => {
      try {
        if (!url.includes('reset-password')) {
          return;
        }

        // Supabase can deliver tokens as query params OR as a hash fragment
        const parsed = Linking.parse(url);
        let access_token = parsed.queryParams?.access_token as string | undefined;
        let refresh_token = parsed.queryParams?.refresh_token as string | undefined;

        // Fall back to hash fragment: captivet://reset-password#access_token=...&refresh_token=...
        if (!access_token || !refresh_token) {
          const hashIndex = url.indexOf('#');
          if (hashIndex !== -1) {
            const fragment = url.substring(hashIndex + 1);
            const params = new URLSearchParams(fragment);
            access_token = access_token || params.get('access_token') || undefined;
            refresh_token = refresh_token || params.get('refresh_token') || undefined;
          }
        }

        if (
          typeof access_token === 'string' &&
          typeof refresh_token === 'string'
        ) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token,
            refresh_token,
          });

          if (sessionError) {
            Alert.alert('Session Error', 'Could not restore your session from the reset link. Please request a new one.');
            return;
          }

          router.push('/(auth)/reset-password');
        }
      } catch (error) {
        if (__DEV__) {
          console.error('Error handling password reset deep link:', error);
        }
        Alert.alert('Link Error', 'Something went wrong opening the reset link. Please try again.');
      }
    };

    // Handle initial URL (app launched via deep link)
    Linking.getInitialURL()
      .then((url) => {
        if (url != null) {
          handleUrl(url).catch(() => {});
        }
      })
      .catch(() => {});

    // Listen for URL changes while app is open
    const sub = Linking.addEventListener('url', ({ url }) => {
      handleUrl(url).catch(() => {});
    });

    return () => {
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

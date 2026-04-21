import React, { useEffect } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/auth/AuthProvider';
import { supabase } from '../src/auth/supabase';
import { configureGoogleSignIn } from '../src/auth/socialAuth';
import { StatusBar } from 'expo-status-bar';
import { CONFIG_MISSING } from '../src/config';
import { queryClient } from '../src/lib/queryClient';
import { DeviceLimitModal } from '../src/components/DeviceLimitModal';
import { initMonitoring } from '../src/lib/monitoring';
import { initAnalytics } from '../src/lib/analytics';
import '../global.css';

// Initialize Sentry + PostHog at module load so early crashes are captured.
// Both internally try/catch and no-op if keys are unset — safe under rule 1.
initMonitoring();
initAnalytics();

// Initialize native Google Sign-In once at module load, before any component
// renders. Safe to call with missing/empty client IDs — configureGoogleSignIn
// no-ops and logs a dev warning, and the Google button later surfaces a
// user-friendly error if pressed.
if (!CONFIG_MISSING) {
  configureGoogleSignIn();
}

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

  // Password-reset deep-link handler. Supabase's recovery email opens
  // `captivet://reset-password?…` (query params on iOS) or
  // `captivet://reset-password#…` (hash fragment on Android / universal links).
  // We parse both, establish the session from the tokens, and navigate the
  // user to the reset-password screen. (auth)/_layout.tsx watches
  // AuthProvider's isPasswordRecovery flag so the authenticated session
  // doesn't redirect the user away from the reset-password screen.
  useEffect(() => {
    if (CONFIG_MISSING) return;

    const handleUrl = async (url: string) => {
      try {
        if (!url.includes('reset-password')) return;

        const parsed = Linking.parse(url);
        let access_token = parsed.queryParams?.access_token as string | undefined;
        let refresh_token = parsed.queryParams?.refresh_token as string | undefined;

        if (!access_token || !refresh_token) {
          const hashIndex = url.indexOf('#');
          if (hashIndex !== -1) {
            const fragment = url.substring(hashIndex + 1);
            const params = new URLSearchParams(fragment);
            access_token = access_token || params.get('access_token') || undefined;
            refresh_token = refresh_token || params.get('refresh_token') || undefined;
          }
        }

        if (typeof access_token !== 'string' || typeof refresh_token !== 'string') return;

        const { error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });
        if (sessionError) {
          Alert.alert(
            'Session Error',
            'Could not restore your session from the reset link. Please request a new one.'
          );
          return;
        }
        // Cast: expo-router's generated types are stale until Metro regenerates
        // them to include this newly-added route. Runtime path is valid.
        router.push('/(auth)/reset-password' as never);
      } catch (error) {
        if (__DEV__) console.error('Error handling password-reset deep link:', error);
        Alert.alert('Link Error', 'Something went wrong opening the reset link. Please try again.');
      }
    };

    Linking.getInitialURL()
      .then((url) => {
        if (url != null) handleUrl(url).catch(() => {});
      })
      .catch(() => {});

    const sub = Linking.addEventListener('url', ({ url }) => {
      handleUrl(url).catch(() => {});
    });
    return () => { sub.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router singleton is stable; effect should run once per mount
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
            <DeviceLimitModal />
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

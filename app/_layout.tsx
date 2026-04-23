import React, { useEffect } from 'react';
import { View, Text, Pressable, Alert, AppState } from 'react-native';
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
import { initMonitoring, captureException } from '../src/lib/monitoring';
import { initAnalytics, trackEvent } from '../src/lib/analytics';
import { getSessionActivity } from '../src/lib/sessionActivity';
import '../global.css';

// Cold-start marker — sampled at module-load time and attached to the first
// `session_start` event so we can measure boot latency.
const COLD_START_AT = Date.now();
let _coldStartReported = false;

type AppStateCoarse = 'active' | 'background' | 'inactive' | 'unknown';
function coarseAppState(state: string): AppStateCoarse {
  if (state === 'active' || state === 'background' || state === 'inactive') return state;
  return 'unknown';
}

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

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    captureException(error, {
      tags: { boundary: 'root' },
      extra: { componentStack: info.componentStack ?? '' },
    });
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
    if (_coldStartReported) return;
    _coldStartReported = true;
    trackEvent({ name: 'session_start', props: { cold_start_ms: Date.now() - COLD_START_AT } });

    // Permission snapshot — samples once per cold start. Non-prompting; if
    // the user never granted mic access the app still functions up to the
    // record screen and then shows the OS prompt. This fires so we can
    // correlate "nothing recorded" bug reports with permission state.
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Audio = require('expo-audio') as typeof import('expo-audio');
        const result = await Audio.getRecordingPermissionsAsync();
        const mic: 'granted' | 'denied' | 'undetermined' = result?.status === 'granted'
          ? 'granted'
          : result?.status === 'denied'
            ? 'denied'
            : 'undetermined';
        // Notifications intentionally undetermined — expo-notifications isn't
        // a current dep. Wire here if/when we add one.
        trackEvent({ name: 'permissions_snapshot', props: { mic, notifications: 'undetermined' } });
      } catch {
        // swallow — permission probe is best-effort
      }
    })().catch(() => {});

    // App state transitions, tagged with what the user was doing. Catches
    // "recorder was active when the OS backgrounded us" and similar patterns.
    let prevState: AppStateCoarse = coarseAppState(AppState.currentState ?? 'active');
    const sub = AppState.addEventListener('change', (next) => {
      const nextCoarse = coarseAppState(next);
      if (nextCoarse === prevState) return;
      trackEvent({
        name: 'app_state_change',
        props: { from: prevState, to: nextCoarse, during: getSessionActivity() },
      });
      prevState = nextCoarse;
    });
    return () => {
      try { sub.remove(); } catch { /* noop */ }
    };
  }, []);

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

import React, { useEffect } from 'react';
import { View, Text, TextInput, Pressable, Alert, AppState, Platform } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { useColorScheme } from 'nativewind';
import { AuthProvider } from '../src/auth/AuthProvider';
import { supabase } from '../src/auth/supabase';
import { StatusBar } from 'expo-status-bar';
import { CONFIG_MISSING } from '../src/config';
import { queryClient } from '../src/lib/queryClient';
import { DeviceLimitModal } from '../src/components/DeviceLimitModal';
import { initMonitoring, captureException, measurePhase } from '../src/lib/monitoring';
import { initAnalytics, trackEvent } from '../src/lib/analytics';
import { getSessionActivity } from '../src/lib/sessionActivity';
import { getThemePreference } from '../src/lib/themePreference';
import { useThemeColors } from '../src/hooks/useThemeColors';
import { useAuthMfa, useAuthReadiness, useAuthUser } from '../src/hooks/useAuth';
import '../global.css';

// App-wide default font (Inter, embedded at build time — app.config.ts).
// RN <Text> does NOT inherit fontFamily from a parent View, and the app
// renders raw <Text>/<TextInput> everywhere with their own style props, so
// defaultProps.style only reaches style-less elements. Overriding `render`
// injects Inter UNDER each element's own styles (later array entry wins, so
// any explicit fontFamily still overrides). Wrapped in try/catch so a render
// shape change can never throw at module load (rule 1) — worst case is the
// system-font fallback. Verify weights on a physical device (UI Gotchas).
try {
  for (const Comp of [Text, TextInput] as const) {
    const target = Comp as unknown as {
      render?: (...args: unknown[]) => React.ReactElement<{ style?: unknown }> | null;
      __interApplied?: boolean;
    };
    const baseRender = target.render;
    if (typeof baseRender === 'function' && !target.__interApplied) {
      target.render = function patchedRender(...args: unknown[]) {
        const element = baseRender.apply(this, args);
        if (!element) return element;
        return React.cloneElement(element, {
          style: [{ fontFamily: 'Inter' }, element.props.style],
        });
      };
      target.__interApplied = true;
    }
  }
} catch {
  // noop — fall back to system font rather than crash at module load (rule 1)
}

// Cold-start marker — sampled at module-load time and attached to the first
// `session_start` event so we can measure boot latency.
const COLD_START_AT = Date.now();
let _coldStartReported = false;

type AppStateCoarse = 'active' | 'background' | 'inactive' | 'unknown';
function coarseAppState(state: string): AppStateCoarse {
  if (state === 'active' || state === 'background' || state === 'inactive') return state;
  return 'unknown';
}

function coarseRoute(pathname: string | null): string {
  if (!pathname) return 'unknown';
  if (pathname.includes('/recordings/')) return '/recordings/[id]';
  if (pathname.includes('/patient/')) return '/patient/[id]';
  if (pathname.includes('/recordings')) return '/recordings';
  if (pathname.includes('/record')) return '/record';
  if (pathname.includes('/settings')) return '/settings';
  if (pathname.includes('/devices')) return '/devices';
  if (pathname.includes('/subscription')) return '/subscription';
  if (pathname.includes('/mfa')) return '/mfa';
  if (pathname.includes('/login')) return '/login';
  return pathname === '/' ? '/' : 'other';
}

let rootBoundaryDiagnostics: Record<string, string | number | boolean | null> = {
  route: 'unknown',
  app_state: coarseAppState(AppState.currentState ?? 'unknown'),
  auth_loading: true,
  authenticated: false,
  user_fetch_state: 'idle',
  profile_source: 'live',
  has_user: false,
  mfa_required: false,
  config_missing: CONFIG_MISSING,
};

// Initialize Sentry at module load so early crashes are captured. It
// internally try/catches and no-ops if the DSN is unset — safe under rule 1.
// PostHog init is deferred to after the first frame (see RootLayout) to keep
// its module + expo-application/expo-device requires off the cold-start
// critical path; pre-init events are queued inside analytics.ts.
initMonitoring();

// Hold the native splash until the auth gate resolves (SplashGate below).
// Without this the first React frame is the bare auth-loading spinner, so
// users see a splash→spinner→content double transition on every cold start.
try {
  SplashScreen.preventAutoHideAsync().catch(() => {});
} catch {
  // noop — splash auto-hides, worst case is the old double transition (rule 1)
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null; eventId?: string }
> {
  state = { hasError: false, error: null as Error | null, eventId: undefined as string | undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // A crash during startup renders this boundary instead of SplashGate —
    // hide explicitly so the error UI isn't stranded behind the splash.
    try {
      SplashScreen.hideAsync().catch(() => {});
    } catch {
      // noop
    }
    const eventId = captureException(error, {
      tags: { boundary: 'root' },
      extra: {
        componentStack: info.componentStack ?? '',
        rootBoundaryDiagnostics,
      },
    });
    if (eventId) {
      this.setState({ eventId });
    }
  }

  render() {
    if (this.state.hasError) {
      const displayMessage = __DEV__
        ? (this.state.error?.message || 'An unexpected error occurred.')
        : 'Something unexpected happened. Please try again.';

      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <View style={{ width: '100%', maxWidth: 640, alignItems: 'center', paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8, textAlign: 'center', paddingHorizontal: 4 }}>
              Something went wrong
            </Text>
            <Text
              style={{
                width: '100%',
                fontSize: 14,
                lineHeight: 22,
                color: '#78716c',
                textAlign: 'center',
                marginBottom: 16,
                paddingHorizontal: 8,
                flexShrink: 1,
              }}
            >
              {displayMessage}
            </Text>
            <Pressable
              onPress={() => this.setState({ hasError: false, error: null, eventId: undefined })}
              style={{
                backgroundColor: '#0d8775',
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 8,
                minWidth: 128,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center', paddingHorizontal: 2 }}>
                Try Again
              </Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

function SplashGate() {
  const { isLoading } = useAuthReadiness();

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isLoading]);

  // Rule 24 watchdog: auth init hanging (Keystore read, dead network) must
  // never strand the user behind the splash. 10s sits below AuthProvider's
  // 15s watchdog so the splash always yields first; hideAsync is idempotent.
  useEffect(() => {
    const timeout = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 10_000);
    return () => clearTimeout(timeout);
  }, []);

  return null;
}

function RootDiagnosticsReporter() {
  const pathname = usePathname();
  const user = useAuthUser();
  const readiness = useAuthReadiness();
  const mfa = useAuthMfa();

  useEffect(() => {
    rootBoundaryDiagnostics = {
      route: coarseRoute(pathname),
      app_state: coarseAppState(AppState.currentState ?? 'unknown'),
      auth_loading: readiness.isLoading,
      authenticated: readiness.isAuthenticated,
      user_fetch_state: readiness.userFetchState,
      profile_source: readiness.profileSource,
      has_user: Boolean(user),
      mfa_required: mfa.mfaRequired,
      config_missing: CONFIG_MISSING,
    };
  }, [
    pathname,
    readiness.isLoading,
    readiness.isAuthenticated,
    readiness.userFetchState,
    readiness.profileSource,
    user,
    mfa.mfaRequired,
  ]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      rootBoundaryDiagnostics = {
        ...rootBoundaryDiagnostics,
        app_state: coarseAppState(next),
      };
    });
    return () => sub.remove();
  }, []);

  return null;
}

function ThemePreferenceHydrator() {
  const { setColorScheme } = useColorScheme();

  useEffect(() => {
    let cancelled = false;
    getThemePreference()
      .then((preference) => {
        if (cancelled) return;
        try {
          setColorScheme(preference);
        } catch (error) {
          if (__DEV__) console.error('[Theme] Failed to hydrate theme preference:', error);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setColorScheme]);

  return null;
}

function ThemedStatusBar() {
  const { colorScheme } = useColorScheme();
  const colors = useThemeColors();
  const style = colorScheme === 'dark' ? 'light' : 'dark';

  return (
    <StatusBar
      style={style}
      {...(Platform.OS === 'android' ? {} : { backgroundColor: colors.surface })}
    />
  );
}

export default function RootLayout() {
  const router = useRouter();

  // Deferred PostHog init — after the first frame so the posthog module +
  // expo-application/expo-device requires stay off the cold-start critical
  // path. Events fired before this (incl. AuthProvider startup events, whose
  // effects run before this parent's) are queued in analytics.ts and drained
  // on init. Idempotent, so a remount is harmless.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      try {
        initAnalytics();
      } catch {
        // rule 1 — analytics must never crash the app
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // The CONFIG_MISSING early return below bypasses SplashGate — hide the
  // splash explicitly so the config-error screen is actually visible.
  useEffect(() => {
    if (CONFIG_MISSING) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (_coldStartReported) return;
    _coldStartReported = true;
    trackEvent({ name: 'session_start', props: { cold_start_ms: Date.now() - COLD_START_AT } });

    // Permission snapshot is nonurgent. Run it after startup has had a chance
    // to paint content so expo-audio's native module load stays off the cold
    // critical path.
    const permissionTimer = setTimeout(() => {
      measurePhase('permission_snapshot', { skipped: false }, async () => {
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
      }).catch(() => {});
    }, 5_000);

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
      clearTimeout(permissionTimer);
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
            <RootDiagnosticsReporter />
            <SplashGate />
            <ThemePreferenceHydrator />
            <ThemedStatusBar />
            <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
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

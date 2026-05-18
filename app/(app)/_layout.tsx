import React, { useState, useCallback, useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, Text, ActivityIndicator, Pressable } from 'react-native';
import { AppLockGuard } from '../../src/components/AppLockGuard';
import { DeviceRegistrationBanner } from '../../src/components/DeviceRegistrationBanner';
import { breadcrumb } from '../../src/lib/monitoring';

const HALF_AUTH_TIMEOUT_MS = 30_000;

export default function AppLayout() {
  const {
    isAuthenticated,
    isLoading,
    user,
    userFetchState,
    userFetchError,
    retryFetchUser,
    signOut,
    mfaRequired,
  } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(() => {
    if (isRetrying) return;
    setIsRetrying(true);
    retryFetchUser()
      .catch(() => {
        // retryFetchUser sets userFetchError internally; swallow here to keep
        // the render-time handler from crashing on a rethrown rejection.
      })
      .finally(() => setIsRetrying(false));
  }, [isRetrying, retryFetchUser]);

  const handleSignOut = useCallback(() => {
    signOut().catch(() => {});
  }, [signOut]);

  // Half-auth fallback: when the layout is stuck on the spinner branch below
  // (session present but /auth/me hasn't returned), force a sign-out after a
  // grace period so the user reaches the login screen instead of an
  // indefinite blank spinner. The two paths into this state are (a) a hard
  // network outage during cold-start fetchUser, and (b) a hung native bridge
  // call (SecureStore, registerDevice). Both leave isLoading=false but
  // userFetchState='loading' or 'idle' with user=null.
  const isHalfAuth = isAuthenticated && !mfaRequired && !user && userFetchState !== 'error';
  useEffect(() => {
    if (!isHalfAuth) return;
    const t = setTimeout(() => {
      if (__DEV__) console.warn('[AppLayout] half-auth spinner stuck >30s, forcing signOut');
      breadcrumb('auth', 'half_auth_timeout', {});
      signOut().catch(() => {});
    }, HALF_AUTH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isHalfAuth, signOut]);

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

  if (mfaRequired) {
    return <Redirect href={'/(auth)/mfa' as never} />;
  }

  // Half-authenticated loading: session is set but /auth/me is still in flight
  // (or hasn't started yet). Holding at a spinner keeps user-scoped storage
  // safely unconfigured — draftStorage/stashStorage both check currentUserId
  // and a previous user's scope could otherwise leak across sign-out/sign-in
  // on a shared tablet. Also avoids gated queries firing with the wrong scope.
  if (!user && userFetchState !== 'error') {
    return (
      <View className="flex-1 justify-center items-center bg-stone-50">
        <ActivityIndicator size="large" color="#0d8775" />
      </View>
    );
  }

  // Half-authenticated recovery: session present but the user profile fetch
  // from /auth/me failed. Without this guard the app renders tabs with
  // user === null, which disables gated queries and leaves user-scoped
  // storage unconfigured. Block with a recovery screen until the user picks.
  if (!user && userFetchState === 'error') {
    return (
      <View className="flex-1 justify-center items-center bg-stone-50 px-8">
        <Text className="text-2xl font-semibold text-stone-900 text-center mb-3">
          Can&apos;t load your account
        </Text>
        <Text className="text-base text-stone-600 text-center mb-8">
          {userFetchError ?? 'Something went wrong while loading your account.'}
        </Text>
        <Pressable
          onPress={handleRetry}
          disabled={isRetrying}
          className="w-full bg-[#0d8775] rounded-lg py-4 mb-3 items-center"
          style={{ opacity: isRetrying ? 0.6 : 1 }}
        >
          {isRetrying ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-white font-semibold text-base">Retry</Text>
          )}
        </Pressable>
        <Pressable
          onPress={handleSignOut}
          className="w-full border border-stone-300 rounded-lg py-4 items-center"
        >
          <Text className="text-stone-700 font-medium text-base">Sign out</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <AppLockGuard>
      <View style={{ flex: 1 }}>
        <DeviceRegistrationBanner />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          {/* iOS interactive-pop swipe-back from screen edge intercepts the left
              trim handle's pan when the user starts the drag near the edge.
              Disable it here — the editor has its own back button. */}
          <Stack.Screen name="audio-editor" options={{ gestureEnabled: false }} />
        </Stack>
      </View>
    </AppLockGuard>
  );
}

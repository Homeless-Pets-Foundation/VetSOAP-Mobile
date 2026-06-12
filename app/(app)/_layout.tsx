import React, { useState, useCallback, useEffect } from 'react';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useAuth } from '../../src/hooks/useAuth';
import { View, Text, ActivityIndicator, Pressable, Alert } from 'react-native';
import { AppLockGuard } from '../../src/components/AppLockGuard';
import { DeviceRegistrationBanner } from '../../src/components/DeviceRegistrationBanner';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { ACCOUNT_LOAD_ERROR_COPY } from '../../src/constants/strings';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { breadcrumb } from '../../src/lib/monitoring';

const HALF_AUTH_TIMEOUT_MS = 30_000;

export default function AppLayout() {
  const router = useRouter();
  const colors = useThemeColors();
  const {
    isAuthenticated,
    isLoading,
    user,
    userFetchState,
    userFetchError,
    retryFetchUser,
    signOut,
    mfaRequired,
    localRecoveryState,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
  } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);
  const [halfAuthTimedOut, setHalfAuthTimedOut] = useState(false);

  const handleRetry = useCallback(() => {
    if (isRetrying) return;
    setHalfAuthTimedOut(false);
    setIsRetrying(true);
    retryFetchUser()
      .catch(() => {
        // retryFetchUser sets userFetchError internally; swallow here to keep
        // the render-time handler from crashing on a rethrown rejection.
      })
      .finally(() => setIsRetrying(false));
  }, [isRetrying, retryFetchUser]);

  const performBestEffortSignOut = useCallback(() => {
    signOut({ recoveryMode: 'best_effort' }).catch(() => {});
  }, [signOut]);

  const handleSignOut = useCallback(() => {
    if (isAuthenticated && !user) {
      Alert.alert(
        'Sign Out Without Profile?',
        'Your account profile has not loaded, so the app cannot verify whether local support-staff recordings can be protected. Sign out only if you understand unsent local recordings may not be recoverable.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign Out', style: 'destructive', onPress: performBestEffortSignOut },
        ]
      );
      return;
    }
    performBestEffortSignOut();
  }, [isAuthenticated, performBestEffortSignOut, user]);

  // Half-auth fallback: when the layout is stuck on the spinner branch below
  // (session present but /auth/me hasn't returned), show an explicit recovery
  // choice after a grace period. We avoid silently signing out because the app
  // cannot know whether local support-staff recordings need preservation until
  // the profile is loaded.
  const isHalfAuth = isAuthenticated && !mfaRequired && !user && userFetchState !== 'error';
  useEffect(() => {
    if (!isHalfAuth) {
      setHalfAuthTimedOut(false);
      return;
    }
    if (halfAuthTimedOut) return;
    const t = setTimeout(() => {
      if (__DEV__) console.warn('[AppLayout] half-auth spinner stuck >30s, showing recovery prompt');
      breadcrumb('auth', 'half_auth_timeout', {});
      setHalfAuthTimedOut(true);
    }, HALF_AUTH_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [halfAuthTimedOut, isHalfAuth]);

  useEffect(() => {
    if (!user || mfaRequired || localRecoveryState !== 'ready' || !pendingRecoveryDraftSlotId) return;
    const draftSlotId = consumePendingRecoveryDraftSlotId();
    if (!draftSlotId) return;
    router.replace({
      pathname: '/(tabs)/record',
      params: { draftSlotId },
    } as never);
  }, [
    consumePendingRecoveryDraftSlotId,
    localRecoveryState,
    mfaRequired,
    pendingRecoveryDraftSlotId,
    router,
    user,
  ]);

  if (__DEV__) console.log('[AppLayout] render: isLoading=', isLoading, 'isAuthenticated=', isAuthenticated);

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center bg-surface">
        <ActivityIndicator size="large" color={colors.brand500} />
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
  if (isHalfAuth && halfAuthTimedOut) {
    return (
      <View className="flex-1 justify-center items-center bg-surface px-8">
        <Text className="text-2xl font-semibold text-content-primary text-center mb-3">
          Still Loading Account
        </Text>
        <Text className="text-base text-content-secondary text-center mb-8">
          We could not finish loading your account profile. Stay signed in and retry if this tablet may have unsent local recordings.
        </Text>
        <Pressable
          onPress={handleRetry}
          disabled={isRetrying}
          className="w-full bg-brand-500 rounded-lg py-4 mb-3 items-center"
          style={{ opacity: isRetrying ? 0.6 : 1 }}
        >
          {isRetrying ? (
            <ActivityIndicator color={colors.contentOnBrand} />
          ) : (
            <Text className="text-content-on-brand font-semibold text-base">Retry</Text>
          )}
        </Pressable>
        <Pressable
          onPress={handleSignOut}
          className="w-full border border-border-strong rounded-lg py-4 items-center"
        >
          <Text className="text-content-body font-medium text-base">Sign out</Text>
        </Pressable>
      </View>
    );
  }

  if (!user && userFetchState !== 'error') {
    return (
      <View className="flex-1 justify-center items-center bg-surface">
        <ActivityIndicator size="large" color={colors.brand500} />
      </View>
    );
  }

  if (user && localRecoveryState === 'scanning') {
    return (
      <View className="flex-1 justify-center items-center bg-surface">
        <ActivityIndicator size="large" color={colors.brand500} />
      </View>
    );
  }

  // Half-authenticated recovery: session present but the user profile fetch
  // from /auth/me failed. Without this guard the app renders tabs with
  // user === null, which disables gated queries and leaves user-scoped
  // storage unconfigured. Block with a recovery screen until the user picks.
  if (!user && userFetchState === 'error') {
    return (
      <View className="flex-1 justify-center items-center bg-surface px-8">
        <Text className="text-2xl font-semibold text-content-primary text-center mb-3">
          {ACCOUNT_LOAD_ERROR_COPY.title}
        </Text>
        <Text className="text-base text-content-secondary text-center mb-8">
          {ACCOUNT_LOAD_ERROR_COPY.body}
        </Text>
        <Pressable
          onPress={handleRetry}
          disabled={isRetrying}
          className="w-full bg-brand-500 rounded-lg py-4 mb-4 items-center"
          style={{ opacity: isRetrying ? 0.6 : 1 }}
        >
          {isRetrying ? (
            <ActivityIndicator color={colors.contentOnBrand} />
          ) : (
            <Text className="text-content-on-brand font-semibold text-base">{ACCOUNT_LOAD_ERROR_COPY.retry}</Text>
          )}
        </Pressable>
        <Pressable onPress={handleSignOut} className="py-3 px-4" style={{ minHeight: 44 }}>
          <Text className="text-content-tertiary text-body-sm underline text-center">
            {ACCOUNT_LOAD_ERROR_COPY.signOut}
          </Text>
        </Pressable>
        {userFetchError ? (
          <Text className="text-caption text-content-tertiary text-center mt-6" numberOfLines={3}>
            {ACCOUNT_LOAD_ERROR_COPY.detailsPrefix}
            {userFetchError}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <AppLockGuard>
      <View style={{ flex: 1 }}>
        <DeviceRegistrationBanner />
        <OfflineBanner />
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

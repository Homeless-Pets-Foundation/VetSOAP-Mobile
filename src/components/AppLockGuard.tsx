import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { View, Text, Image, AppState, Alert } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { biometrics } from '../lib/biometrics';
import { AuthContext } from '../auth/AuthProvider';
import { Button } from './ui/Button';

const BACKGROUND_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

interface AppLockGuardProps {
  children: React.ReactNode;
}

/**
 * Wraps authenticated screens and requires biometric re-auth
 * when the app returns from background after a threshold duration
 * AND on initial app launch (cold start) when a session is restored.
 */
export function AppLockGuard({ children }: AppLockGuardProps) {
  const { signOut } = useContext(AuthContext);
  // Default to true — assume locked until we verify biometric is not needed.
  // This prevents a brief flash of PHI content before the lock screen renders.
  const [isLocked, setIsLocked] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const isAuthenticatingRef = useRef(false);
  // Cached "biometric lock is active" state. Drives the bg-resume path so we can
  // call setIsLocked(true) synchronously — before awaiting biometrics.isAvailable() /
  // isEnabled() — to prevent PHI from flashing on the screen during the async check.
  const shouldLockOnBgRef = useRef(false);

  const handleLockScreenSignOut = useCallback(() => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            signOut().catch(() => {});
          },
        },
      ]
    );
  }, [signOut]);

  const attemptUnlock = useCallback(async () => {
    if (isAuthenticatingRef.current) return;
    isAuthenticatingRef.current = true;
    setIsAuthenticating(true);
    try {
      const success = await biometrics.authenticate('Verify your identity to continue');
      if (success) {
        setIsLocked(false);
      }
    } catch (error) {
      if (__DEV__) console.error('[AppLockGuard] attemptUnlock failed:', error);
    } finally {
      isAuthenticatingRef.current = false;
      setIsAuthenticating(false);
    }
  }, []);

  // Cold-start biometric check: on mount, check if biometric lock is enabled.
  // If so, require authentication before showing content.
  useEffect(() => {
    (async () => {
      try {
        const [available, enabled] = await Promise.all([
          biometrics.isAvailable(),
          biometrics.isEnabled(),
        ]);

        shouldLockOnBgRef.current = available && enabled;
        if (available && enabled) {
          // Keep locked and trigger biometric prompt
          setIsReady(true);
          isAuthenticatingRef.current = true;
          setIsAuthenticating(true);
          try {
            const success = await biometrics.authenticate(
              'Verify your identity to continue'
            );
            if (success) {
              setIsLocked(false);
            }
          } finally {
            isAuthenticatingRef.current = false;
            setIsAuthenticating(false);
          }
        } else {
          // Biometric not available or not enabled — unlock immediately
          setIsLocked(false);
          setIsReady(true);
        }
      } catch {
        // On error, unlock to avoid permanently locking user out
        setIsLocked(false);
        setIsReady(true);
      }
    })().catch(() => {
      setIsLocked(false);
      setIsReady(true);
    });
  }, []);

  // Background/foreground lock handler
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      (async () => {
        try {
          if (nextState === 'background' || nextState === 'inactive') {
            backgroundedAtRef.current = Date.now();
            return;
          }

          // App came to foreground
          if (nextState === 'active' && backgroundedAtRef.current) {
            const elapsed = Date.now() - backgroundedAtRef.current;
            backgroundedAtRef.current = null;

            if (
              elapsed >= BACKGROUND_LOCK_THRESHOLD_MS &&
              shouldLockOnBgRef.current &&
              !isAuthenticatingRef.current
            ) {
              // Lock synchronously before any await — keeps PHI off the screen
              // while we re-verify biometric availability. If the cached value is
              // stale (biometric disabled between foregrounds), we'll unlock below.
              isAuthenticatingRef.current = true;
              setIsLocked(true);
              setIsAuthenticating(true);
              try {
                const [available, enabled] = await Promise.all([
                  biometrics.isAvailable(),
                  biometrics.isEnabled(),
                ]);
                shouldLockOnBgRef.current = available && enabled;

                if (!available || !enabled) {
                  // Cached value was stale — unlock without prompting.
                  setIsLocked(false);
                } else {
                  const success = await biometrics.authenticate(
                    'Verify your identity to continue'
                  );
                  if (success) {
                    setIsLocked(false);
                  }
                }
              } finally {
                isAuthenticatingRef.current = false;
                setIsAuthenticating(false);
              }
            }
          }
        } catch (error) {
          if (__DEV__) console.error('[AppLockGuard] handleAppStateChange error:', error);
          isAuthenticatingRef.current = false;
          setIsAuthenticating(false);
        }
      })().catch(() => {});
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  // While checking biometric state on cold start, show nothing (prevents flash)
  if (!isReady && isLocked) {
    return (
      <View className="flex-1 bg-stone-50" />
    );
  }

  if (isLocked) {
    return (
      <View className="flex-1 justify-center items-center p-6 bg-stone-50">
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: '60%', maxWidth: 280, aspectRatio: 600 / 139 }}
          resizeMode="contain"
          accessibilityLabel="Captivet"
          className="mb-4"
        />
        <Text className="text-body-lg font-bold text-stone-900 mb-2">
          Captivet Locked
        </Text>
        <Text className="text-body-sm text-stone-500 text-center mb-6">
          Authenticate to continue using the app.
        </Text>
        <Button
          variant="primary"
          size="lg"
          onPress={() => { attemptUnlock().catch(() => {}); }}
          loading={isAuthenticating}
          accessibilityLabel="Unlock with biometrics"
        >
          Unlock
        </Button>
        <View className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            onPress={handleLockScreenSignOut}
            accessibilityLabel="Sign out of the app"
          >
            Sign Out
          </Button>
        </View>
      </View>
    );
  }

  return <>{children}</>;
}

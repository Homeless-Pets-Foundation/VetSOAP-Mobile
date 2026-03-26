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
 * when the app returns from background after a threshold duration.
 */
export function AppLockGuard({ children }: AppLockGuardProps) {
  const { signOut } = useContext(AuthContext);
  const [isLocked, setIsLocked] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const isAuthenticatingRef = useRef(false);

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
            signOut().then(() => setIsLocked(false)).catch(() => { setIsLocked(false); });
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

            if (elapsed >= BACKGROUND_LOCK_THRESHOLD_MS) {
              const [available, enabled] = await Promise.all([
                biometrics.isAvailable(),
                biometrics.isEnabled(),
              ]);

              if (available && enabled && !isAuthenticatingRef.current) {
                isAuthenticatingRef.current = true;
                setIsLocked(true);
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

  if (isLocked) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 24,
          backgroundColor: '#fafaf9',
        }}
      >
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: '60%', maxWidth: 280, aspectRatio: 600 / 139, marginBottom: 16 }}
          resizeMode="contain"
          accessibilityLabel="Captivet"
        />
        <Text
          style={{ fontSize: 18, fontWeight: 'bold', color: '#1c1917', marginBottom: 8 }}
        >
          Captivet Locked
        </Text>
        <Text
          style={{
            fontSize: 14,
            color: '#78716c',
            textAlign: 'center',
            marginBottom: 24,
          }}
        >
          Authenticate to continue using the app.
        </Text>
        <Button
          variant="primary"
          size="lg"
          onPress={attemptUnlock}
          loading={isAuthenticating}
          accessibilityLabel="Unlock with biometrics"
        >
          Unlock
        </Button>
        <View style={{ marginTop: 16 }}>
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

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { biometrics } from '../lib/biometrics';
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
  const [isLocked, setIsLocked] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);

  const attemptUnlock = useCallback(async () => {
    setIsAuthenticating(true);
    const success = await biometrics.authenticate('Verify your identity to continue');
    if (success) {
      setIsLocked(false);
    }
    setIsAuthenticating(false);
  }, []);

  useEffect(() => {
    const handleAppStateChange = async (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundedAtRef.current = Date.now();
        return;
      }

      // App came to foreground
      if (nextState === 'active' && backgroundedAtRef.current) {
        const elapsed = Date.now() - backgroundedAtRef.current;
        backgroundedAtRef.current = null;

        if (elapsed >= BACKGROUND_LOCK_THRESHOLD_MS) {
          // Check if biometric is enabled
          const [available, enabled] = await Promise.all([
            biometrics.isAvailable(),
            biometrics.isEnabled(),
          ]);

          if (available && enabled) {
            setIsLocked(true);
            // Auto-prompt
            setIsAuthenticating(true);
            const success = await biometrics.authenticate(
              'Verify your identity to continue'
            );
            if (success) {
              setIsLocked(false);
            }
            setIsAuthenticating(false);
          }
        }
      }
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
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            backgroundColor: '#0d8775',
            justifyContent: 'center',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <Text style={{ fontSize: 28, color: '#fff', fontWeight: 'bold' }}>V</Text>
        </View>
        <Text
          style={{ fontSize: 18, fontWeight: 'bold', color: '#1c1917', marginBottom: 8 }}
        >
          VetSOAP Locked
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
      </View>
    );
  }

  return <>{children}</>;
}

import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { AccessibilityInfo, ActivityIndicator, View, Image, AppState, Alert } from 'react-native';
import { Text } from './ui/Text';
import type { AppStateStatus } from 'react-native';
import { biometrics } from '../lib/biometrics';
import { AuthContext } from '../auth/AuthProvider';
import { captureMessage } from '../lib/monitoring';
import { Button } from './ui/Button';
import { useThemeColors } from '../hooks/useThemeColors';
import { withPromiseTimeout } from '../lib/promiseTimeout';
import { APP_LOCK_COPY } from '../constants/strings';
import {
  APPLOCK_INIT_WATCHDOG_MS,
  APPLOCK_PROBE_TIMEOUT_MS,
  APPLOCK_PROMPT_TIMEOUT_MS,
  APPLOCK_RESUME_WATCHDOG_MS,
  consumeAppLockHang,
  decideAfterProbe,
  decideAfterPrompt,
  decideCoarseWatchdog,
} from '../lib/appLockPolicy';
import type {
  AppLockTelemetry,
  BgLockState,
  LockPath,
  ProbeOutcome,
  PromptOutcome,
} from '../lib/appLockPolicy';

const BACKGROUND_LOCK_THRESHOLD_MS = 30_000; // 30 seconds

interface AppLockGuardProps {
  children: React.ReactNode;
}

function emit(telemetry: AppLockTelemetry | null): void {
  if (!telemetry) return;
  captureMessage(telemetry.message, 'warning', {
    tags: { phase: telemetry.phase, op: telemetry.op },
    extra: { timeout_ms: telemetry.timeoutMs },
  });
}

/** A Promise that never settles — the `__DEV__` hang injector (see appLockPolicy). */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * Bounded availability probe. `biometrics.*` never rejects, so the only
 * outcome this has to add is "it never answered".
 */
async function probeGate(path: LockPath): Promise<ProbeOutcome> {
  try {
    const source = consumeAppLockHang(`${path}:probe`)
      ? neverSettles<[boolean, boolean]>()
      : Promise.all([biometrics.isAvailable(), biometrics.isEnabled()]);
    const [available, enabled] = await withPromiseTimeout(
      source,
      APPLOCK_PROBE_TIMEOUT_MS,
      'applock_probe_timeout',
    );
    return { kind: 'resolved', available, enabled };
  } catch {
    return { kind: 'timeout' };
  }
}

/**
 * Bounded biometric prompt. Keeps `timeout` distinct from `rejected` — a
 * cancel and a dead bridge are different failures with different copy.
 */
async function runPrompt(hang: boolean): Promise<PromptOutcome> {
  try {
    const source = hang
      ? neverSettles<boolean>()
      : biometrics.authenticate('Verify your identity to continue');
    const success = await withPromiseTimeout(
      source,
      APPLOCK_PROMPT_TIMEOUT_MS,
      'applock_prompt_timeout',
    );
    return success ? 'success' : 'rejected';
  } catch {
    return 'timeout';
  }
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
  const [unlockHint, setUnlockHint] = useState<string | null>(null);
  const colors = useThemeColors();
  const backgroundedAtRef = useRef<number | null>(null);
  const isAuthenticatingRef = useRef(false);
  // Cached "biometric lock is active" state. Drives the bg-resume path so we can
  // call setIsLocked(true) synchronously — before awaiting biometrics.isAvailable() /
  // isEnabled() — to prevent PHI from flashing on the screen during the async check.
  //
  // Tri-state, not a boolean: a cold-start watchdog that fires before the probe
  // resolves must leave this 'unknown', not 'off'. While it was a boolean, that
  // case silently disarmed the background lock for the whole session.
  const bgLockRef = useRef<BgLockState>('unknown');

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

  useEffect(() => {
    if (isReady && isLocked) AccessibilityInfo.announceForAccessibility('App locked');
  }, [isReady, isLocked]);

  const attemptUnlock = useCallback(async () => {
    if (isAuthenticatingRef.current) return;
    isAuthenticatingRef.current = true;
    setIsAuthenticating(true);
    try {
      // Bounded: an unbounded authenticate() that hangs here never reaches the
      // `finally`, which pinned the ref true and made every later retry a
      // no-op — the Unlock button stayed spinning with Sign Out the only exit.
      const outcome = await runPrompt(consumeAppLockHang('manual:prompt'));
      const decision = decideAfterPrompt('manual', outcome);
      setIsLocked(decision.locked);
      setUnlockHint(decision.hint);
      emit(decision.telemetry);
    } catch (error) {
      if (__DEV__) console.error('[AppLockGuard] attemptUnlock failed:', error);
    } finally {
      isAuthenticatingRef.current = false;
      setIsAuthenticating(false);
    }
  }, []);

  // Cold-start biometric check: on mount, check if biometric lock is enabled.
  // If so, require authentication before showing content.
  //
  // Hung-bridge defense (CLAUDE.md rule 24): if `biometrics.isAvailable()` /
  // `isEnabled()` / `authenticate()` hang silently (post-update Keystore
  // rebuild, OS biometric service stall) the user would see the blank
  // `bg-surface` splash forever. Two layers: `withPromiseTimeout` inside
  // probeGate/runPrompt, and the coarse watchdog below.
  //
  // The coarse watchdog covers the PROBE ONLY and is cleared the moment the
  // probe settles. It used to be cleared in the outer `.finally()`, which waits
  // on the prompt — so a user who hesitated more than 12s at the OS prompt had
  // the app unlock itself behind a live biometric prompt.
  useEffect(() => {
    let cancelled = false;
    const watchdog = setTimeout(() => {
      if (cancelled) return;
      const decision = decideCoarseWatchdog('init');
      emit(decision.telemetry);
      isAuthenticatingRef.current = false;
      setIsAuthenticating(false);
      if (decision.locked !== null) setIsLocked(decision.locked);
      setIsReady(decision.ready);
    }, APPLOCK_INIT_WATCHDOG_MS);

    (async () => {
      let probe: ProbeOutcome;
      try {
        probe = await probeGate('init');
      } finally {
        clearTimeout(watchdog);
      }
      if (cancelled) return;

      const decision = decideAfterProbe('init', bgLockRef.current, probe);
      bgLockRef.current = decision.bgLock;
      emit(decision.telemetry);

      if (decision.action === 'settle') {
        setIsLocked(decision.locked);
        setIsReady(decision.ready);
        return;
      }

      // Keep locked and trigger biometric prompt.
      setIsReady(true);
      isAuthenticatingRef.current = true;
      setIsAuthenticating(true);
      try {
        const outcome = await runPrompt(consumeAppLockHang('init:prompt'));
        if (cancelled) return;
        const promptDecision = decideAfterPrompt('init', outcome);
        setIsLocked(promptDecision.locked);
        setUnlockHint(promptDecision.hint);
        emit(promptDecision.telemetry);
      } finally {
        isAuthenticatingRef.current = false;
        setIsAuthenticating(false);
      }
    })().catch(() => {
      // Defensive: nothing above rethrows, but a throw must never leave the
      // user on the blank splash.
      if (cancelled) return;
      setIsLocked(false);
      setIsReady(true);
    });

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, []);

  // Background/foreground lock handler
  useEffect(() => {
    let disposed = false;

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
              // 'unknown' arms the check too — it re-probes and resolves safely.
              // Only a PROVEN 'off' skips it.
              bgLockRef.current !== 'off' &&
              !isAuthenticatingRef.current
            ) {
              // Lock synchronously before any await — keeps PHI off the screen
              // while we re-verify biometric availability. If the cached value is
              // stale (biometric disabled between foregrounds), we'll unlock below.
              isAuthenticatingRef.current = true;
              setIsLocked(true);
              setIsAuthenticating(true);

              // Coarse outer watchdog — the layer this path never had. It
              // releases the spinner and the re-entrancy ref so Unlock works
              // again, and deliberately does NOT unlock: a hung sensor must
              // never reveal a PHI screen on a timer.
              let watchdogFired = false;
              const watchdog = setTimeout(() => {
                if (disposed) return;
                watchdogFired = true;
                const coarse = decideCoarseWatchdog('resume');
                emit(coarse.telemetry);
                isAuthenticatingRef.current = false;
                setIsAuthenticating(false);
                if (coarse.locked !== null) setIsLocked(coarse.locked);
                setUnlockHint(coarse.hint);
              }, APPLOCK_RESUME_WATCHDOG_MS);

              try {
                let probe: ProbeOutcome;
                try {
                  probe = await probeGate('resume');
                } finally {
                  clearTimeout(watchdog);
                }
                if (disposed || watchdogFired) return;

                const decision = decideAfterProbe('resume', bgLockRef.current, probe);
                bgLockRef.current = decision.bgLock;
                emit(decision.telemetry);

                if (decision.action === 'settle') {
                  setIsLocked(decision.locked);
                  return;
                }

                const outcome = await runPrompt(consumeAppLockHang('resume:prompt'));
                if (disposed) return;
                const promptDecision = decideAfterPrompt('resume', outcome);
                setIsLocked(promptDecision.locked);
                setUnlockHint(promptDecision.hint);
                emit(promptDecision.telemetry);
              } finally {
                clearTimeout(watchdog);
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
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, []);

  // While checking biometric state on cold start, show branding + a spinner
  // (no PHI). A fully blank view read as a frozen app for up to the watchdog
  // window when the biometric bridge stalled.
  if (!isReady && isLocked) {
    return (
      <View className="flex-1 justify-center items-center bg-surface">
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: '60%', maxWidth: 280, aspectRatio: 600 / 139 }}
          resizeMode="contain"
          accessibilityLabel="Captivet"
          className="mb-6"
        />
        <ActivityIndicator size="large" color={colors.brand500} accessibilityLabel="Loading" />
      </View>
    );
  }

  if (isLocked) {
    return (
      <View className="flex-1 justify-center items-center p-6 bg-surface">
        <Image
          source={require('../../assets/logo-wordmark.png')}
          style={{ width: '60%', maxWidth: 280, aspectRatio: 600 / 139 }}
          resizeMode="contain"
          accessibilityLabel="Captivet"
          className="mb-4"
        />
        <Text className="text-body-lg font-bold text-content-primary mb-2">
          {APP_LOCK_COPY.title}
        </Text>
        <Text className="text-body-sm text-content-tertiary text-center mb-6">
          {APP_LOCK_COPY.subtitle}
        </Text>
        {unlockHint && (
          <Text
            className="text-body-sm text-status-warning text-center mb-4"
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {unlockHint}
          </Text>
        )}
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

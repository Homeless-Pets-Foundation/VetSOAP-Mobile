import React, { createContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import type { AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { Session } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as ScreenCapture from 'expo-screen-capture';
import { Paths, Directory, File as ExpoFile } from 'expo-file-system';
import { usePathname, useRouter } from 'expo-router';
import { safeDeleteFile } from '../lib/fileOps';
import { supabase } from './supabase';
import { API_URL } from '../config';
import { validateRequestUrl } from '../lib/sslPinning';
import {
  signInWithGoogleNative,
  signInWithAppleNative,
  signOutNativeGoogle,
  waitForPendingAppleProfileSync,
  type AuthResult,
} from './socialAuth';
import { secureStorage } from '../lib/secureStorage';
import { apiClient, ApiError } from '../api/client';
import type { DeviceCapacity, DeviceSession } from '../api/devices';
import { stashStorage } from '../lib/stashStorage';
import { stashAudioManager } from '../lib/stashAudioManager';
import { draftStorage } from '../lib/draftStorage';
import { audioTempFiles } from '../lib/audioTempFiles';
import { queryClient } from '../lib/queryClient';
import { audioEditorBridge } from '../lib/audioEditorBridge';
import { clearClipboard } from '../lib/secureClipboard';
import { clearPeakCache } from '../lib/waveformCache';
import { setLogoutReason } from '../lib/logoutReason';
import { setMonitoringUser, clearMonitoringUser, captureException, captureMessage, breadcrumb } from '../lib/monitoring';
import { identifyUser, resetAnalytics, flushAnalytics, trackEvent } from '../lib/analytics';
import type { User } from '../types';
import { MFA_REQUEST_TIMEOUT_MS, mfaErrorMessage } from './mfaPolicy';

/**
 * Collapse Supabase AuthError into a small, PHI-safe enum suitable for an
 * event `error_code`. Never include the raw message — it can contain an
 * email address or other user-identifying detail.
 */
function classifyAuthError(error: { name?: string; message?: string; status?: number | null }): string {
  if (error.name === 'AuthRetryableFetchError') return 'retryable_fetch';
  if (error.status === 0) return 'network';
  if (error.message?.includes('fetch')) return 'network';
  if (error.message?.includes('Email not confirmed')) return 'email_not_confirmed';
  if (error.message?.includes('Invalid login')) return 'invalid_credentials';
  if (error.status === 400) return 'invalid_credentials';
  if (error.status === 422) return 'invalid_payload';
  if (error.status === 429) return 'rate_limited';
  if (error.status && error.status >= 500) return 'server_error';
  return 'other';
}

/**
 * Tracks the bootstrap state of the user profile fetched from /auth/me after
 * Supabase establishes a session.
 *
 * - `idle`    — no fetch has run yet in the current session lifecycle.
 * - `loading` — fetch in flight (or retry in progress).
 * - `success` — user loaded; app is fully usable.
 * - `error`   — all retries failed. The app must surface a recovery UI
 *               (retry / sign out) because `isAuthenticated` is true but
 *               `user === null`, which disables gated queries and breaks
 *               user-scoped storage.
 */
type UserFetchState = 'idle' | 'loading' | 'success' | 'error';
type FetchUserAttemptResult = 'loaded' | 'deferred';

/**
 * Surfaced when POST /api/device-sessions/register returns 403
 * DEVICE_LIMIT_REACHED. Carries everything the hard-limit modal needs to
 * render an actionable revoke list without a follow-up request.
 */
export interface DeviceRegistrationBlock {
  existingDevices: DeviceSession[];
  capacity: DeviceCapacity | null;
}

type AuthAssuranceLevel = 'aal1' | 'aal2';

interface MfaFactor {
  id: string;
  friendlyName: string | null;
  factorType: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

interface MfaEnrollment {
  factorId: string;
  uri: string;
  secret: string;
}

interface MfaChallenge {
  factorId: string;
  challengeId: string;
}

interface MfaStatusResponse {
  currentLevel?: AuthAssuranceLevel;
  nextLevel?: AuthAssuranceLevel;
  required?: boolean;
  enrollmentRequired?: boolean;
  staleSession?: boolean;
  reason?: string;
  verifiedAt?: number | null;
  maxAgeSeconds?: number;
}

interface MfaApiResponse extends MfaStatusResponse {
  user?: User;
  factors?: unknown[];
  factorId?: string;
  challengeId?: string;
  uri?: string;
  secret?: string;
  tokens?: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: string | null;
  };
  mfa?: MfaStatusResponse;
  code?: string;
  error?: string;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  userFetchState: UserFetchState;
  userFetchError: string | null;
  retryFetchUser: () => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signInWithGoogle: () => Promise<AuthResult>;
  signInWithApple: () => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** Set when device registration is blocked by the per-user device cap. */
  deviceRegistrationBlock: DeviceRegistrationBlock | null;
  /** User dismissed the modal manually (e.g. backdrop tap). */
  dismissDeviceRegistrationBlock: () => void;
  /** Retry register after the user revoked one of their devices. */
  retryDeviceRegistration: () => Promise<boolean>;
  /**
   * True when the most recent device registration attempt failed for a
   * non-limit reason (network, 5xx, transient). The banner uses this to
   * prompt the user to retry instead of silently leaving every /api/*
   * call stuck behind 428 DEVICE_REGISTRATION_REQUIRED.
   */
  deviceRegistrationPending: boolean;
  /**
   * True while the user is mid password-reset deep-link flow: Supabase has
   * established a session from the recovery token, but the user has not yet
   * set a new password. `(auth)/_layout.tsx` reads this flag and skips its
   * "already authenticated → /" redirect so the reset-password screen can
   * render instead.
   */
  isPasswordRecovery: boolean;
  /** Called by the reset-password screen after it finishes (success or cancel). */
  clearPasswordRecovery: () => void;
  mfaRequired: boolean;
  mfaReturnPath: string | null;
  mfaReason: string | null;
  mfaCurrentLevel: AuthAssuranceLevel;
  mfaNextLevel: AuthAssuranceLevel;
  refreshMfaStatus: () => Promise<MfaStatusResponse>;
  listMfaFactors: () => Promise<MfaFactor[]>;
  enrollMfaFactor: (friendlyName?: string, bootstrapCode?: string) => Promise<MfaEnrollment>;
  startMfaChallenge: (factorId?: string) => Promise<MfaChallenge>;
  verifyMfaChallenge: (code: string) => Promise<void>;
  verifyMfaEnrollment: (factorId: string, code: string) => Promise<void>;
  clearMfaChallenge: () => void;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isAuthenticated: false,
  isLoading: true,
  userFetchState: 'idle',
  userFetchError: null,
  retryFetchUser: async () => false,
  signIn: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signInWithApple: async () => ({ error: null }),
  signOut: async () => {},
  deviceRegistrationBlock: null,
  dismissDeviceRegistrationBlock: () => {},
  retryDeviceRegistration: async () => false,
  deviceRegistrationPending: false,
  isPasswordRecovery: false,
  clearPasswordRecovery: () => {},
  mfaRequired: false,
  mfaReturnPath: null,
  mfaReason: null,
  mfaCurrentLevel: 'aal1',
  mfaNextLevel: 'aal1',
  refreshMfaStatus: async () => ({ required: false }),
  listMfaFactors: async () => [],
  enrollMfaFactor: async () => {
    throw new Error('MFA is not available.');
  },
  startMfaChallenge: async () => {
    throw new Error('MFA is not available.');
  },
  verifyMfaChallenge: async () => {},
  verifyMfaEnrollment: async () => {},
  clearMfaChallenge: () => {},
});

/** Check if the Supabase session token has expired. */
function isTokenExpired(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined || expiresAt === null) return false;
  return Date.now() / 1000 > expiresAt;
}

/** Delete orphaned audio recordings from the cache directory. */
function cleanupAudioCache(): void {
  try {
    const cacheDir = new Directory(Paths.cache);
    if (!cacheDir.exists) return;
    for (const item of cacheDir.list()) {
      if (item instanceof ExpoFile && item.name.endsWith('.m4a')) {
        safeDeleteFile(item.uri);
      }
    }
  } catch {
    // Cache cleanup is best-effort
  }
}

/** Set user ID on stash modules so they scope data per-user. */
function setStashUserId(userId: string | null): void {
  stashStorage.setUserId(userId);
  stashAudioManager.setUserId(userId);
}

/**
 * Drop Sentry + PostHog identity so subsequent events / errors don't
 * attribute to the signed-out user. Shared between user-initiated sign-out
 * (`handleSignOut`) and the SIGNED_OUT fallback in `onAuthStateChange` —
 * without this, a session expiry or device revocation leaves the prior
 * user's id attached to any error captured before the next sign-in.
 */
function clearTelemetryIdentity(): void {
  flushAnalytics().catch(() => {});
  clearMonitoringUser();
  resetAnalytics();
}

/**
 * Delete all per-user PHI from on-device storage. Must run while the scope
 * user IDs are still set so the clearAll methods can read the correct data.
 * Every entry is best-effort — a single failure must not block logout.
 * Called from both the explicit sign-out path and the SIGNED_OUT fallback
 * in onAuthStateChange so transient session expiry cleans up the same set
 * of artefacts as a user-initiated sign-out.
 */
/**
 * Race a possibly-hanging cleanup promise against a deadline. The cleanup
 * paths in sign-out reach into native bridges (SecureStore Keychain,
 * Google Sign-In, file system) that can permanently hang on iOS — when that
 * happens there is no recovery short of killing the app, which the user
 * sees as a blank loading screen because `isLoading` never flips back to
 * false. `withTimeout` ensures the chain always advances to `setUser(null)`.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const safeguard = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      breadcrumb('auth', 'init_watchdog_fired', { label, ms });
      // Snapshot diagnostic context at fire time so we can tell apart the
      // distinct hang modes that all look identical from the watchdog (Sentry
      // REACT-NATIVE-9): a network-blackholed cold start, a foreground
      // resume against a poisoned Supabase auto-refresh AbortController
      // (rule 27), and a SecureStore Keystore read that never returns. Run
      // the NetInfo lookup off the resolve path so a hanging NetInfo bridge
      // can't extend the very stall we're trying to capture.
      const appStateAtFire = AppState.currentState;
      NetInfo.fetch()
        .catch(() => null)
        .then((net) => {
          captureMessage('init_watchdog_fired', 'warning', {
            tags: {
              phase: 'init_watchdog',
              op: label,
              app_state: appStateAtFire,
              net_type: net?.type ?? 'unknown',
              net_reachable:
                net?.isInternetReachable === null
                  ? 'unknown'
                  : net?.isInternetReachable === true
                  ? 'true'
                  : 'false',
            },
            extra: { timeout_ms: ms },
          });
        })
        .catch(() => { /* never let diagnostic capture crash Hermes */ });
      resolve(null);
    }, ms);
  });
  return Promise.race([
    p.then((v) => {
      if (timer) clearTimeout(timer);
      return v;
    }).catch(() => {
      if (timer) clearTimeout(timer);
      return null;
    }),
    safeguard,
  ]);
}

async function performPhiCleanup(): Promise<void> {
  try {
    await Promise.all([
      stashStorage.clearAllStashes().catch(() =>
        stashStorage.clearAllStashes()
      ).catch(() => {}),
      stashAudioManager.deleteAllStashedAudio().catch(() =>
        stashAudioManager.deleteAllStashedAudio()
      ).catch(() => {}),
      draftStorage.clearAll().catch(() => {}),
      Promise.resolve(cleanupAudioCache()),
      Promise.resolve(audioTempFiles.cleanupAll()),
      Promise.resolve(clearPeakCache()),
    ]);
  } catch {
    // All cleanup is best-effort — don't block sign-out indefinitely
  }
  audioEditorBridge.clear();
  clearClipboard();
}

/**
 * Transient-looking errors from /auth/me that deserve a retry. Deliberately
 * narrow: a 401 is already handled by apiClient's refresh flow, a 403 /
 * 404 / 422 shouldn't be retried, and anything not matching here lands
 * directly in the error state.
 */
function isRetryableFetchUserError(error: unknown): boolean {
  if (error instanceof TypeError && /network/i.test(error.message)) return true;
  if (error instanceof ApiError) {
    // 5xx and network-layer 0 both warrant a retry.
    return error.status === 0 || error.status >= 500;
  }
  return false;
}

function fetchUserErrorMessage(error: unknown): string {
  if (error instanceof TypeError && /network/i.test(error.message)) {
    return 'No internet connection. Check your network and try again.';
  }
  if (error instanceof ApiError) {
    return error.message || `Server error (HTTP ${error.status}).`;
  }
  if (error instanceof Error) return error.message;
  return 'Failed to load your account.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userFetchState, setUserFetchState] = useState<UserFetchState>('idle');
  const [userFetchError, setUserFetchError] = useState<string | null>(null);
  const [deviceRegistrationBlock, setDeviceRegistrationBlock] =
    useState<DeviceRegistrationBlock | null>(null);
  const [deviceRegistrationPending, setDeviceRegistrationPending] = useState(false);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaReturnPath, setMfaReturnPath] = useState<string | null>(null);
  const [mfaReason, setMfaReason] = useState<string | null>(null);
  const [mfaCurrentLevel, setMfaCurrentLevel] = useState<AuthAssuranceLevel>('aal1');
  const [mfaNextLevel, setMfaNextLevel] = useState<AuthAssuranceLevel>('aal1');
  const [activeMfaChallenge, setActiveMfaChallenge] = useState<MfaChallenge | null>(null);

  const clearPasswordRecovery = useCallback(() => {
    setIsPasswordRecovery(false);
  }, []);

  // Tracks when the current session was established, so we can ignore stale 401s
  const sessionTimestampRef = useRef<number>(0);
  const handleSignOutRef = useRef<() => Promise<void>>(async () => {});
  // Single-flight guard for registerDevice. `fetchUser()` owns the normal
  // sign-in/session-restore registration path, while API 428 handlers and the
  // device-limit modal can still retry manually.
  const registerDeviceInFlightRef = useRef<Promise<boolean> | null>(null);
  // Distinguishes user-initiated sign-out from session expiry in onAuthStateChange.
  // When Supabase emits SIGNED_OUT due to a failed refresh, this flag is false —
  // allowing one recovery refresh attempt before clearing auth state.
  const userInitiatedSignOutRef = useRef<boolean>(false);

  const applyFetchedUser = useCallback((fetchedUser: User | null) => {
    setUser(fetchedUser);
    if (fetchedUser) {
      setMfaRequired(false);
      setMfaReturnPath(null);
      setMfaReason(null);
      setActiveMfaChallenge(null);
    }
    if (!fetchedUser?.id) return;
    const scopedUserId = fetchedUser.id;
    // Tag monitoring + analytics with the user id (no email / name / PHI).
    setMonitoringUser(scopedUserId, fetchedUser.organizationId);
    identifyUser(scopedUserId, fetchedUser.organizationId);
    const isRecoveryScopeCurrent = () =>
      stashStorage.getUserId() === scopedUserId &&
      stashAudioManager.getUserId() === scopedUserId;

    setStashUserId(scopedUserId);
    draftStorage.setUserId(scopedUserId);
    // Now that user ID is set, safe to clean up orphaned stash data.
    // Must run AFTER setStashUserId or getStashedSessions returns []
    // and all stash audio dirs get deleted as "orphaned".
    stashStorage.clearLegacyGlobalStashes().catch(() => {});
    stashAudioManager.deleteAllStashedAudioGlobal().catch(() => {});
    stashStorage.getStashedSessions().then(async (sessions) => {
      if (!isRecoveryScopeCurrent()) return;
      const validIds = sessions.map((s) => s.id);
      const recovered = await stashAudioManager.recoverOrCleanupOrphans(validIds);
      if (!isRecoveryScopeCurrent()) return;
      // If orphaned sessions were recovered from manifests, save them to SecureStore
      for (const session of recovered) {
        if (!isRecoveryScopeCurrent()) return;
        const added = await stashStorage.addStashedSession(session);
        if (!isRecoveryScopeCurrent()) return;
        if (added) {
          await stashAudioManager.deleteRecoveryManifest(session.id);
        }
      }
    }).catch(() => {});
  }, []);

  const handleMfaRequiredResponse = useCallback(
    (data?: {
      reason?: string;
      currentLevel?: string;
      nextLevel?: string;
      staleSession?: boolean;
      verifiedAt?: number | null;
      maxAgeSeconds?: number;
    }) => {
      setMfaCurrentLevel(data?.currentLevel === 'aal2' ? 'aal2' : 'aal1');
      setMfaNextLevel(data?.nextLevel === 'aal2' ? 'aal2' : 'aal1');
      setMfaRequired(true);
      setMfaReason(typeof data?.reason === 'string' ? data.reason : null);
      setActiveMfaChallenge(null);
      setUser(null);
      setDeviceRegistrationPending(false);
      const currentPath = pathname || '/';
      if (!currentPath.includes('/mfa')) {
        setMfaReturnPath(currentPath);
        router.push('/(auth)/mfa' as never);
      }
      trackEvent({
        name: 'mfa_step_up_required',
        props: {
          reason: data?.reason ?? 'unknown',
          current_level: data?.currentLevel ?? 'unknown',
          next_level: data?.nextLevel ?? 'unknown',
        },
      });
    },
    [pathname, router]
  );

  const clearMfaChallenge = useCallback(() => {
    setActiveMfaChallenge(null);
  }, []);

  const registerDevice = useCallback(async (): Promise<boolean> => {
    // Single-flight: return the in-flight promise if another caller is already
    // mid-register. Prevents two concurrent POSTs + racing flag-updates.
    if (registerDeviceInFlightRef.current) {
      return registerDeviceInFlightRef.current;
    }
    const promise = (async (): Promise<boolean> => {
      try {
        const deviceId = await secureStorage.getDeviceId();
        if (!deviceId) {
          setDeviceRegistrationPending(true);
          return false;
        }
        // Platform.isPad is an iOS-only static property set at app launch based
        // on UIUserInterfaceIdiom. iPadOS apps running the iPhone binary
        // (unlikely on EAS builds, but possible) still report isPad=false,
        // which matches what the server should classify them as for session
        // rules. Android-side is all tablets for now (phones not a ship target).
        const deviceType =
          Platform.OS === 'ios'
            ? Platform.isPad
              ? 'ios_tablet'
              : 'ios_phone'
            : 'android_tablet';
        await apiClient.post('/api/device-sessions/register', {
          deviceId,
          deviceType,
          appVersion: require('../../package.json').version,
        });
        // Successful register clears any prior limit-block state — a revoke
        // from another device may have freed a slot since the last attempt.
        setDeviceRegistrationBlock(null);
        setDeviceRegistrationPending(false);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
          handleMfaRequiredResponse(error.data as MfaStatusResponse | undefined);
          setDeviceRegistrationPending(false);
          throw error;
        }
        if (__DEV__) console.log('[Auth] device registration failed:', error);
        const errorCode =
          error instanceof ApiError
            ? error.code ?? `http_${error.status}`
            : 'exception';
        trackEvent({ name: 'device_registration_failed', props: { error_code: errorCode } });
        if (!(error instanceof ApiError) || errorCode === 'exception') {
          captureException(error, { tags: { op: 'register_device' } });
        } else {
          breadcrumb('auth', 'device_registration_failed', { error_code: errorCode });
        }
        // Surface DEVICE_LIMIT_REACHED to the modal so the user can revoke
        // an existing device and retry. The hard-limit modal owns the UX
        // for that code, so we suppress the banner via `pending=false`.
        // All other failures (network, 5xx, timeout) raise the banner —
        // without it the user sits behind silent 428 loops forever.
        if (error instanceof ApiError && error.code === 'DEVICE_LIMIT_REACHED') {
          const data = error.data ?? {};
          const existingDevices = Array.isArray(data.existingDevices)
            ? (data.existingDevices as DeviceSession[])
            : [];
          const capacity =
            data.capacity && typeof data.capacity === 'object'
              ? (data.capacity as DeviceCapacity)
              : null;
          setDeviceRegistrationBlock({ existingDevices, capacity });
          setDeviceRegistrationPending(false);
        } else {
          setDeviceRegistrationPending(true);
        }
        return false;
      } finally {
        registerDeviceInFlightRef.current = null;
      }
    })();
    registerDeviceInFlightRef.current = promise;
    return promise;
  }, [handleMfaRequiredResponse]);

  const dismissDeviceRegistrationBlock = useCallback(() => {
    setDeviceRegistrationBlock(null);
  }, []);

  const retryDeviceRegistration = useCallback(
    () => registerDevice(),
    [registerDevice]
  );

  const fetchUser = useCallback(async (): Promise<boolean> => {
    const requestMe = () => apiClient.get<{ user: User }>('/auth/me');
    setUserFetchState('loading');
    setUserFetchError(null);

    // One attempt: returns true on success. Throws on failure.
    // The 404 bootstrap path is self-contained: it either succeeds and returns
    // true, forces sign-out and returns true, or throws a retryable error.
    const attempt = async (): Promise<FetchUserAttemptResult> => {
      try {
        if (__DEV__) console.log('[Auth] fetchUser: requesting /auth/me');
        const body = await requestMe();
        if (__DEV__) console.log('[Auth] fetchUser: success, user:', body.user?.email ?? 'null');
        // Try to register before setting user state so React Query's
        // `enabled: !!user`-gated queries don't fire before the device has a
        // session row. If registration fails without requiring MFA (device
        // limit, offline, transient server error), still apply the profile so
        // the device-registration recovery UI can render instead of leaving the
        // app in a half-authenticated retry loop.
        await registerDevice();
        applyFetchedUser(body.user ?? null);
        return 'loaded';
      } catch (error) {
        if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
          handleMfaRequiredResponse(error.data as MfaStatusResponse | undefined);
          return 'deferred';
        }
        // A brand-new Google/Apple user has no app User row yet — /auth/me
        // returns 404. Bootstrap via the idempotent /auth/register endpoint
        // (server derives fullName/orgName from Supabase user_metadata), then
        // retry /auth/me. Existing users never hit this path.
        if (error instanceof ApiError && error.status === 404) {
          if (__DEV__) console.log('[Auth] fetchUser: 404, waiting for pending Apple profile sync');
          await waitForPendingAppleProfileSync();
          try {
            const retryBody = await requestMe();
            if (__DEV__) console.log('[Auth] fetchUser: retry after Apple sync succeeded, user:', retryBody.user?.email ?? 'null');
            await registerDevice();
            applyFetchedUser(retryBody.user ?? null);
            return 'loaded';
          } catch (retryError) {
            if (__DEV__) console.log('[Auth] fetchUser: retry after Apple sync still missing user', retryError);
          }

          if (__DEV__) console.log('[Auth] fetchUser: 404, bootstrapping via /auth/register');
          try {
            await apiClient.post('/auth/register', {});
            const body = await requestMe();
            if (__DEV__) console.log('[Auth] fetchUser: bootstrap succeeded, user:', body.user?.email ?? 'null');
            await registerDevice();
            applyFetchedUser(body.user ?? null);
            return 'loaded';
          } catch (bootstrapError) {
            if (__DEV__) console.log('[Auth] fetchUser: bootstrap failed', bootstrapError);
            setLogoutReason('session_expired');
            await handleSignOutRef.current();
            return 'deferred';
          }
        }
        throw error;
      }
    };

    // Retry transient failures with 1s / 2s / 4s backoff before surfacing an
    // error state. The user is stranded in a half-authenticated state until
    // this resolves, so a couple of retries cover brief outages without
    // forcing the user to tap a recovery button.
    const delays = [1000, 2000, 4000];
    let lastError: unknown;
    for (let attemptIdx = 0; attemptIdx <= delays.length; attemptIdx++) {
      try {
        const result = await attempt();
        if (result === 'loaded') {
          setUserFetchState('success');
          setUserFetchError(null);
          return true;
        }
        setUserFetchState('idle');
        return false;
      } catch (error) {
        lastError = error;
        if (!isRetryableFetchUserError(error) || attemptIdx === delays.length) {
          break;
        }
        if (__DEV__) console.log(`[Auth] fetchUser: retryable failure, waiting ${delays[attemptIdx]}ms`);
        await new Promise((resolve) => setTimeout(resolve, delays[attemptIdx]));
      }
    }

    if (__DEV__) console.log('[Auth] fetchUser: all attempts failed', lastError);
    setUserFetchState('error');
    setUserFetchError(fetchUserErrorMessage(lastError));
    return false;
  }, [applyFetchedUser, handleMfaRequiredResponse, registerDevice]);

  const applyBearerMfaTokens = useCallback(async (tokens?: MfaApiResponse['tokens']) => {
    if (!tokens) return;
    const { error } = await supabase.auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    });
    if (error) {
      throw new Error(error.message);
    }
    const nextSession = (await supabase.auth.getSession()).data.session;
    setSession(nextSession);
    sessionTimestampRef.current = Date.now();
    apiClient.setToken(tokens.accessToken);
  }, []);

  const getRefreshTokenForMfa = useCallback(async (): Promise<string | null> => {
    if (session?.refresh_token) return session.refresh_token;
    const stored = await secureStorage.getSession();
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return null;
      const root = parsed as Record<string, unknown>;
      if (typeof root.refresh_token === 'string') return root.refresh_token;
      const currentSession = root.currentSession;
      if (typeof currentSession === 'object' && currentSession !== null) {
        const token = (currentSession as Record<string, unknown>).refresh_token;
        if (typeof token === 'string') return token;
      }
      const nestedSession = root.session;
      if (typeof nestedSession === 'object' && nestedSession !== null) {
        const token = (nestedSession as Record<string, unknown>).refresh_token;
        if (typeof token === 'string') return token;
      }
    } catch {
      return null;
    }
    return null;
  }, [session?.refresh_token]);

  const mfaAuthRequest = useCallback(
    async (
      path: string,
      options: {
        method?: 'GET' | 'POST';
        body?: unknown;
        includeRefreshToken?: boolean;
      } = {}
    ): Promise<MfaApiResponse> => {
      const token = session?.access_token ?? (await secureStorage.getToken());
      if (!token) {
        throw new ApiError('Authentication required.', 401, false, undefined, 'AUTH_REQUIRED');
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const deviceId = await secureStorage.getDeviceId();
      if (deviceId) {
        headers['X-Device-Id'] = deviceId;
      }

      if (options.includeRefreshToken) {
        const refreshToken = await getRefreshTokenForMfa();
        if (!refreshToken) {
          throw new ApiError(
            'Refresh token is required for MFA.',
            401,
            false,
            undefined,
            'REFRESH_TOKEN_REQUIRED'
          );
        }
        headers['X-Supabase-Refresh-Token'] = refreshToken;
      }

      const mfaUrl = `${API_URL}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MFA_REQUEST_TIMEOUT_MS);

      try {
        validateRequestUrl(mfaUrl);
        const response = await fetch(mfaUrl, {
          method: options.method ?? 'GET',
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        const data = ((await response.json().catch(() => ({}))) ?? {}) as MfaApiResponse;

        if (!response.ok) {
          const code = typeof data.code === 'string' ? data.code : undefined;
          if (code === 'MFA_REQUIRED') {
            handleMfaRequiredResponse(data);
          }
          throw new ApiError(
            mfaErrorMessage({ status: response.status, code }),
            response.status,
            response.status === 429 || response.status >= 500,
            undefined,
            code,
            data as Record<string, unknown>
          );
        }

        await applyBearerMfaTokens(data.tokens);
        return data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const aborted = error instanceof Error && error.name === 'AbortError';
        const code = aborted ? 'MFA_REQUEST_TIMEOUT' : undefined;
        throw new ApiError(
          mfaErrorMessage({ status: 0, code }),
          0,
          true,
          undefined,
          code
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    [
      applyBearerMfaTokens,
      getRefreshTokenForMfa,
      handleMfaRequiredResponse,
      session?.access_token,
    ]
  );

  const refreshMfaStatus = useCallback(async (): Promise<MfaStatusResponse> => {
    const data = await mfaAuthRequest('/auth/mfa/status');
    const currentLevel = data.currentLevel === 'aal2' ? 'aal2' : 'aal1';
    const nextLevel = data.nextLevel === 'aal2' ? 'aal2' : 'aal1';
    const required = Boolean(data.required);
    const status: MfaStatusResponse = {
      currentLevel,
      nextLevel,
      required,
      enrollmentRequired: Boolean(data.enrollmentRequired),
      staleSession: Boolean(data.staleSession),
      reason: typeof data.reason === 'string' ? data.reason : undefined,
      verifiedAt: typeof data.verifiedAt === 'number' ? data.verifiedAt : null,
      maxAgeSeconds: typeof data.maxAgeSeconds === 'number' ? data.maxAgeSeconds : undefined,
    };
    setMfaCurrentLevel(currentLevel);
    setMfaNextLevel(nextLevel);
    if (required || user) {
      setMfaRequired(required);
      setMfaReason(status.reason ?? null);
    }
    return status;
  }, [mfaAuthRequest, user]);

  const listMfaFactors = useCallback(async (): Promise<MfaFactor[]> => {
    const data = await mfaAuthRequest('/auth/mfa/factors', { includeRefreshToken: true });
    return (Array.isArray(data.factors) ? data.factors : [])
      .map((factor) => {
        if (typeof factor !== 'object' || factor === null) return null;
        const raw = factor as Record<string, unknown>;
        const id = typeof raw.id === 'string' ? raw.id : null;
        if (!id) return null;
        return {
          id,
          friendlyName:
            typeof raw.friendly_name === 'string'
              ? raw.friendly_name
              : typeof raw.friendlyName === 'string'
                ? raw.friendlyName
                : null,
          factorType:
            typeof raw.factor_type === 'string'
              ? raw.factor_type
              : typeof raw.factorType === 'string'
                ? raw.factorType
                : 'totp',
          status: typeof raw.status === 'string' ? raw.status : 'unknown',
          createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
          updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
        };
      })
      .filter((factor): factor is MfaFactor => factor !== null);
  }, [mfaAuthRequest]);

  const getVerifiedTotpFactor = useCallback(
    async (factorId?: string): Promise<MfaFactor> => {
      const factors = await listMfaFactors();
      const factor = factors.find(
        (item) =>
          item.factorType === 'totp' &&
          item.status === 'verified' &&
          (!factorId || item.id === factorId)
      );
      if (!factor) {
        throw new Error('No verified authenticator app is enrolled for this account.');
      }
      return factor;
    },
    [listMfaFactors]
  );

  const enrollMfaFactor = useCallback(
    async (friendlyName?: string, bootstrapCode?: string): Promise<MfaEnrollment> => {
      const data = await mfaAuthRequest('/auth/mfa/enroll', {
        method: 'POST',
        includeRefreshToken: true,
        body: {
          friendlyName,
          ...(bootstrapCode ? { bootstrapCode } : {}),
        },
      });
      if (!data.factorId || !data.uri || !data.secret) {
        throw new Error('Failed to start authenticator setup.');
      }
      return { factorId: data.factorId, uri: data.uri, secret: data.secret };
    },
    [mfaAuthRequest]
  );

  const startMfaChallenge = useCallback(
    async (factorId?: string): Promise<MfaChallenge> => {
      const factor = await getVerifiedTotpFactor(factorId);
      const data = await mfaAuthRequest('/auth/mfa/challenge', {
        method: 'POST',
        includeRefreshToken: true,
        body: { factorId: factor.id },
      });
      if (!data.challengeId) {
        throw new Error('Failed to start MFA challenge.');
      }
      const challenge = { factorId: factor.id, challengeId: data.challengeId };
      setActiveMfaChallenge(challenge);
      return challenge;
    },
    [getVerifiedTotpFactor, mfaAuthRequest]
  );

  const completeMfaWithProfile = useCallback(
    async (data: MfaApiResponse): Promise<void> => {
      setMfaRequired(Boolean(data.mfa?.required));
      setMfaReason(typeof data.mfa?.reason === 'string' ? data.mfa.reason : null);
      setMfaCurrentLevel(data.mfa?.currentLevel ?? 'aal2');
      setMfaNextLevel(data.mfa?.nextLevel ?? 'aal2');
      setActiveMfaChallenge(null);

      if (data.user) {
        await registerDevice();
        applyFetchedUser(data.user);
        setUserFetchState('success');
        setUserFetchError(null);
        return;
      }

      await fetchUser();
    },
    [applyFetchedUser, fetchUser, registerDevice]
  );

  const verifyMfaEnrollment = useCallback(
    async (factorId: string, code: string): Promise<void> => {
      const challenge = await mfaAuthRequest('/auth/mfa/challenge', {
        method: 'POST',
        includeRefreshToken: true,
        body: { factorId },
      });
      if (!challenge.challengeId) {
        throw new Error('Failed to start MFA verification.');
      }
      const data = await mfaAuthRequest('/auth/mfa/verify', {
        method: 'POST',
        includeRefreshToken: true,
        body: { factorId, challengeId: challenge.challengeId, code },
      });
      await completeMfaWithProfile(data);
    },
    [completeMfaWithProfile, mfaAuthRequest]
  );

  const verifyMfaChallenge = useCallback(
    async (code: string): Promise<void> => {
      const challenge = activeMfaChallenge ?? (await startMfaChallenge());
      const data = await mfaAuthRequest('/auth/mfa/verify', {
        method: 'POST',
        includeRefreshToken: true,
        body: { factorId: challenge.factorId, challengeId: challenge.challengeId, code },
      });
      await completeMfaWithProfile(data);
    },
    [activeMfaChallenge, completeMfaWithProfile, mfaAuthRequest, startMfaChallenge]
  );


  const handleSignOut = useCallback(async () => {
    if (__DEV__) console.log('[Auth] handleSignOut: starting');
    userInitiatedSignOutRef.current = true;
    // Clear in-memory token immediately
    apiClient.setToken(null);
    await withTimeout(
      supabase.auth.signOut().catch((error) => {
        if (__DEV__) console.error('[Auth] supabase.auth.signOut failed:', error);
      }),
      3000,
      'supabase_signout'
    );
    await withTimeout(signOutNativeGoogle(), 2000, 'google_signout');
    await withTimeout(
      secureStorage.clearAll().catch((error) => {
        if (__DEV__) console.error('[Auth] clearAll failed:', error);
      }),
      3000,
      'secure_clear'
    );
    // Clear cached PHI from React Query
    queryClient.clear();

    // Await critical PHI cleanup before clearing auth state.
    // This prevents a race where the next user signs in while the previous
    // user's stash data and audio files are still on disk.
    await withTimeout(performPhiCleanup(), 3000, 'phi_cleanup');

    // Now clear stash user scoping and auth state
    setStashUserId(null);
    draftStorage.setUserId(null);
    // Flush analytics then clear monitoring identity before we drop React state.
    // Flush is best-effort and bounded by internal PostHog timeouts.
    clearTelemetryIdentity();
    trackEvent({ name: 'session_signed_out', props: { trigger: 'user' } });
    setUser(null);
    setSession(null);
    setUserFetchState('idle');
    setUserFetchError(null);
    setDeviceRegistrationBlock(null);
    setDeviceRegistrationPending(false);
    setIsPasswordRecovery(false);
    setMfaRequired(false);
    setMfaReturnPath(null);
    setMfaReason(null);
    setMfaCurrentLevel('aal1');
    setMfaNextLevel('aal1');
    setActiveMfaChallenge(null);
  }, []);

  // Block screenshots / screen recording of PHI in production builds only.
  // Gated on extra.isProduction (set by APP_VARIANT=production in app.config.ts)
  // so dev sessions keep normal capture for debugging. Fire-and-forget with
  // .catch() — a native failure must not crash Hermes (rules 4 + 9).
  useEffect(() => {
    const isProduction = Constants.expoConfig?.extra?.isProduction === true;
    if (!isProduction) return;
    ScreenCapture.preventScreenCaptureAsync().catch(() => {});
  }, []);

  // Mutex for token refresh: prevents concurrent 401 handlers from racing
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  // Prevents re-entrant recovery: if refreshSession() fails inside onAuthStateChange,
  // Supabase may emit a second SIGNED_OUT. This flag ensures we only attempt recovery once.
  const sessionRecoveryAttemptedRef = useRef<boolean>(false);

  // Register the 401 handler: attempt token refresh before signing out
  useEffect(() => {
    apiClient.setOnDeviceRevoked(() => {
      handleSignOut().catch(() => {});
    });
    apiClient.setOnDeviceRegistrationRequired(() => registerDevice());
    apiClient.setOnMfaRequired((request) => {
      handleMfaRequiredResponse(request);
    });
    apiClient.setOnUnauthorized(async () => {
      const sessionAge = Date.now() - sessionTimestampRef.current;
      if (__DEV__) console.log('[Auth] onUnauthorized fired, session age:', sessionAge, 'ms');

      if (sessionAge < 10_000) {
        if (__DEV__) console.log('[Auth] onUnauthorized: ignoring, session too fresh (<10s)');
        return;
      }

      if (refreshPromiseRef.current) {
        await refreshPromiseRef.current;
        return;
      }

      const doRefresh = async () => {
        try {
          if (__DEV__) console.log('[Auth] onUnauthorized: attempting token refresh');
          trackEvent({ name: 'session_refresh_attempted', props: { trigger: 'on_auth_state' } });
          const { error } = await supabase.auth.refreshSession();
          if (error) {
            // Retry once after 3s — guards against transient network blips
            if (__DEV__) console.log('[Auth] onUnauthorized: first refresh failed, retrying in 3s');
            trackEvent({
              name: 'session_refresh_failed',
              props: { trigger: 'on_auth_state', error_code: classifyAuthError(error) },
            });
            trackEvent({ name: 'auth_retry_fired', props: { op: 'refresh_session' } });
            await new Promise<void>(resolve => setTimeout(resolve, 3000));
            const { error: retryError } = await supabase.auth.refreshSession();
            if (retryError) {
              if (__DEV__) console.log('[Auth] onUnauthorized: retry also failed, signing out');
              trackEvent({
                name: 'session_refresh_failed',
                props: { trigger: 'on_auth_state', error_code: `retry_${classifyAuthError(retryError)}` },
              });
              setLogoutReason('session_expired');
              await handleSignOut();
            } else {
              if (__DEV__) console.log('[Auth] onUnauthorized: retry succeeded');
            }
          } else {
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh succeeded');
          }
        } catch (e) {
          if (__DEV__) console.log('[Auth] onUnauthorized: refresh threw, signing out');
          trackEvent({
            name: 'session_refresh_failed',
            props: { trigger: 'on_auth_state', error_code: 'exception' },
          });
          captureException(e, { tags: { phase: 'auth_refresh' } });
          setLogoutReason('session_expired');
          handleSignOut().catch(() => {});
        } finally {
          refreshPromiseRef.current = null;
        }
      };

      refreshPromiseRef.current = doRefresh();
      await refreshPromiseRef.current;
    });
  }, [handleMfaRequiredResponse, handleSignOut, registerDevice]);

  useEffect(() => {
    // Belt-and-suspenders watchdog against hung native bridges in the cold-
    // start path (CLAUDE.md rule 29). Supabase GoTrue's auto-refresh timer
    // (rule 27), SecureStore reads on a freshly-rebuilt Keystore, and the
    // post-update biometric handoff have all been observed to hang silently.
    // Without this timer the user sees a stuck `<ActivityIndicator>` in
    // `(auth)/_layout.tsx` until they force-stop the app. Firing this
    // watchdog flips `isLoading=false` so the Sign-In screen renders, and
    // captures a Sentry message so we can see how often it happens.
    const initWatchdog = setTimeout(() => {
      captureMessage('auth_init_watchdog_fired', 'warning', {
        tags: { phase: 'init_watchdog', op: 'auth_init' },
        extra: { timeout_ms: 15_000 },
      });
      setIsLoading(false);
    }, 15_000);

    // Restore existing session on startup. `getSession` is wrapped in a
    // narrower 10s timeout so the common-case hang (poisoned AbortController
    // post-update) recovers to "no session" 5s before the top-level watchdog
    // fires — gives the user the Sign-In screen rather than a captured
    // warning with no recovery action.
    withTimeout(supabase.auth.getSession(), 10_000, 'auth_init_get_session').then(async (result) => {
      const existingSession = result?.data?.session ?? null;
      if (existingSession) {
        if (existingSession.access_token) {
          const validateResult = await withTimeout(
            supabase.auth.getUser(existingSession.access_token),
            8000,
            'auth_init_get_user'
          );
          const validatedUser = validateResult?.data?.user ?? null;
          const validateError = validateResult?.error ?? null;
          if (!validateResult || validateError || !validatedUser) {
            if (__DEV__) console.log('[Auth] session restore: server rejected token, attempting refresh');
            trackEvent({ name: 'session_refresh_attempted', props: { trigger: 'recovery' } });
            const refreshResult = await withTimeout(
              supabase.auth.refreshSession(),
              8000,
              'auth_init_refresh_session'
            );
            const refreshData = refreshResult?.data ?? null;
            const refreshError = refreshResult?.error ?? null;
            if (!refreshResult || refreshError || !refreshData?.session) {
              if (__DEV__) console.log('[Auth] session restore: refresh also failed, clearing');
              trackEvent({
                name: 'session_refresh_failed',
                props: { trigger: 'recovery', error_code: refreshError ? classifyAuthError(refreshError) : 'no_session' },
              });
              apiClient.setToken(null);
              await secureStorage.clearAll().catch(() => {});
              return;
            }
            if (__DEV__) console.log('[Auth] session restore: refresh succeeded');
            setSession(refreshData.session);
            sessionTimestampRef.current = Date.now();
            apiClient.setToken(refreshData.session.access_token);
            fetchUser().catch(() => {});
            return;
          }

          setSession(existingSession);
          sessionTimestampRef.current = Date.now();
          apiClient.setToken(existingSession.access_token);
          fetchUser().catch(() => {});
        } else {
          setSession(existingSession);
        }
      }
      // Clean up orphaned audio recordings from prior crashes (deferred).
      // Cache cleanup is safe without user ID. Stash cleanup requires user ID
      // to be set (by fetchUser) so it only runs after authentication completes.
      setTimeout(() => {
        cleanupAudioCache();
      }, 5000);
    }).catch((error) => {
      if (__DEV__) console.error('[Auth] Failed to restore session:', error);
    }).finally(() => {
      clearTimeout(initWatchdog);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (__DEV__) console.log('[Auth] onAuthStateChange:', event,
          'hasToken:', !!newSession?.access_token,
          'expires_at:', newSession?.expires_at);

        if (event === 'INITIAL_SESSION') return;

        try {
          // Password recovery: establish the session but skip the rest of the
          // sign-in flow (no fetchUser, no stash setup). (auth)/_layout.tsx
          // reads isPasswordRecovery so the authenticated session doesn't
          // bounce the user out of reset-password.
          if (event === 'PASSWORD_RECOVERY' && newSession) {
            setSession(newSession);
            sessionTimestampRef.current = Date.now();
            apiClient.setToken(newSession.access_token);
            setIsPasswordRecovery(true);
            setIsLoading(false);
            return;
          }

          if (newSession?.access_token) {
            sessionRecoveryAttemptedRef.current = false; // reset for next sign-out cycle
            userInitiatedSignOutRef.current = false;     // ensure clear regardless of prior sign-out path
            setSession(newSession);
            sessionTimestampRef.current = Date.now();
            if (__DEV__) console.log('[Auth] session established, storing token');
            apiClient.setToken(newSession.access_token);
            await fetchUser();
            if (__DEV__) console.log('[Auth] sign-in flow complete');
          } else {
            // Supabase emits SIGNED_OUT both for explicit sign-outs AND for expired/failed
            // refresh tokens. If this wasn't user-initiated, attempt one recovery refresh
            // before clearing state — guards against transient network failures during
            // background auto-refresh causing an unnecessary logout.
            // sessionRecoveryAttemptedRef guards against a second SIGNED_OUT emitted by
            // a failing refreshSession() creating an infinite recovery loop.
            if (!userInitiatedSignOutRef.current && !sessionRecoveryAttemptedRef.current) {
              sessionRecoveryAttemptedRef.current = true;
              if (__DEV__) console.log('[Auth] SIGNED_OUT without user action, attempting recovery refresh');
              trackEvent({ name: 'session_refresh_attempted', props: { trigger: 'recovery' } });
              const { data: recoveryData, error: recoveryError } = await supabase.auth.refreshSession();
              if (!recoveryError && recoveryData.session?.access_token) {
                if (__DEV__) console.log('[Auth] recovery refresh succeeded, session restored');
                sessionRecoveryAttemptedRef.current = false;
                setSession(recoveryData.session);
                sessionTimestampRef.current = Date.now();
                apiClient.setToken(recoveryData.session.access_token);
                fetchUser().catch((e) => {
                  if (__DEV__) console.error('[Auth] fetchUser failed during recovery:', e);
                });
                return;
              }
              if (__DEV__) console.log('[Auth] recovery refresh failed, proceeding with sign-out cleanup');
              trackEvent({
                name: 'session_refresh_failed',
                props: { trigger: 'recovery', error_code: recoveryError ? classifyAuthError(recoveryError) : 'no_session' },
              });
            }
            userInitiatedSignOutRef.current = false;
            // Hold isLoading=true during PHI cleanup so the route guard doesn't
            // redirect to login before stash/audio deletion finishes. setSession(null)
            // is deferred until after all cleanup — mirrors handleSignOut ordering.
            setIsLoading(true);
            if (__DEV__) console.log('[Auth] no access_token, clearing session');
            apiClient.setToken(null);
            // Full PHI cleanup before clearing auth state — mirrors handleSignOut.
            // Prevents the next user on a shared tablet from seeing stashed patient
            // data, drafts, cached audio, or waveform peaks when a session expires
            // or is revoked by the server. Each step is bounded by withTimeout so
            // a hung native bridge can't trap setIsLoading(true) forever — the
            // common observable symptom is a blank spinner on cold start that
            // only clears via force-quit + relaunch.
            await withTimeout(performPhiCleanup(), 3000, 'phi_cleanup');
            await withTimeout(signOutNativeGoogle(), 2000, 'google_signout');
            await withTimeout(
              secureStorage.clearAll().catch(() => {}),
              3000,
              'secure_clear'
            );
            // Clear cached PHI so the next user on this shared tablet
            // doesn't briefly see the previous user's recording list.
            queryClient.clear();
            setStashUserId(null);
            draftStorage.setUserId(null);
            // Drop telemetry identity before dropping React auth state, so any
            // error captured during the final teardown doesn't attribute to
            // the expired user. Mirrors the handleSignOut ordering.
            clearTelemetryIdentity();
            setUser(null);
            setSession(null);
            setDeviceRegistrationBlock(null);
            setDeviceRegistrationPending(false);
            setIsPasswordRecovery(false);
            setMfaRequired(false);
            setMfaReturnPath(null);
            setMfaReason(null);
            setMfaCurrentLevel('aal1');
            setMfaNextLevel('aal1');
            setActiveMfaChallenge(null);
          }
        } catch (error) {
          if (__DEV__) console.error('[Auth] onAuthStateChange error:', error);
        } finally {
          setIsLoading(false);
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchUser, registerDevice]);

  // Proactively refresh token when app returns from background.
  // Uses getSession() rather than the stale closure value of session?.expires_at
  // so this correctly fires even when expires_at is null (e.g., first sign-in,
  // or a session restored from SecureStore with a malformed expires_at field).
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') return;

      if (refreshPromiseRef.current) {
        if (__DEV__) console.log('[Auth] foreground resume: refresh already in flight, skipping');
        return;
      }

      const doRefresh = async () => {
        try {
          const { data } = await supabase.auth.getSession();
          if (!data.session?.access_token) {
            if (__DEV__) console.log('[Auth] foreground resume: no active session');
            return;
          }
          const now = Date.now() / 1000;
          const bufferSeconds = 600;
          if (!data.session.expires_at || now > data.session.expires_at - bufferSeconds) {
            if (__DEV__) console.log('[Auth] foreground resume: token expired or near-expiry, refreshing');
            trackEvent({ name: 'session_refresh_attempted', props: { trigger: 'foreground' } });
            const { error } = await supabase.auth.refreshSession();
            if (error) {
              const errorCode = classifyAuthError(error);
              if (__DEV__) console.log('[Auth] foreground refresh failed:', error.message);
              trackEvent({
                name: 'session_refresh_failed',
                props: { trigger: 'foreground', error_code: errorCode },
              });
              // Hard failures (auth no longer valid) need to advance the app to
              // the login screen. Without this the foreground handler logs the
              // error and returns — leaving the user on a half-auth screen
              // (session in memory, /auth/me 401-ing on every gated query) that
              // looks like a blank spinner. Local-scope signOut emits SIGNED_OUT
              // through onAuthStateChange so cleanup runs through one path.
              const isTransient =
                errorCode === 'network' ||
                errorCode === 'retryable_fetch' ||
                errorCode === 'rate_limited' ||
                errorCode === 'server_error';
              if (!isTransient) {
                if (__DEV__) console.log('[Auth] foreground refresh hard-fail, forcing local signOut');
                breadcrumb('auth', 'foreground_refresh_hard_fail', { error_code: errorCode });
                await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
              }
            } else {
              if (__DEV__) console.log('[Auth] foreground refresh succeeded');
            }
          } else {
            if (__DEV__) console.log('[Auth] foreground resume: session still valid');
          }
        } catch (e) {
          if (__DEV__) console.error('[Auth] foreground refresh threw:', e);
          trackEvent({
            name: 'session_refresh_failed',
            props: { trigger: 'foreground', error_code: 'exception' },
          });
          captureException(e, { tags: { phase: 'auth_refresh' } });
        } finally {
          refreshPromiseRef.current = null;
        }
      };
      refreshPromiseRef.current = doRefresh();
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  // supabase is a module-level singleton; refreshPromiseRef is a ref — safe with empty deps.
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (__DEV__) console.log('[Auth] signIn: attempting for', email);
    trackEvent({ name: 'sign_in_attempted', props: { auth_method: 'password' } });

    let { error } = await supabase.auth.signInWithPassword({ email, password });
    let retryUsed = false;

    // Supabase GoTrue's internal auto-refresh timer can leave behind a stale
    // AbortController after a previous signOut; the next fetch rejects
    // immediately with AuthRetryableFetchError (status=0, "Network request
    // failed"). Retry once after a short delay — Supabase itself named this
    // error "retryable," and the retry's signInWithPassword constructs a
    // fresh controller so the original stale one doesn't poison it.
    // Reproducible in the iOS simulator after sign-out → sign-in loops.
    if (error && (error as { name?: string }).name === 'AuthRetryableFetchError') {
      if (__DEV__) console.log('[Auth] signIn: AuthRetryableFetchError, retrying once');
      trackEvent({ name: 'auth_retry_fired', props: { op: 'sign_in' } });
      retryUsed = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const retry = await supabase.auth.signInWithPassword({ email, password });
      error = retry.error;
    }

    if (error) {
      if (__DEV__) console.error('[Auth] signIn failed:', error.message, error.status);
      const errorCode = classifyAuthError(error);
      trackEvent({
        name: 'sign_in_failed',
        props: { auth_method: 'password', error_code: errorCode, retry_used: retryUsed },
      });

      if (error.message?.includes('Email not confirmed')) {
        return { error: 'Please confirm your email address before signing in.' };
      }
      if (error.status === 0 || error.message?.includes('fetch')) {
        return { error: 'Unable to reach the authentication server. Please check your connection.' };
      }
      if (__DEV__) {
        return { error: `[DEV] ${error.message} (status: ${error.status})` };
      }
      return { error: 'Invalid email or password' };
    }
    if (__DEV__) console.log('[Auth] signIn: success');
    return { error: null };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (__DEV__) console.log('[Auth] signInWithGoogle: attempting');
    trackEvent({ name: 'sign_in_attempted', props: { auth_method: 'google' } });
    const result = await signInWithGoogleNative();
    if (!result.error && !result.cancelled) {
      if (__DEV__) console.log('[Auth] signInWithGoogle: success');
    } else if (result.error) {
      if (__DEV__) console.log('[Auth] signInWithGoogle: failed', result.error);
      trackEvent({
        name: 'sign_in_failed',
        props: { auth_method: 'google', error_code: String(result.error).slice(0, 32), retry_used: false },
      });
    }
    return result;
  }, []);

  const signInWithApple = useCallback(async () => {
    if (__DEV__) console.log('[Auth] signInWithApple: attempting');
    trackEvent({ name: 'sign_in_attempted', props: { auth_method: 'apple' } });
    const result = await signInWithAppleNative();
    if (!result.error && !result.cancelled) {
      if (__DEV__) console.log('[Auth] signInWithApple: success');
    } else if (result.error) {
      if (__DEV__) console.log('[Auth] signInWithApple: failed', result.error);
      trackEvent({
        name: 'sign_in_failed',
        props: { auth_method: 'apple', error_code: String(result.error).slice(0, 32), retry_used: false },
      });
    }
    return result;
  }, []);

  handleSignOutRef.current = handleSignOut;

  const isAuthenticated = !!session?.access_token;
  if (__DEV__ && session?.access_token) {
    const tokenExpired = isTokenExpired(session?.expires_at);
    console.log('[Auth] isAuthenticated:', isAuthenticated,
      'hasToken:', true, 'tokenExpired:', tokenExpired,
      'expires_at:', session.expires_at, 'user:', !!user);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isAuthenticated,
        isLoading,
        userFetchState,
        userFetchError,
        retryFetchUser: fetchUser,
        signIn,
        signInWithGoogle,
        signInWithApple,
        signOut: handleSignOut,
        deviceRegistrationBlock,
        dismissDeviceRegistrationBlock,
        retryDeviceRegistration,
        deviceRegistrationPending,
        isPasswordRecovery,
        clearPasswordRecovery,
        mfaRequired,
        mfaReturnPath,
        mfaReason,
        mfaCurrentLevel,
        mfaNextLevel,
        refreshMfaStatus,
        listMfaFactors,
        enrollMfaFactor,
        startMfaChallenge,
        verifyMfaChallenge,
        verifyMfaEnrollment,
        clearMfaChallenge,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

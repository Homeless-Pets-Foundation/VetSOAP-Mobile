import React, { createContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { AppState, Platform } from 'react-native';
import type { AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { Session } from '@supabase/supabase-js';
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
import { recoveryIntent } from '../lib/recoveryIntent';
import { isValidDurableId } from '../lib/durableAudio/paths';
import { durableTombstone } from '../lib/durableAudio/tombstone';
import { durableActiveStore } from '../lib/durableAudio/activeStore';
import { runDurableRecoveryScan, invalidateDurableRecoveries } from '../lib/durableAudio/durableRecovery';
import { hydrateMinVersionFloor } from '../lib/minVersion';
import { durableRecoveryStore } from '../lib/durableAudio/recoveryState';
import { audioTempFiles } from '../lib/audioTempFiles';
import { queryClient } from '../lib/queryClient';
import { audioEditorBridge } from '../lib/audioEditorBridge';
import { clearClipboard } from '../lib/secureClipboard';
import { clearPeakCache } from '../lib/waveformCache';
import { setLogoutReason } from '../lib/logoutReason';
import {
  SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED,
  supportStaffRecoveryVault,
  type RecoveryPreserveResult,
} from '../lib/supportStaffRecoveryVault';
import { setMonitoringUser, clearMonitoringUser, captureException, captureMessage, breadcrumb, measurePhase } from '../lib/monitoring';
import { identifyUser, resetAnalytics, flushAnalytics, trackEvent } from '../lib/analytics';
import { saveProfileCache, getCachedProfile } from '../lib/userProfileCache';
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
type LocalRecoveryState = 'idle' | 'scanning' | 'ready' | 'error';
export type SignOutRecoveryMode = 'required' | 'best_effort' | 'destructive';
export interface SignOutOptions {
  recoveryMode?: SignOutRecoveryMode;
}

const LOCAL_RECOVERY_SCAN_TIMEOUT_MS = 5_000;
const SUPPORT_STAFF_RECOVERY_BEST_EFFORT_TIMEOUT_MS = 5_000;
const SUPPORT_STAFF_RECOVERY_REQUIRED_TIMEOUT_MS = 60_000;

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
  /**
   * 'cache' when the current `user` came from the on-device profile cache
   * after /auth/me failed terminally (1B startup resilience). The app is
   * usable on saved account info; OfflineBanner renders while this is set,
   * and a NetInfo-reconnect/backoff loop re-fetches the live profile.
   */
  profileSource: 'live' | 'cache';
  localRecoveryState: LocalRecoveryState;
  pendingRecoveryDraftSlotId: string | null;
  consumePendingRecoveryDraftSlotId: () => string | null;
  retryFetchUser: () => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signInWithGoogle: () => Promise<AuthResult>;
  signInWithApple: () => Promise<AuthResult>;
  signOut: (options?: SignOutOptions) => Promise<void>;
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
  profileSource: 'live',
  localRecoveryState: 'idle',
  pendingRecoveryDraftSlotId: null,
  consumePendingRecoveryDraftSlotId: () => null,
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

export type AuthReadinessContextType = Pick<
  AuthContextType,
  | 'session'
  | 'isAuthenticated'
  | 'isLoading'
  | 'userFetchState'
  | 'userFetchError'
  | 'profileSource'
  | 'localRecoveryState'
  | 'pendingRecoveryDraftSlotId'
  | 'consumePendingRecoveryDraftSlotId'
  | 'retryFetchUser'
  | 'isPasswordRecovery'
  | 'clearPasswordRecovery'
>;

export type AuthActionsContextType = Pick<
  AuthContextType,
  'signIn' | 'signInWithGoogle' | 'signInWithApple' | 'signOut'
>;

export type AuthDeviceRegistrationContextType = Pick<
  AuthContextType,
  | 'deviceRegistrationBlock'
  | 'dismissDeviceRegistrationBlock'
  | 'retryDeviceRegistration'
  | 'deviceRegistrationPending'
>;

export type AuthMfaContextType = Pick<
  AuthContextType,
  | 'mfaRequired'
  | 'mfaReturnPath'
  | 'mfaReason'
  | 'mfaCurrentLevel'
  | 'mfaNextLevel'
  | 'refreshMfaStatus'
  | 'listMfaFactors'
  | 'enrollMfaFactor'
  | 'startMfaChallenge'
  | 'verifyMfaChallenge'
  | 'verifyMfaEnrollment'
  | 'clearMfaChallenge'
>;

export const AuthUserContext = createContext<User | null>(null);

export const AuthReadinessContext = createContext<AuthReadinessContextType>({
  session: null,
  isAuthenticated: false,
  isLoading: true,
  userFetchState: 'idle',
  userFetchError: null,
  profileSource: 'live',
  localRecoveryState: 'idle',
  pendingRecoveryDraftSlotId: null,
  consumePendingRecoveryDraftSlotId: () => null,
  retryFetchUser: async () => false,
  isPasswordRecovery: false,
  clearPasswordRecovery: () => {},
});

export const AuthActionsContext = createContext<AuthActionsContextType>({
  signIn: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signInWithApple: async () => ({ error: null }),
  signOut: async () => {},
});

export const AuthDeviceRegistrationContext = createContext<AuthDeviceRegistrationContextType>({
  deviceRegistrationBlock: null,
  dismissDeviceRegistrationBlock: () => {},
  retryDeviceRegistration: async () => false,
  deviceRegistrationPending: false,
});

export const AuthMfaContext = createContext<AuthMfaContextType>({
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

function withRejectingTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      captureMessage('required_timeout_fired', 'warning', {
        tags: { phase: 'required_timeout', op: label },
        extra: { timeout_ms: ms },
      });
      reject(new Error(`${label}_timeout`));
    }, ms);
  });

  return Promise.race([
    p.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]);
}

function captureSupportStaffRecoveryFailure(
  mode: SignOutRecoveryMode,
  result: RecoveryPreserveResult | null,
  error?: unknown
): void {
  captureMessage('support_staff_recovery_preserve_failed', 'warning', {
    tags: {
      phase: 'support_staff_recovery',
      recovery_mode: mode,
      error_code: result?.errorCode ?? (error instanceof Error && error.message.includes('timeout') ? 'timeout' : 'unknown'),
    },
    extra: {
      recoverable_count: result?.recoverableCount,
      preserved_count: result?.preservedCount,
      failed_count: result?.failedCount,
    },
  });
  if (error) {
    captureException(error, { tags: { phase: 'support_staff_recovery', recovery_mode: mode } });
  }
}

async function preserveSupportStaffRecordings(
  sourceUser: User | null | undefined,
  mode: SignOutRecoveryMode
): Promise<void> {
  if (sourceUser?.role !== 'support_staff' || mode === 'destructive') {
    return;
  }

  try {
    const preserve = supportStaffRecoveryVault.preserveScopedUserRecordings(sourceUser);
    const result =
      mode === 'required'
        ? await withRejectingTimeout(
            preserve,
            SUPPORT_STAFF_RECOVERY_REQUIRED_TIMEOUT_MS,
            'support_staff_recovery_preserve'
          )
        : await withTimeout(
            preserve,
            SUPPORT_STAFF_RECOVERY_BEST_EFFORT_TIMEOUT_MS,
            'support_staff_recovery_preserve'
          );

    if (!result?.ok) {
      captureSupportStaffRecoveryFailure(mode, result ?? null);
      if (mode === 'required') {
        throw new Error(SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED)) {
      captureSupportStaffRecoveryFailure(mode, null, error);
    }
    if (mode === 'required') {
      throw new Error(SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED);
    }
  }
}

/**
 * Clear only genuinely-transient, non-PHI scratch state on logout.
 *
 * Intentionally does NOT delete local drafts, stashes, or their audio: per the
 * 2026-05-29 owner decision (vet recordings carry no security concern),
 * recordings must survive every logout — explicit sign-out and involuntary
 * session-expiry alike — and reappear when that user signs back in. Per-user
 * disk scoping (rule 13) keeps them isolated on shared tablets; bounded growth
 * is handled by the status-aware eviction sweep, not by wiping on logout.
 *
 * The targets below are all scratch/cache scoped (cacheDirectory or in-memory),
 * so none can touch documentDirectory/drafts/** or stashed-audio/**.
 */
async function clearTransientCaches(): Promise<void> {
  try {
    await Promise.all([
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
  const [profileSource, setProfileSource] = useState<'live' | 'cache'>('live');
  const [localRecoveryState, setLocalRecoveryState] = useState<LocalRecoveryState>('idle');
  const [pendingRecoveryDraftSlotId, setPendingRecoveryDraftSlotId] = useState<string | null>(null);
  const [deviceRegistrationBlock, setDeviceRegistrationBlock] =
    useState<DeviceRegistrationBlock | null>(null);
  const [deviceRegistrationPending, setDeviceRegistrationPending] = useState(false);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);
  const activeUserRef = useRef<User | null>(null);
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
  const handleSignOutRef = useRef<(options?: SignOutOptions) => Promise<void>>(async () => {});
  // Single-flight guard for registerDevice. `fetchUser()` owns the normal
  // sign-in/session-restore registration path, while API 428 handlers and the
  // device-limit modal can still retry manually.
  const registerDeviceInFlightRef = useRef<Promise<boolean> | null>(null);
  // Distinguishes user-initiated sign-out from session expiry in onAuthStateChange.
  // When Supabase emits SIGNED_OUT due to a failed refresh, this flag is false —
  // allowing one recovery refresh attempt before clearing auth state.
  const userInitiatedSignOutRef = useRef<boolean>(false);
  const pendingRecoveryDraftSlotIdRef = useRef<string | null>(null);
  const localRecoveryScanIdRef = useRef(0);
  // Recovery scan is a one-shot per authenticated user. Without this, every
  // TOKEN_REFRESHED-driven fetchUser re-enters 'scanning', blanking the app
  // (the "dashboard reloads") and unmounting an active recording. Reset on
  // user clear so a fresh sign-in re-scans.
  const recoveryScannedUserIdRef = useRef<string | null>(null);

  const setRecoveryDraftSlotId = useCallback((slotId: string | null) => {
    pendingRecoveryDraftSlotIdRef.current = slotId;
    setPendingRecoveryDraftSlotId(slotId);
  }, []);

  const consumePendingRecoveryDraftSlotId = useCallback((): string | null => {
    const slotId = pendingRecoveryDraftSlotIdRef.current;
    if (slotId) {
      setRecoveryDraftSlotId(null);
    }
    return slotId;
  }, [setRecoveryDraftSlotId]);

  const scanLocalRecoveryIntent = useCallback(
    (userId: string) => {
      const scanId = localRecoveryScanIdRef.current + 1;
      localRecoveryScanIdRef.current = scanId;
      setLocalRecoveryState('scanning');
      setRecoveryDraftSlotId(null);
      const timeout = setTimeout(() => {
        if (localRecoveryScanIdRef.current !== scanId) return;
        localRecoveryScanIdRef.current += 1;
        setLocalRecoveryState('ready');
        captureMessage('local_recovery_scan_watchdog_fired', 'warning', {
          tags: { phase: 'local_recovery_scan' },
          extra: { timeout_ms: LOCAL_RECOVERY_SCAN_TIMEOUT_MS },
        });
      }, LOCAL_RECOVERY_SCAN_TIMEOUT_MS);

      measurePhase('local_recovery_scan', { user_scoped: true }, async () => {
        try {
          const intent = await recoveryIntent.getForUser(userId);
          if (localRecoveryScanIdRef.current !== scanId) return;
          if (!intent) {
            setLocalRecoveryState('ready');
            return;
          }

          const draft = await draftStorage.getDraft(intent.draftSlotId);
          if (localRecoveryScanIdRef.current !== scanId) return;
          // A durable draft has empty segments (audio in audio.aac); a valid
          // durable pointer is still a live resume target, so don't clear its
          // RECOVERY_INTENT as "stale".
          const durableIntentAlive = !!draft?.durable && isValidDurableId(draft.durable.recordingId);
          if (draft && (draft.segments.length > 0 || durableIntentAlive)) {
            setRecoveryDraftSlotId(intent.draftSlotId);
            breadcrumb('auth', 'local_recovery_intent_ready', {
              reason: intent.reason,
              segment_count: draft.segments.length,
              pending_sync: draft.pendingSync,
            });
          } else {
            await recoveryIntent.clearForDraftSlot(intent.draftSlotId);
            breadcrumb('auth', 'local_recovery_intent_stale', {
              reason: intent.reason,
            });
          }
          setLocalRecoveryState('ready');
        } catch (error) {
          if (localRecoveryScanIdRef.current !== scanId) return;
          setLocalRecoveryState('error');
          captureException(error, { tags: { phase: 'local_recovery_scan' } });
        } finally {
          clearTimeout(timeout);
        }
      }).catch(() => {
        clearTimeout(timeout);
        if (localRecoveryScanIdRef.current === scanId) {
          setLocalRecoveryState('error');
        }
      });
    },
    [setRecoveryDraftSlotId]
  );

  const applyFetchedUser = useCallback((fetchedUser: User | null) => {
    // Every caller of this function applies a live /auth/me result; the one
    // cache-fallback site in fetchUser overrides to 'cache' immediately after.
    setProfileSource('live');
    if (!fetchedUser?.id) {
      localRecoveryScanIdRef.current += 1;
      recoveryScannedUserIdRef.current = null;
      setLocalRecoveryState('idle');
      setRecoveryDraftSlotId(null);
      activeUserRef.current = fetchedUser;
      setUser(fetchedUser);
      return;
    }
    if (fetchedUser) {
      setMfaRequired(false);
      setMfaReturnPath(null);
      setMfaReason(null);
      setActiveMfaChallenge(null);
    }
    const scopedUserId = fetchedUser.id;
    // Tag monitoring + analytics with the user id (no email / name / PHI).
    setMonitoringUser(scopedUserId, fetchedUser.organizationId);
    identifyUser(scopedUserId, fetchedUser.organizationId);
    const isRecoveryScopeCurrent = () =>
      stashStorage.getUserId() === scopedUserId &&
      stashAudioManager.getUserId() === scopedUserId;

    setStashUserId(scopedUserId);
    draftStorage.setUserId(scopedUserId);
    // Durable recorder stores are user-scoped too (Rule 13): set before any
    // durable read/write (tombstone consult, recovery scan).
    durableTombstone.setUserId(scopedUserId);
    durableActiveStore.setUserId(scopedUserId);
    // One-shot per user: only scan on the first authenticated load (cold-start
    // session restore or fresh sign-in). Subsequent re-fetches of the same user
    // (TOKEN_REFRESHED, MFA re-check, foreground resume) skip the scan so the
    // 'scanning' gate in (app)/_layout.tsx never re-fires mid-session.
    if (recoveryScannedUserIdRef.current !== scopedUserId) {
      recoveryScannedUserIdRef.current = scopedUserId;
      scanLocalRecoveryIntent(scopedUserId);
      // Durable AAC crash-recovery scan (self-heals uploaded manifests,
      // reconciles created-but-unconfirmed, surfaces the offer list). Runs under
      // its own Rule 24 watchdog so a hung native scan never blocks app entry.
      runDurableRecoveryScan(scopedUserId).catch(() => {});
    }
    activeUserRef.current = fetchedUser;
    setUser(fetchedUser);
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
  }, [scanLocalRecoveryIntent, setRecoveryDraftSlotId]);

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
    const promise = measurePhase('registerDevice', { platform: Platform.OS }, async (): Promise<boolean> => {
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
        // rules. Android phone vs tablet comes from expo-device's screen-diagonal
        // heuristic (PHONE = 3–6.9", TABLET = 7–18"). Lazy-require so old
        // dev-client APKs without expo-device don't crash at load (rule 19);
        // default to 'android_tablet' on UNKNOWN/unavailable since clinic
        // hardware is tablet-first and over-classifying as phone is worse.
        let androidDeviceType = 'android_tablet';
        let deviceName: string | undefined;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const Device = require('expo-device') as typeof import('expo-device');
          if (typeof Device.modelName === 'string' && Device.modelName.trim()) {
            deviceName = Device.modelName.trim().slice(0, 64);
          }
          if (Device.deviceType === Device.DeviceType.PHONE) {
            androidDeviceType = 'android_phone';
          }
        } catch {
          // expo-device unavailable — keep the tablet default
        }
        const deviceType =
          Platform.OS === 'ios'
            ? Platform.isPad
              ? 'ios_tablet'
              : 'ios_phone'
            : androidDeviceType;
        await apiClient.post('/api/device-sessions/register', {
          deviceId,
          deviceType,
          ...(deviceName ? { deviceName } : {}),
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
    });
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

  const fetchUser = useCallback(async (): Promise<boolean> => measurePhase('fetchUser', undefined, async () => {
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
            await handleSignOutRef.current({ recoveryMode: 'best_effort' });
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
          // 1B: persist the minimal profile projection so the next cold start
          // can survive a terminal /auth/me failure. Fire-and-forget (rule 4).
          const liveUser = activeUserRef.current;
          if (liveUser) {
            saveProfileCache(liveUser).catch(() => {});
          }
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

    // 1B startup resilience: before stranding the user on the error screen,
    // fall back to the cached minimal profile. Only applies when the cached id
    // matches the current session's user id (user-swap safety on shared
    // tablets — keeps rule-13 storage scoping correct) AND the failure was
    // retryable (network/timeout/5xx). A terminal 401/403 means the API
    // refused this account (role/org revoked) — rendering the app from cache
    // would bypass that refusal. Both reads are bounded (rule 24): a hung
    // SecureStore/GoTrue bridge must not stall the error UI.
    if (!isRetryableFetchUserError(lastError)) {
      breadcrumb('auth', 'profile_cache_skipped_terminal_error', {});
      setUserFetchState('error');
      setUserFetchError(fetchUserErrorMessage(lastError));
      return false;
    }
    try {
      const sessionResult = await withTimeout(
        supabase.auth.getSession(),
        3000,
        'profile_cache_get_session'
      );
      const sessionUserId = sessionResult?.data?.session?.user?.id;
      if (sessionUserId) {
        const cached = await withTimeout(
          getCachedProfile(sessionUserId),
          3000,
          'profile_cache_read'
        );
        if (cached) {
          const isFirstApply = activeUserRef.current === null;
          applyFetchedUser({
            id: cached.id,
            email: cached.email,
            fullName: cached.fullName,
            role: cached.role,
            organizationId: cached.organizationId,
            avatarUrl: cached.avatarUrl,
          });
          setProfileSource('cache');
          setUserFetchState('success');
          setUserFetchError(null);
          breadcrumb('auth', 'profile_cache_used', {
            age_ms: Date.now() - cached.cachedAt,
            first_apply: isFirstApply,
          });
          if (isFirstApply) {
            trackEvent({
              name: 'profile_cache_used',
              props: { age_s: Math.max(0, Math.round((Date.now() - cached.cachedAt) / 1000)) },
            });
          }
          return true;
        }
      }
    } catch (cacheError) {
      if (__DEV__) console.error('[Auth] profile cache fallback failed:', cacheError);
    }

    setUserFetchState('error');
    setUserFetchError(fetchUserErrorMessage(lastError));
    return false;
  }), [applyFetchedUser, handleMfaRequiredResponse, registerDevice]);

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


  const handleSignOut = useCallback(async (options: SignOutOptions = {}) => {
    if (__DEV__) console.log('[Auth] handleSignOut: starting');
    const recoveryMode = options.recoveryMode ?? 'best_effort';
    await preserveSupportStaffRecordings(activeUserRef.current, recoveryMode);
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

    // Await transient-cache cleanup before clearing auth state so in-memory
    // bridges + cacheDirectory scratch are flushed. Drafts, stashes, and their
    // audio intentionally REMAIN on disk across logout (rule 8); per-user disk
    // scoping (rule 13) keeps them isolated on shared tablets.
    await withTimeout(clearTransientCaches(), 3000, 'transient_caches_cleanup');

    // Now clear stash user scoping and auth state
    setStashUserId(null);
    draftStorage.setUserId(null);
    // Reset durable scope (data is PRESERVED across logout, Rule 8 — this only
    // clears the in-memory scope pointer + offer list; re-scans on re-sign-in).
    durableTombstone.setUserId(null);
    durableActiveStore.setUserId(null);
    // Invalidate first so an in-flight launch scan that resolves after this
    // sign-out cannot repopulate the offer list for the next signed-in user.
    invalidateDurableRecoveries();
    durableRecoveryStore.clear();
    // Flush analytics then clear monitoring identity before we drop React state.
    // Flush is best-effort and bounded by internal PostHog timeouts.
    clearTelemetryIdentity();
    trackEvent({ name: 'session_signed_out', props: { trigger: 'user' } });
    setUser(null);
    setSession(null);
    setUserFetchState('idle');
    setUserFetchError(null);
    setProfileSource('live');
    localRecoveryScanIdRef.current += 1;
    recoveryScannedUserIdRef.current = null;
    setLocalRecoveryState('idle');
    setRecoveryDraftSlotId(null);
    setDeviceRegistrationBlock(null);
    setDeviceRegistrationPending(false);
    setIsPasswordRecovery(false);
    setMfaRequired(false);
    setMfaReturnPath(null);
    setMfaReason(null);
    setMfaCurrentLevel('aal1');
    setMfaNextLevel('aal1');
    setActiveMfaChallenge(null);
  }, [setRecoveryDraftSlotId]);

  useEffect(() => {
    activeUserRef.current = user;
  }, [user]);

  // Mutex for token refresh: prevents concurrent 401 handlers from racing
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  // Prevents re-entrant recovery: if refreshSession() fails inside onAuthStateChange,
  // Supabase may emit a second SIGNED_OUT. This flag ensures we only attempt recovery once.
  const sessionRecoveryAttemptedRef = useRef<boolean>(false);

  // Register the 401 handler: attempt token refresh before signing out
  useEffect(() => {
    apiClient.setOnDeviceRevoked(() => {
      handleSignOut({ recoveryMode: 'best_effort' }).catch(() => {});
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
              await handleSignOut({ recoveryMode: 'best_effort' });
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
          handleSignOut({ recoveryMode: 'best_effort' }).catch(() => {});
        } finally {
          refreshPromiseRef.current = null;
        }
      };

      refreshPromiseRef.current = doRefresh();
      await refreshPromiseRef.current;
    });
    apiClient.setOnSessionExpired(async () => {
      // A request stayed 401 even after onUnauthorized() ran its refresh+retry —
      // the session is unrecoverable. Route to sign-in instead of leaving a zombie
      // session (cached UI silently 401-ing every write). Guards: don't nuke a
      // just-established session on a transient 401, and don't fight an in-progress
      // sign-out (the refresh-failed path in onUnauthorized already signs out).
      const sessionAge = Date.now() - sessionTimestampRef.current;
      if (sessionAge < 10_000) return;
      if (userInitiatedSignOutRef.current) return;
      if (__DEV__) console.log('[Auth] onSessionExpired: 401 persisted after refresh — signing out to re-auth');
      setLogoutReason('session_expired');
      await handleSignOut({ recoveryMode: 'best_effort' });
    });
  }, [handleMfaRequiredResponse, handleSignOut, registerDevice]);

  useEffect(() => {
    // Hydrate the persisted min-version floor before any record-start gate check,
    // so a KNOWN-below-floor build blocks new recordings even on an OFFLINE cold
    // start (before the first API response re-learns the floor). Best-effort.
    hydrateMinVersionFloor().catch(() => {});

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
    measurePhase(
      'auth_init_get_session',
      undefined,
      () => withTimeout(supabase.auth.getSession(), 10_000, 'auth_init_get_session')
    ).then(async (result) => {
      const existingSession = result?.data?.session ?? null;
      if (existingSession) {
        if (existingSession.access_token) {
          // Trust the persisted session at cold start instead of blocking on a
          // server-side getUser() validation. That round-trip was the dominant
          // auth-init watchdog stall (Sentry RN-D, op:auth_init_get_user, >8s
          // even on a reachable network) and, worse, on an OFFLINE cold start
          // it timed out and fell through to refreshSession()+clearAll() —
          // signing the user out for merely being offline. The token is now
          // validated lazily by the first authed request: apiClient
          // .onUnauthorized refreshes+retries a 401, and onSessionExpired signs
          // out if the session is genuinely dead (both wired in the effect
          // above, which runs first). A network failure is not a 401, so the
          // cached session survives until connectivity returns.
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
            await preserveSupportStaffRecordings(activeUserRef.current, 'best_effort');
            // Transient-cache cleanup before clearing auth state — mirrors
            // handleSignOut. Clears only cached audio, waveform peaks, and
            // in-memory bridges; drafts/stashes/their audio intentionally REMAIN
            // on disk across an expired/revoked session (rule 8), isolated per
            // user (rule 13). Each step is bounded by withTimeout so a hung
            // native bridge can't trap setIsLoading(true) forever — the common
            // observable symptom is a blank spinner on cold start that only
            // clears via force-quit + relaunch.
            await withTimeout(clearTransientCaches(), 3000, 'transient_caches_cleanup');
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
            durableTombstone.setUserId(null);
            durableActiveStore.setUserId(null);
            invalidateDurableRecoveries();
            durableRecoveryStore.clear();
            // Drop telemetry identity before dropping React auth state, so any
            // error captured during the final teardown doesn't attribute to
            // the expired user. Mirrors the handleSignOut ordering.
            clearTelemetryIdentity();
            setUser(null);
            setSession(null);
            setProfileSource('live');
            localRecoveryScanIdRef.current += 1;
            recoveryScannedUserIdRef.current = null;
            setLocalRecoveryState('idle');
            setRecoveryDraftSlotId(null);
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
  }, [fetchUser, registerDevice, setRecoveryDraftSlotId]);

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

  // 1B: while running on the cached profile, re-fetch the live profile when
  // connectivity returns. Two triggers: a NetInfo connected event, and an
  // exponential-backoff timer (30s → 5min cap) for the cases NetInfo can't
  // see — API-only outage behind "connected" clinic wifi, captive portal
  // clearing. fetchUser's own terminal-failure branch re-applies the cache on
  // failure, so profileSource stays 'cache' and this effect keeps running;
  // on live success applyFetchedUser flips it to 'live' and this cleans up.
  useEffect(() => {
    if (profileSource !== 'cache') return;
    let cancelled = false;
    let inFlight = false;
    const refetch = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      fetchUser()
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        refetch();
      }
    });
    let delay = 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        refetch();
        delay = Math.min(delay * 2, 5 * 60_000);
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [profileSource, fetchUser]);

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

  const authReadinessValue = useMemo<AuthReadinessContextType>(() => ({
    session,
    isAuthenticated,
    isLoading,
    userFetchState,
    userFetchError,
    profileSource,
    localRecoveryState,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
    retryFetchUser: fetchUser,
    isPasswordRecovery,
    clearPasswordRecovery,
  }), [
    session,
    isAuthenticated,
    isLoading,
    userFetchState,
    userFetchError,
    profileSource,
    localRecoveryState,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
    fetchUser,
    isPasswordRecovery,
    clearPasswordRecovery,
  ]);

  const authActionsValue = useMemo<AuthActionsContextType>(() => ({
    signIn,
    signInWithGoogle,
    signInWithApple,
    signOut: handleSignOut,
  }), [signIn, signInWithGoogle, signInWithApple, handleSignOut]);

  const authDeviceRegistrationValue = useMemo<AuthDeviceRegistrationContextType>(() => ({
    deviceRegistrationBlock,
    dismissDeviceRegistrationBlock,
    retryDeviceRegistration,
    deviceRegistrationPending,
  }), [
    deviceRegistrationBlock,
    dismissDeviceRegistrationBlock,
    retryDeviceRegistration,
    deviceRegistrationPending,
  ]);

  const authMfaValue = useMemo<AuthMfaContextType>(() => ({
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
  }), [
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
  ]);

  const authContextValue = useMemo<AuthContextType>(() => ({
    user,
    session,
    isAuthenticated,
    isLoading,
    userFetchState,
    userFetchError,
    profileSource,
    localRecoveryState,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
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
  }), [
    user,
    session,
    isAuthenticated,
    isLoading,
    userFetchState,
    userFetchError,
    profileSource,
    localRecoveryState,
    pendingRecoveryDraftSlotId,
    consumePendingRecoveryDraftSlotId,
    fetchUser,
    signIn,
    signInWithGoogle,
    signInWithApple,
    handleSignOut,
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
  ]);

  return (
    <AuthContext.Provider value={authContextValue}>
      <AuthUserContext.Provider value={user}>
        <AuthReadinessContext.Provider value={authReadinessValue}>
          <AuthActionsContext.Provider value={authActionsValue}>
            <AuthDeviceRegistrationContext.Provider value={authDeviceRegistrationValue}>
              <AuthMfaContext.Provider value={authMfaValue}>
                {children}
              </AuthMfaContext.Provider>
            </AuthDeviceRegistrationContext.Provider>
          </AuthActionsContext.Provider>
        </AuthReadinessContext.Provider>
      </AuthUserContext.Provider>
    </AuthContext.Provider>
  );
}

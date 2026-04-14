import React, { createContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import type { AppStateStatus } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { Paths, Directory, File as ExpoFile } from 'expo-file-system';
import { safeDeleteFile } from '../lib/fileOps';
import { supabase } from './supabase';
import {
  signInWithGoogleNative,
  signInWithAppleNative,
  signOutNativeGoogle,
  waitForPendingAppleProfileSync,
  type AuthResult,
} from './socialAuth';
import { secureStorage } from '../lib/secureStorage';
import { apiClient, ApiError } from '../api/client';
import { stashStorage } from '../lib/stashStorage';
import { stashAudioManager } from '../lib/stashAudioManager';
import { draftStorage } from '../lib/draftStorage';
import { audioTempFiles } from '../lib/audioTempFiles';
import { queryClient } from '../lib/queryClient';
import { audioEditorBridge } from '../lib/audioEditorBridge';
import { clearClipboard } from '../lib/secureClipboard';
import { clearPeakCache } from '../lib/waveformCache';
import { setLogoutReason } from '../lib/logoutReason';
import type { User } from '../types';

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

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  userFetchState: UserFetchState;
  userFetchError: string | null;
  retryFetchUser: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  signInWithGoogle: () => Promise<AuthResult>;
  signInWithApple: () => Promise<AuthResult>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isAuthenticated: false,
  isLoading: true,
  userFetchState: 'idle',
  userFetchError: null,
  retryFetchUser: async () => {},
  signIn: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signInWithApple: async () => ({ error: null }),
  signOut: async () => {},
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
 * Delete all per-user PHI from on-device storage. Must run while the scope
 * user IDs are still set so the clearAll methods can read the correct data.
 * Every entry is best-effort — a single failure must not block logout.
 * Called from both the explicit sign-out path and the SIGNED_OUT fallback
 * in onAuthStateChange so transient session expiry cleans up the same set
 * of artefacts as a user-initiated sign-out.
 */
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
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userFetchState, setUserFetchState] = useState<UserFetchState>('idle');
  const [userFetchError, setUserFetchError] = useState<string | null>(null);

  // Tracks when the current session was established, so we can ignore stale 401s
  const sessionTimestampRef = useRef<number>(0);
  const handleSignOutRef = useRef<() => Promise<void>>(async () => {});
  // Distinguishes user-initiated sign-out from session expiry in onAuthStateChange.
  // When Supabase emits SIGNED_OUT due to a failed refresh, this flag is false —
  // allowing one recovery refresh attempt before clearing auth state.
  const userInitiatedSignOutRef = useRef<boolean>(false);

  const applyFetchedUser = useCallback((fetchedUser: User | null) => {
    setUser(fetchedUser);
    if (!fetchedUser?.id) return;
    const scopedUserId = fetchedUser.id;
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

  const fetchUser = useCallback(async () => {
    const requestMe = () => apiClient.get<{ user: User }>('/auth/me');
    setUserFetchState('loading');
    setUserFetchError(null);

    // One attempt: returns true on success. Throws on failure.
    // The 404 bootstrap path is self-contained: it either succeeds and returns
    // true, forces sign-out and returns true, or throws a retryable error.
    const attempt = async (): Promise<boolean> => {
      try {
        if (__DEV__) console.log('[Auth] fetchUser: requesting /auth/me');
        const body = await requestMe();
        if (__DEV__) console.log('[Auth] fetchUser: success, user:', body.user?.email ?? 'null');
        applyFetchedUser(body.user ?? null);
        return true;
      } catch (error) {
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
            applyFetchedUser(retryBody.user ?? null);
            return true;
          } catch (retryError) {
            if (__DEV__) console.log('[Auth] fetchUser: retry after Apple sync still missing user', retryError);
          }

          if (__DEV__) console.log('[Auth] fetchUser: 404, bootstrapping via /auth/register');
          try {
            await apiClient.post('/auth/register', {});
            const body = await requestMe();
            if (__DEV__) console.log('[Auth] fetchUser: bootstrap succeeded, user:', body.user?.email ?? 'null');
            applyFetchedUser(body.user ?? null);
            return true;
          } catch (bootstrapError) {
            if (__DEV__) console.log('[Auth] fetchUser: bootstrap failed', bootstrapError);
            setLogoutReason('session_expired');
            await handleSignOutRef.current();
            return true;
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
        const ok = await attempt();
        if (ok) {
          setUserFetchState('success');
          setUserFetchError(null);
          return;
        }
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
  }, [applyFetchedUser]);

  const registerDevice = useCallback(async () => {
    try {
      const deviceId = await secureStorage.getDeviceId();
      if (!deviceId) return;
      await apiClient.post('/api/device-sessions/register', {
        deviceId,
        deviceType: Platform.OS === 'ios' ? 'ios_tablet' : 'android_tablet',
        appVersion: require('../../package.json').version,
      });
    } catch (error) {
      if (__DEV__) console.log('[Auth] device registration failed (non-fatal):', error);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    if (__DEV__) console.log('[Auth] handleSignOut: starting');
    userInitiatedSignOutRef.current = true;
    // Clear in-memory token immediately
    apiClient.setToken(null);
    try {
      await supabase.auth.signOut();
    } catch (error) {
      if (__DEV__) console.error('[Auth] supabase.auth.signOut failed:', error);
    }
    await signOutNativeGoogle();
    try {
      await secureStorage.clearAll();
    } catch (error) {
      if (__DEV__) console.error('[Auth] clearAll failed:', error);
    }
    // Clear cached PHI from React Query
    queryClient.clear();

    // Await critical PHI cleanup before clearing auth state.
    // This prevents a race where the next user signs in while the previous
    // user's stash data and audio files are still on disk.
    await performPhiCleanup();

    // Now clear stash user scoping and auth state
    setStashUserId(null);
    draftStorage.setUserId(null);
    setUser(null);
    setSession(null);
    setUserFetchState('idle');
    setUserFetchError(null);
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
          const { error } = await supabase.auth.refreshSession();
          if (error) {
            // Retry once after 3s — guards against transient network blips
            if (__DEV__) console.log('[Auth] onUnauthorized: first refresh failed, retrying in 3s');
            await new Promise<void>(resolve => setTimeout(resolve, 3000));
            const { error: retryError } = await supabase.auth.refreshSession();
            if (retryError) {
              if (__DEV__) console.log('[Auth] onUnauthorized: retry also failed, signing out');
              setLogoutReason('session_expired');
              await handleSignOut();
            } else {
              if (__DEV__) console.log('[Auth] onUnauthorized: retry succeeded');
            }
          } else {
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh succeeded');
          }
        } catch {
          if (__DEV__) console.log('[Auth] onUnauthorized: refresh threw, signing out');
          setLogoutReason('session_expired');
          handleSignOut().catch(() => {});
        } finally {
          refreshPromiseRef.current = null;
        }
      };

      refreshPromiseRef.current = doRefresh();
      await refreshPromiseRef.current;
    });
  }, [handleSignOut]);

  useEffect(() => {
    // Restore existing session on startup
    supabase.auth.getSession().then(async ({ data: { session: existingSession } }) => {
      if (existingSession) {
        if (existingSession.access_token) {
          const { data: { user: validatedUser }, error: validateError } =
            await supabase.auth.getUser(existingSession.access_token);
          if (validateError || !validatedUser) {
            if (__DEV__) console.log('[Auth] session restore: server rejected token, attempting refresh');
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError || !refreshData.session) {
              if (__DEV__) console.log('[Auth] session restore: refresh also failed, clearing');
              apiClient.setToken(null);
              await secureStorage.clearAll().catch(() => {});
              return;
            }
            if (__DEV__) console.log('[Auth] session restore: refresh succeeded');
            setSession(refreshData.session);
            sessionTimestampRef.current = Date.now();
            apiClient.setToken(refreshData.session.access_token);
            fetchUser().catch(() => {});
            registerDevice().catch(() => {});
            return;
          }

          setSession(existingSession);
          sessionTimestampRef.current = Date.now();
          apiClient.setToken(existingSession.access_token);
          fetchUser().catch(() => {});
          registerDevice().catch(() => {});
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
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (__DEV__) console.log('[Auth] onAuthStateChange:', event,
          'hasToken:', !!newSession?.access_token,
          'expires_at:', newSession?.expires_at);

        if (event === 'INITIAL_SESSION') return;

        try {
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
            // or is revoked by the server.
            await performPhiCleanup();
            await signOutNativeGoogle();
            await secureStorage.clearAll();
            // Clear cached PHI so the next user on this shared tablet
            // doesn't briefly see the previous user's recording list.
            queryClient.clear();
            setStashUserId(null);
            draftStorage.setUserId(null);
            setUser(null);
            setSession(null);
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
            const { error } = await supabase.auth.refreshSession();
            if (error) {
              if (__DEV__) console.log('[Auth] foreground refresh failed:', error.message);
            } else {
              if (__DEV__) console.log('[Auth] foreground refresh succeeded');
            }
          } else {
            if (__DEV__) console.log('[Auth] foreground resume: session still valid');
          }
        } catch (e) {
          if (__DEV__) console.error('[Auth] foreground refresh threw:', e);
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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (__DEV__) console.error('[Auth] signIn failed:', error.message, error.status);

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
    registerDevice().catch(() => {});
    return { error: null };
  }, [registerDevice]);

  const signInWithGoogle = useCallback(async () => {
    if (__DEV__) console.log('[Auth] signInWithGoogle: attempting');
    const result = await signInWithGoogleNative();
    if (!result.error && !result.cancelled) {
      if (__DEV__) console.log('[Auth] signInWithGoogle: success');
      registerDevice().catch(() => {});
    } else if (__DEV__) {
      console.log('[Auth] signInWithGoogle: failed or cancelled', result.error);
    }
    return result;
  }, [registerDevice]);

  const signInWithApple = useCallback(async () => {
    if (__DEV__) console.log('[Auth] signInWithApple: attempting');
    const result = await signInWithAppleNative();
    if (!result.error && !result.cancelled) {
      if (__DEV__) console.log('[Auth] signInWithApple: success');
      registerDevice().catch(() => {});
    } else if (__DEV__) {
      console.log('[Auth] signInWithApple: failed or cancelled', result.error);
    }
    return result;
  }, [registerDevice]);

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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

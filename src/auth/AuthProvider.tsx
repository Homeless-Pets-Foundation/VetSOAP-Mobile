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
import { audioTempFiles } from '../lib/audioTempFiles';
import { queryClient } from '../lib/queryClient';
import { audioEditorBridge } from '../lib/audioEditorBridge';
import { clearClipboard } from '../lib/secureClipboard';
import { clearPeakCache } from '../lib/waveformCache';
import { setLogoutReason } from '../lib/logoutReason';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Tracks when the current session was established, so we can ignore stale 401s
  const sessionTimestampRef = useRef<number>(0);
  const handleSignOutRef = useRef<() => Promise<void>>(async () => {});

  const applyFetchedUser = useCallback((fetchedUser: User | null) => {
    setUser(fetchedUser);
    if (!fetchedUser?.id) return;
    const scopedUserId = fetchedUser.id;
    const isRecoveryScopeCurrent = () =>
      stashStorage.getUserId() === scopedUserId &&
      stashAudioManager.getUserId() === scopedUserId;

    setStashUserId(scopedUserId);
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
    try {
      if (__DEV__) console.log('[Auth] fetchUser: requesting /auth/me');
      const body = await requestMe();
      if (__DEV__) console.log('[Auth] fetchUser: success, user:', body.user?.email ?? 'null');
      applyFetchedUser(body.user ?? null);
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
          return;
        } catch (retryError) {
          if (__DEV__) console.log('[Auth] fetchUser: retry after Apple sync still missing user', retryError);
        }

        if (__DEV__) console.log('[Auth] fetchUser: 404, bootstrapping via /auth/register');
        try {
          await apiClient.post('/auth/register', {});
          const body = await requestMe();
          if (__DEV__) console.log('[Auth] fetchUser: bootstrap succeeded, user:', body.user?.email ?? 'null');
          applyFetchedUser(body.user ?? null);
        } catch (bootstrapError) {
          if (__DEV__) console.log('[Auth] fetchUser: bootstrap failed', bootstrapError);
          setLogoutReason('session_expired');
          await handleSignOutRef.current();
        }
        return;
      }
      if (__DEV__) console.log('[Auth] fetchUser: failed', error);
    }
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
    try {
      await Promise.all([
        stashStorage.clearAllStashes().catch(() =>
          stashStorage.clearAllStashes()
        ).catch(() => {}),
        stashAudioManager.deleteAllStashedAudio().catch(() =>
          stashAudioManager.deleteAllStashedAudio()
        ).catch(() => {}),
        Promise.resolve(cleanupAudioCache()),
        Promise.resolve(audioTempFiles.cleanupAll()),
        Promise.resolve(clearPeakCache()),
      ]);
    } catch {
      // All cleanup is best-effort — don't block sign-out indefinitely
    }

    // Clear in-memory PHI: audio editor bridge state and clipboard
    audioEditorBridge.clear();
    clearClipboard();

    // Now clear stash user scoping and auth state
    setStashUserId(null);
    setUser(null);
    setSession(null);
  }, []);

  // Mutex for token refresh: prevents concurrent 401 handlers from racing
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

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
            setSession(newSession);
            sessionTimestampRef.current = Date.now();
            if (__DEV__) console.log('[Auth] session established, storing token');
            apiClient.setToken(newSession.access_token);
            await fetchUser();
            if (__DEV__) console.log('[Auth] sign-in flow complete');
          } else {
            // Hold isLoading=true during PHI cleanup so the route guard doesn't
            // redirect to login before stash/audio deletion finishes. setSession(null)
            // is deferred until after all cleanup — mirrors handleSignOut ordering.
            setIsLoading(true);
            if (__DEV__) console.log('[Auth] no access_token, clearing session');
            apiClient.setToken(null);
            // Await stash PHI cleanup before clearing auth state — mirrors handleSignOut.
            // Prevents the next user on a shared tablet from seeing stashed patient data
            // when a session expires or is revoked by the server.
            try {
              await Promise.all([
                stashStorage.clearAllStashes().catch(() =>
                  stashStorage.clearAllStashes()
                ).catch(() => {}),
                stashAudioManager.deleteAllStashedAudio().catch(() =>
                  stashAudioManager.deleteAllStashedAudio()
                ).catch(() => {}),
              ]);
            } catch {}
            audioEditorBridge.clear();
            clearClipboard();
            await signOutNativeGoogle();
            await secureStorage.clearAll();
            // Clear cached PHI so the next user on this shared tablet
            // doesn't briefly see the previous user's recording list.
            queryClient.clear();
            setStashUserId(null);
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
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') return;
      if (!session?.expires_at) return;

      const now = Date.now() / 1000;
      const bufferSeconds = 600;
      if (now > session.expires_at - bufferSeconds) {
        if (refreshPromiseRef.current) {
          if (__DEV__) console.log('[Auth] foreground resume: refresh already in flight, skipping');
          return;
        }

        if (__DEV__) console.log('[Auth] foreground resume: token expired or near-expiry, refreshing');
        const doRefresh = async () => {
          try {
            const { error } = await supabase.auth.refreshSession();
            if (error) {
              if (__DEV__) console.log('[Auth] foreground refresh failed:', error.message);
            } else {
              if (__DEV__) console.log('[Auth] foreground refresh succeeded');
            }
          } catch (e) {
            if (__DEV__) console.error('[Auth] foreground refresh threw:', e);
          } finally {
            refreshPromiseRef.current = null;
          }
        };
        refreshPromiseRef.current = doRefresh();
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [session?.expires_at]);

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

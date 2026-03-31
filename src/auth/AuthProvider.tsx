import React, { createContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import type { AppStateStatus } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { cacheDirectory, readDirectoryAsync, deleteAsync } from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { secureStorage } from '../lib/secureStorage';
import { stashStorage } from '../lib/stashStorage';
import { stashAudioManager } from '../lib/stashAudioManager';
import { audioTempFiles } from '../lib/audioTempFiles';
import { apiClient } from '../api/client';
import { queryClient } from '../lib/queryClient';
import { audioEditorBridge } from '../lib/audioEditorBridge';
import { clearClipboard } from '../lib/secureClipboard';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isAuthenticated: false,
  isLoading: true,
  signIn: async () => ({ error: null }),
  signOut: async () => {},
});

/** Check if the Supabase session token has expired. */
function isTokenExpired(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined || expiresAt === null) return false;
  return Date.now() / 1000 > expiresAt;
}

/** Delete orphaned audio recordings from the cache directory. */
async function cleanupAudioCache(): Promise<void> {
  try {
    if (!cacheDirectory) return;
    const files = await readDirectoryAsync(cacheDirectory);
    await Promise.all(
      files
        .filter((f) => f.endsWith('.m4a'))
        .map((f) => deleteAsync(`${cacheDirectory}${f}`, { idempotent: true }).catch(() => {}))
    );
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

  const fetchUser = useCallback(async () => {
    try {
      if (__DEV__) console.log('[Auth] fetchUser: requesting /auth/me');
      const body = await apiClient.get<{ user: User }>('/auth/me');
      if (__DEV__) console.log('[Auth] fetchUser: success, user:', body.user?.email ?? 'null');
      const fetchedUser = body.user ?? null;
      setUser(fetchedUser);
      // Set user ID for stash scoping as soon as we know it
      if (fetchedUser?.id) {
        setStashUserId(fetchedUser.id);
        // Now that user ID is set, safe to clean up orphaned stash data.
        // Must run AFTER setStashUserId or getStashedSessions returns []
        // and all stash audio dirs get deleted as "orphaned".
        stashStorage.clearLegacyGlobalStashes().catch(() => {});
        stashAudioManager.deleteAllStashedAudioGlobal().catch(() => {});
        stashStorage.getStashedSessions().then(async (sessions) => {
          const validIds = sessions.map((s) => s.id);
          const recovered = await stashAudioManager.recoverOrCleanupOrphans(validIds);
          // If orphaned sessions were recovered from manifests, save them to SecureStore
          for (const session of recovered) {
            await stashStorage.addStashedSession(session);
            await stashAudioManager.deleteRecoveryManifest(session.id);
          }
        }).catch(() => {});
      }
    } catch (error) {
      if (__DEV__) console.log('[Auth] fetchUser: failed', error);
    }
  }, []);

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
        cleanupAudioCache().catch(() => {}),
        audioTempFiles.cleanupAll().catch(() => {}),
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
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh failed, signing out');
            await handleSignOut();
          } else {
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh succeeded');
          }
        } catch {
          if (__DEV__) console.log('[Auth] onUnauthorized: refresh threw, signing out');
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
        cleanupAudioCache().catch(() => {});
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
          setSession(newSession);

          if (newSession?.access_token) {
            sessionTimestampRef.current = Date.now();
            if (__DEV__) console.log('[Auth] session established, storing token');
            apiClient.setToken(newSession.access_token);
            await fetchUser();
            if (__DEV__) console.log('[Auth] sign-in flow complete');
          } else {
            if (__DEV__) console.log('[Auth] no access_token, clearing session');
            apiClient.setToken(null);
            await secureStorage.clearAll();
            setStashUserId(null);
            setUser(null);
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
      const bufferSeconds = 300;
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
        signOut: handleSignOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

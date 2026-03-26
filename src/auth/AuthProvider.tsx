import React, { createContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { cacheDirectory, readDirectoryAsync, deleteAsync } from 'expo-file-system/legacy';
import { supabase } from './supabase';
import { secureStorage } from '../lib/secureStorage';
import { apiClient } from '../api/client';
import { queryClient } from '../lib/queryClient';
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
  // A session with an access_token but no expires_at should be treated as valid —
  // the server will reject it if it's actually expired. Treating undefined as expired
  // causes a sign-out race when onAuthStateChange fires before expires_at is populated.
  if (expiresAt === undefined || expiresAt === null) return false;
  // expires_at is in seconds (Unix timestamp)
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
      setUser(body.user ?? null);
    } catch (error) {
      if (__DEV__) console.log('[Auth] fetchUser: failed', error);
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
    // Clean up orphaned audio temp files
    cleanupAudioCache().catch(() => {});
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

      // Don't sign out if the session was just established — the 401 is
      // likely from a stale request that was in-flight before sign-in.
      if (sessionAge < 10_000) {
        if (__DEV__) console.log('[Auth] onUnauthorized: ignoring, session too fresh (<10s)');
        return;
      }

      // If a refresh is already in flight, wait for it instead of starting another
      if (refreshPromiseRef.current) {
        await refreshPromiseRef.current;
        return;
      }

      const doRefresh = async () => {
        try {
          if (__DEV__) console.log('[Auth] onUnauthorized: attempting token refresh');
          const { data, error } = await supabase.auth.refreshSession();
          if (error) {
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh failed, signing out');
            await handleSignOut();
          } else {
            if (__DEV__) console.log('[Auth] onUnauthorized: refresh succeeded');
          }
          // If refresh succeeded, Supabase's onAuthStateChange will update the token
        } catch (e) {
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
          // Validate session server-side before trusting local state.
          // Catches revoked sessions (admin sign-out, password change on another device).
          const { data: { user: validatedUser }, error: validateError } =
            await supabase.auth.getUser(existingSession.access_token);
          if (validateError || !validatedUser) {
            if (__DEV__) console.log('[Auth] session restore: server rejected token, clearing');
            apiClient.setToken(null);
            await secureStorage.clearAll().catch(() => {});
            return;
          }

          setSession(existingSession);
          sessionTimestampRef.current = Date.now();
          // Set in-memory token first (reliable), then persist to SecureStore (best-effort)
          apiClient.setToken(existingSession.access_token);
          fetchUser().catch(() => {});
        } else {
          setSession(existingSession);
        }
      }
      // Clean up orphaned audio recordings from prior crashes (deferred to avoid competing with initial render)
      setTimeout(() => { cleanupAudioCache().catch(() => {}); }, 5000);
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

        // Skip INITIAL_SESSION — getSession() above already handles startup
        if (event === 'INITIAL_SESSION') return;

        try {
          setSession(newSession);

          if (newSession?.access_token) {
            sessionTimestampRef.current = Date.now();
            if (__DEV__) console.log('[Auth] session established, storing token');
            // Set in-memory token immediately (reliable), then persist (best-effort)
            apiClient.setToken(newSession.access_token);
            if (newSession.refresh_token) {
              await secureStorage.setRefreshToken(newSession.refresh_token);
            }
            await fetchUser();
            if (__DEV__) console.log('[Auth] sign-in flow complete');
          } else {
            if (__DEV__) console.log('[Auth] no access_token, clearing session');
            apiClient.setToken(null);
            await secureStorage.clearAll();
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
  }, [fetchUser]);

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
      // In dev, surface the actual Supabase error so misconfig is immediately obvious
      if (__DEV__) {
        return { error: `[DEV] ${error.message} (status: ${error.status})` };
      }
      return { error: 'Invalid email or password' };
    }
    if (__DEV__) console.log('[Auth] signIn: success');
    return { error: null };
  }, []);

  const tokenExpired = isTokenExpired(session?.expires_at);
  const isAuthenticated = !!session?.access_token && !tokenExpired;
  if (__DEV__ && session?.access_token) {
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

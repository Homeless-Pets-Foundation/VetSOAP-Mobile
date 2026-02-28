import React, { createContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { secureStorage } from '../lib/secureStorage';
import { apiClient } from '../api/client';
import type { User } from '../types';
import { API_URL } from '../config';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async (accessToken: string) => {
    try {
      const response = await fetch(`${API_URL}/api/users/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
      }
    } catch {
      // User fetch failed — will retry on next session event
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    await secureStorage.clearAll();
    setUser(null);
    setSession(null);
  }, []);

  // Register the 401 handler so expired tokens redirect to login
  useEffect(() => {
    apiClient.setOnUnauthorized(() => {
      handleSignOut();
    });
  }, [handleSignOut]);

  useEffect(() => {
    // Restore existing session on startup
    supabase.auth.getSession().then(({ data: { session: existingSession } }) => {
      if (existingSession) {
        setSession(existingSession);
        if (existingSession.access_token) {
          secureStorage.setToken(existingSession.access_token);
          fetchUser(existingSession.access_token);
        }
      }
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, newSession) => {
        setSession(newSession);

        if (newSession?.access_token) {
          await secureStorage.setToken(newSession.access_token);
          if (newSession.refresh_token) {
            await secureStorage.setRefreshToken(newSession.refresh_token);
          }
          await fetchUser(newSession.access_token);
        } else {
          await secureStorage.clearAll();
          setUser(null);
        }

        setIsLoading(false);
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [fetchUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return { error: error.message };
    }
    return { error: null };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isAuthenticated: !!session?.access_token,
        isLoading,
        signIn,
        signOut: handleSignOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

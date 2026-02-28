import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config';
import { secureStorage } from '../lib/secureStorage';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: {
      async getItem(key: string) {
        if (key.includes('access_token') || key.includes('token')) {
          return secureStorage.getToken();
        }
        return null;
      },
      async setItem(key: string, value: string) {
        // Supabase stores the entire session as a JSON string under one key
        // We parse it to extract access_token and refresh_token
        try {
          const session = JSON.parse(value);
          if (session?.access_token) {
            await secureStorage.setToken(session.access_token);
          }
          if (session?.refresh_token) {
            await secureStorage.setRefreshToken(session.refresh_token);
          }
        } catch {
          // Not a session JSON, store raw
          await secureStorage.setToken(value);
        }
      },
      async removeItem(_key: string) {
        await secureStorage.clearAll();
      },
    },
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

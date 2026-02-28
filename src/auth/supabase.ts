import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config';
import { secureStorage } from '../lib/secureStorage';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: {
      async getItem(_key: string) {
        return secureStorage.getSession();
      },
      async setItem(_key: string, value: string) {
        await secureStorage.setSession(value);
        try {
          const session = JSON.parse(value);
          if (session?.access_token) {
            await secureStorage.setToken(session.access_token);
          }
          if (session?.refresh_token) {
            await secureStorage.setRefreshToken(session.refresh_token);
          }
        } catch {
          // Not JSON — ignore
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

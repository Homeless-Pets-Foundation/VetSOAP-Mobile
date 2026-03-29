import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, CONFIG_MISSING } from '../config';
import { secureStorage } from '../lib/secureStorage';

function initSupabase() {
  if (CONFIG_MISSING || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Provide valid-looking placeholders to avoid SDK validation errors at module load.
    // CONFIG_MISSING gate in _layout.tsx prevents any real usage of this client.
    return createClient('https://placeholder.invalid', 'placeholder-key', {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: {
        async getItem(_key: string) {
          return secureStorage.getSession();
        },
        async setItem(_key: string, value: string) {
          await secureStorage.setSession(value);
          try {
            const session = JSON.parse(value);
            if (typeof session?.access_token === 'string') {
              await secureStorage.setToken(session.access_token);
            }
          } catch {
            // Not valid JSON — ignore
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
}

export const supabase = initSupabase();

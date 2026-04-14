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
          // Write session with read-back verification — critical after refresh token rotation.
          // Supabase invalidates the old refresh token immediately on rotation. If the write
          // silently fails (Keystore error, Direct Boot, low storage), the new token is lost
          // and the next refresh will fail even though rotation succeeded server-side.
          try {
            await secureStorage.setSession(value);
            const readBack = await secureStorage.getSession();
            if (readBack !== value) {
              // Write appeared to succeed but read-back differs — retry once
              await secureStorage.setSession(value);
            }
          } catch (error) {
            if (__DEV__) console.error('[Supabase storage] setSession failed, retrying:', error);
            await new Promise<void>(resolve => setTimeout(resolve, 1500));
            try {
              await secureStorage.setSession(value);
            } catch { /* best-effort — next refresh will catch if this also failed */ }
          }
          // Store access token separately for the API client (best-effort)
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

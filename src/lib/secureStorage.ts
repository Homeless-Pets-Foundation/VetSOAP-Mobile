import * as SecureStore from 'expo-secure-store';

const KEYS = {
  ACCESS_TOKEN: 'captivet_access_token',
  REFRESH_TOKEN: 'captivet_refresh_token',
  SESSION: 'captivet_session',
} as const;

export const secureStorage = {
  async getToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(KEYS.ACCESS_TOKEN);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getToken failed:', error);
      return null;
    }
  },

  async setToken(token: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, token, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] setToken failed:', error);
    }
  },

  async getSession(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(KEYS.SESSION);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getSession failed:', error);
      return null;
    }
  },

  async setSession(session: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(KEYS.SESSION, session, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] setSession failed:', error);
    }
  },

  async clearAll(): Promise<void> {
    try { await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync(KEYS.SESSION); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('captivet_biometric_enabled'); } catch { /* ignore */ }
    // Clean up old vetsoap_* keys from pre-rebrand versions
    try { await SecureStore.deleteItemAsync('vetsoap_access_token'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap_refresh_token'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap_session'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap_biometric_enabled'); } catch { /* ignore */ }
    // Clean up old colon-based keys from earlier versions
    try { await SecureStore.deleteItemAsync('vetsoap:access_token'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap:refresh_token'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap:session'); } catch { /* ignore */ }
    try { await SecureStore.deleteItemAsync('vetsoap:biometric_enabled'); } catch { /* ignore */ }
  },
};

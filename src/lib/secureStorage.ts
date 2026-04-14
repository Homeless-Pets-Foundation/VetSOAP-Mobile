import * as SecureStore from 'expo-secure-store';

const KEYS = {
  ACCESS_TOKEN: 'captivet_access_token',
  REFRESH_TOKEN: 'captivet_refresh_token',
  SESSION: 'captivet_session',
  DEVICE_ID: 'captivet_device_id',
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

  async deleteToken(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] deleteToken failed:', error);
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

  /** Get or generate a persistent device ID (survives sign-out, tied to this device). */
  async getDeviceId(): Promise<string | null> {
    try {
      let id = await SecureStore.getItemAsync(KEYS.DEVICE_ID);
      if (!id) {
        // Generate UUID v4 — prefer crypto.getRandomValues (Hermes 0.76+),
        // fall back to Math.random for older runtimes
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          const bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
          bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
          const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
          id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        } else {
          // Math.random fallback — less entropy but functional
          id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
        }
        await SecureStore.setItemAsync(KEYS.DEVICE_ID, id, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
      }
      return id;
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getDeviceId failed:', error);
      return null;
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

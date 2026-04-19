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
      let id: string | null = null;
      try {
        id = await SecureStore.getItemAsync(KEYS.DEVICE_ID);
      } catch (error) {
        if (__DEV__) console.error('[SecureStorage] getDeviceId read failed:', error);
      }

      if (!id) {
        // Prefer expo-crypto (reliable across Hermes on iOS and Android);
        // fall back to global crypto.getRandomValues. iOS Hermes did not
        // expose `globalThis.crypto.getRandomValues` in the EAS preview
        // build we shipped on 2026-04-19, so expo-crypto is the primary.
        const bytes = new Uint8Array(16);
        let haveRandom = false;
        try {
          const ExpoCrypto = require('expo-crypto') as {
            getRandomBytes?: (n: number) => Uint8Array;
          };
          if (ExpoCrypto.getRandomBytes) {
            bytes.set(ExpoCrypto.getRandomBytes(16));
            haveRandom = true;
          }
        } catch {
          // Fall through to global crypto.
        }
        if (!haveRandom && typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(bytes);
          haveRandom = true;
        }
        if (!haveRandom) {
          if (__DEV__) console.error('[SecureStorage] getDeviceId: no random source');
          return null;
        }

        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

        try {
          await SecureStore.setItemAsync(KEYS.DEVICE_ID, id, {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
          });
        } catch (error) {
          if (__DEV__) console.error('[SecureStorage] getDeviceId set failed:', error);
          // iOS Simulator Keychain sometimes rejects
          // kSecAttrAccessibleAfterFirstUnlock; retry without it. The in-memory
          // id is still returned even if persistence ultimately fails, so the
          // current request proceeds (next launch will regenerate).
          try { await SecureStore.setItemAsync(KEYS.DEVICE_ID, id); } catch { /* ignore */ }
        }
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

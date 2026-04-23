import * as SecureStore from 'expo-secure-store';
import { getSecureUuid } from './random';

const KEYS = {
  ACCESS_TOKEN: 'captivet_access_token',
  REFRESH_TOKEN: 'captivet_refresh_token',
  SESSION: 'captivet_session',
  DEVICE_ID: 'captivet_device_id',
} as const;

/**
 * Report a SecureStore failure without creating an import cycle. Loaded
 * lazily so module-load in monitoring.ts staying zero-cost (rule 1). Rate
 * limiting happens inside `captureMessage` so a recurring Keystore fault
 * doesn't flood Sentry. Falls back to a no-op if monitoring isn't wired.
 */
function reportSecureStoreFailure(op: string, error: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureMessage } = require('./monitoring') as typeof import('./monitoring');
    captureMessage('secure_store_failed', 'warning', {
      tags: { op },
      extra: { error: String(error).slice(0, 200) },
    });
  } catch {
    // monitoring not ready / not compiled in dev client — swallow
  }
}

export const secureStorage = {
  async getToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(KEYS.ACCESS_TOKEN);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getToken failed:', error);
      reportSecureStoreFailure('getToken', error);
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
      reportSecureStoreFailure('setToken', error);
    }
  },

  async deleteToken(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] deleteToken failed:', error);
      reportSecureStoreFailure('deleteToken', error);
    }
  },

  async getSession(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(KEYS.SESSION);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getSession failed:', error);
      reportSecureStoreFailure('getSession', error);
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
      reportSecureStoreFailure('setSession', error);
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
        try {
          id = getSecureUuid();
        } catch (error) {
          if (__DEV__) console.error('[SecureStorage] getDeviceId: no random source', error);
          return null;
        }

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
          try { await SecureStore.setItemAsync(KEYS.DEVICE_ID, id); } catch (retryError) {
          reportSecureStoreFailure('setDeviceIdRetryFallback', retryError);
        }
        }
      }
      return id;
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getDeviceId failed:', error);
      reportSecureStoreFailure('getDeviceId', error);
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

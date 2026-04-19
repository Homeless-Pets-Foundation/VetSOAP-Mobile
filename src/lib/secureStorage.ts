import * as SecureStore from 'expo-secure-store';
import { File as ExpoFile, Paths } from 'expo-file-system';

const KEYS = {
  ACCESS_TOKEN: 'captivet_access_token',
  REFRESH_TOKEN: 'captivet_refresh_token',
  SESSION: 'captivet_session',
  DEVICE_ID: 'captivet_device_id',
} as const;

// Diagnostic: persist getDeviceId state to a file readable from outside the
// app via `xcrun simctl get_app_container ... data` (iOS sim). Best-effort —
// swallow any I/O error. Remove once the device-ID-on-iOS bug is fixed.
async function writeDeviceIdDebug(state: Record<string, unknown>): Promise<void> {
  try {
    const file = new ExpoFile(Paths.document, 'device-id-debug.log');
    const line = `${new Date().toISOString()} ${JSON.stringify(state)}\n`;
    let prior = '';
    try { if (file.exists) prior = await file.text(); } catch { /* ignore */ }
    file.write(prior + line);
  } catch { /* ignore */ }
}

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
    // Diagnostic state captured at each branch; written to a log file in
    // documentDirectory. Drop once iOS device-ID bug is resolved.
    const diag: Record<string, unknown> = { phase: 'start' };
    try {
      let id: string | null = null;
      try {
        id = await SecureStore.getItemAsync(KEYS.DEVICE_ID);
        diag.secureStoreGet = id ? 'hit' : 'miss';
      } catch (e) {
        diag.secureStoreGetError = String(e);
      }

      if (!id) {
        // Prefer expo-crypto (present as a dep, reliable across RN/Hermes on
        // both iOS and Android); fall back to global crypto.getRandomValues
        // if available; return null only if neither path works.
        const bytes = new Uint8Array(16);
        let source: 'expo-crypto' | 'global-crypto' | 'none' = 'none';
        try {
          const ExpoCrypto = require('expo-crypto') as {
            getRandomBytes?: (n: number) => Uint8Array;
          };
          if (ExpoCrypto.getRandomBytes) {
            const b = ExpoCrypto.getRandomBytes(16);
            bytes.set(b);
            source = 'expo-crypto';
          }
        } catch (e) {
          diag.expoCryptoError = String(e);
        }
        if (source === 'none' && typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(bytes);
          source = 'global-crypto';
        }
        diag.randomSource = source;
        if (source === 'none') {
          diag.phase = 'no-random-source';
          void writeDeviceIdDebug(diag);
          if (__DEV__) console.error('[SecureStorage] getDeviceId: no random source');
          return null;
        }

        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        diag.generatedId = id;

        try {
          await SecureStore.setItemAsync(KEYS.DEVICE_ID, id, {
            keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
          });
          diag.secureStoreSet = 'ok';
        } catch (e) {
          diag.secureStoreSetError = String(e);
          // Fallback: try again without the accessible attribute. iOS Simulator
          // Keychain sometimes rejects kSecAttrAccessibleAfterFirstUnlock.
          try {
            await SecureStore.setItemAsync(KEYS.DEVICE_ID, id);
            diag.secureStoreSetFallback = 'ok';
          } catch (e2) {
            diag.secureStoreSetFallbackError = String(e2);
            // Even if Keychain failed, return the in-memory id so the current
            // request can proceed. Next app launch will regenerate (not ideal
            // but unblocks iOS builds where Keychain is flaky).
          }
        }
      }
      diag.phase = 'return';
      diag.returning = id ? 'id' : 'null';
      void writeDeviceIdDebug(diag);
      return id;
    } catch (error) {
      diag.phase = 'outer-catch';
      diag.outerError = String(error);
      void writeDeviceIdDebug(diag);
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

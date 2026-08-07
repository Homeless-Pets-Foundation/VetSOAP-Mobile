import * as SecureStore from 'expo-secure-store';
import { getSecureUuid } from './random';
import { StrictReadUnavailableError } from './strictRead';

const KEYS = {
  ACCESS_TOKEN: 'captivet_access_token',
  REFRESH_TOKEN: 'captivet_refresh_token',
  SESSION: 'captivet_session',
  DEVICE_ID: 'captivet_device_id',
  RECOVERY_INTENT: 'captivet_recovery_intent',
} as const;

/**
 * Process-lifetime memo for the device ID. The value is device-scoped and is
 * deliberately NOT removed by `clearAll()`, so it can never go stale within a
 * process — caching it is safe across sign-out and user switches.
 *
 * Without this, every caller paid a fresh AndroidKeyStore round trip:
 * `ApiClient` kept its own private cache but `AuthProvider.registerDevice()`
 * did not, so a cold start read the same key at least twice, and every repeated
 * registration read it again. Only non-null values are cached, so a transient
 * Keystore failure still retries on the next call.
 */
let cachedDeviceId: string | null = null;

/**
 * A generated device ID whose persistence has NOT been confirmed.
 *
 * Kept separate from `cachedDeviceId` on purpose. If the Keystore is
 * transiently down, the read fails AND both write attempts fail, yet the
 * request in flight still needs an `X-Device-Id` (rule 21: omitting it means a
 * 401 `DEVICE_ID_REQUIRED` and a forced sign-out loop). Caching such an ID as if
 * it were persisted would stop this process from ever writing it, so the next
 * launch would mint a SECOND identity and register it — stranding a device
 * session against the organization's device limit. Holding it here instead
 * keeps the ID stable for the whole process while every subsequent
 * `getDeviceId()` retries the read and then the write until one sticks.
 */
let pendingDeviceId: string | null = null;

/**
 * Report a SecureStore failure without creating an import cycle. Loaded
 * lazily so module-load in monitoring.ts staying zero-cost (rule 1). Rate
 * limiting happens inside `captureMessage` so a recurring Keystore fault
 * doesn't flood Sentry. Falls back to a no-op if monitoring isn't wired.
 *
 * Suppressed on iOS Simulator / Android emulator: simulator Keychain lacks
 * the entitlement real-device Keychain has, so `getValueWithKeyAsync` throws
 * every Supabase auto-refresh tick (~30s) → floods Sentry with sim-only
 * noise that drowns real-device signal (RN-A, 483 evt / 2 sim users in 4 h).
 */
function isRealDevice(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Device = require('expo-device') as typeof import('expo-device');
    return Device.isDevice === true;
  } catch {
    // expo-device unavailable — assume real device, don't suppress
    return true;
  }
}

function reportSecureStoreFailure(op: string, error: unknown): void {
  if (!isRealDevice()) return;
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

async function getRawSecureItem(key: string, op: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (error) {
    if (__DEV__) console.error(`[SecureStorage] ${op} failed:`, error);
    reportSecureStoreFailure(op, error);
    return null;
  }
}

async function setRawSecureItem(key: string, value: string, op: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    return true;
  } catch (error) {
    if (__DEV__) console.error(`[SecureStorage] ${op} failed:`, error);
    reportSecureStoreFailure(op, error);
    try {
      await SecureStore.setItemAsync(key, value);
      return true;
    } catch (retryError) {
      if (__DEV__) console.error(`[SecureStorage] ${op} retry failed:`, retryError);
      reportSecureStoreFailure(`${op}RetryFallback`, retryError);
      return false;
    }
  }
}

async function deleteRawSecureItem(key: string, op: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (error) {
    if (__DEV__) console.error(`[SecureStorage] ${op} failed:`, error);
    reportSecureStoreFailure(op, error);
  }
}

export const secureStorage = {
  async getRawItem(key: string, op = 'getRawItem'): Promise<string | null> {
    return getRawSecureItem(key, op);
  },

  /**
   * Like `getRawItem`, but a NATIVE failure rejects with a safe typed sentinel
   * instead of returning `null`. A missing key still resolves to `null` — that
   * is a legitimate absence, and only a strict reader can tell the two apart.
   *
   * This is still the sole SecureStore adapter (rule 3): the Keystore call
   * stays wrapped, the failure is reported through the same rate-limited
   * channel, and no raw native message escapes.
   */
  async getRawItemStrict(key: string, op = 'getRawItemStrict'): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      if (__DEV__) console.error(`[SecureStorage] ${op} failed:`, error);
      reportSecureStoreFailure(op, error);
      throw new StrictReadUnavailableError(`secure_store:${op}`);
    }
  },

  async setRawItem(key: string, value: string, op = 'setRawItem'): Promise<boolean> {
    return setRawSecureItem(key, value, op);
  },

  async deleteRawItem(key: string, op = 'deleteRawItem'): Promise<void> {
    await deleteRawSecureItem(key, op);
  },

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

  /**
   * Get or generate a persistent device ID (survives sign-out, tied to this
   * device).
   *
   * Prefer `getDeviceIdWithProvenance()` anywhere the result is memoized —
   * `persisted: false` means the ID exists only in this process's memory and
   * MUST keep flowing back through here so the write is retried.
   */
  async getDeviceId(): Promise<string | null> {
    return (await this.getDeviceIdWithProvenance()).id;
  },

  /**
   * Like `getDeviceId()`, but reports whether storage is known to hold the ID.
   *
   * Only an ID that was read back out — either read from storage, or written
   * and then verified by reading it back — is promoted to `cachedDeviceId`. An
   * unverified ID stays in `pendingDeviceId` so the call still returns
   * something usable (rule 21) while later calls keep retrying persistence
   * instead of permanently short-circuiting on a value that only ever existed
   * in memory. Callers that keep their OWN cache (`ApiClient.doFetch`) must
   * cache only a persisted ID, otherwise that second cache pins the pending
   * value and the retry never happens.
   */
  async getDeviceIdWithProvenance(): Promise<{ id: string | null; persisted: boolean }> {
    if (cachedDeviceId) return { id: cachedDeviceId, persisted: true };
    try {
      let id: string | null = null;
      try {
        id = await SecureStore.getItemAsync(KEYS.DEVICE_ID);
      } catch (error) {
        if (__DEV__) console.error('[SecureStorage] getDeviceId read failed:', error);
      }

      if (id) {
        // Proven present in storage.
        cachedDeviceId = id;
        pendingDeviceId = null;
        return { id, persisted: true };
      }

      // Reuse the pending ID rather than minting a new one per call — the whole
      // process must present one identity even while the Keystore is failing.
      id = pendingDeviceId;
      if (!id) {
        try {
          id = getSecureUuid();
        } catch (error) {
          if (__DEV__) console.error('[SecureStorage] getDeviceId: no random source', error);
          return { id: null, persisted: false };
        }
      }
      pendingDeviceId = id;

      let persisted = false;
      try {
        await SecureStore.setItemAsync(KEYS.DEVICE_ID, id, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
        persisted = true;
      } catch (error) {
        if (__DEV__) console.error('[SecureStorage] getDeviceId set failed:', error);
        // iOS Simulator Keychain sometimes rejects
        // kSecAttrAccessibleAfterFirstUnlock; retry without it.
        try {
          await SecureStore.setItemAsync(KEYS.DEVICE_ID, id);
          persisted = true;
        } catch (retryError) {
          reportSecureStoreFailure('setDeviceIdRetryFallback', retryError);
        }
      }

      if (persisted) {
        // A resolved write is not proof: SecureStore can fail silently (the same
        // hazard rule 17 covers for the session record). Read back before
        // treating the ID as durable, and keep it pending if the value that
        // comes back is not the one we wrote.
        let readBack: string | null = null;
        try {
          readBack = await SecureStore.getItemAsync(KEYS.DEVICE_ID);
        } catch (error) {
          if (__DEV__) console.error('[SecureStorage] getDeviceId verify failed:', error);
        }
        if (readBack === id) {
          cachedDeviceId = id;
          pendingDeviceId = null;
          return { id, persisted: true };
        }
        if (readBack) {
          // Another writer won, or an older ID was there all along. Storage is
          // the authority — adopt it and drop ours, so this device keeps ONE
          // identity rather than registering a second one.
          cachedDeviceId = readBack;
          pendingDeviceId = null;
          return { id: readBack, persisted: true };
        }
        reportSecureStoreFailure(
          'setDeviceIdUnverified',
          new Error('device id write reported success but read back empty'),
        );
      }

      // Unpersisted: usable now, retried on the next call.
      return { id, persisted: false };
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getDeviceId failed:', error);
      reportSecureStoreFailure('getDeviceId', error);
      return { id: null, persisted: false };
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
    // RECOVERY_INTENT is intentionally NOT deleted here. clearAll() runs on both
    // explicit sign-out and involuntary session-expiry; wiping recovery intent on
    // either path would orphan a user's un-uploaded recording (the "Lela bug").
    // recoveryIntent.clear()/clearForDraftSlot() still clear it at the right
    // moments (post-submit, record.tsx). DEVICE_ID is likewise preserved.
  },

  async getRecoveryIntentRaw(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(KEYS.RECOVERY_INTENT);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] getRecoveryIntentRaw failed:', error);
      reportSecureStoreFailure('getRecoveryIntentRaw', error);
      return null;
    }
  },

  async setRecoveryIntentRaw(value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(KEYS.RECOVERY_INTENT, value, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] setRecoveryIntentRaw failed:', error);
      reportSecureStoreFailure('setRecoveryIntentRaw', error);
    }
  },

  async deleteRecoveryIntent(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(KEYS.RECOVERY_INTENT);
    } catch (error) {
      if (__DEV__) console.error('[SecureStorage] deleteRecoveryIntent failed:', error);
      reportSecureStoreFailure('deleteRecoveryIntent', error);
    }
  },
};

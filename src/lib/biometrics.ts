import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'captivet_biometric_enabled';

// Lazy-loaded analytics emitter — avoids a static import cycle and keeps this
// module safe if analytics hasn't been initialized yet.
type BiometricResult = 'success' | 'cancel' | 'lockout' | 'hw_error' | 'not_enrolled';

function emitBiometricResult(result: BiometricResult): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    trackEvent({ name: 'biometric_result', props: { result } });
  } catch {
    // swallow
  }
}

function emitBiometricPromptShown(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    trackEvent({ name: 'biometric_prompt_shown', props: {} });
  } catch {
    // swallow
  }
}

/**
 * Map an expo-local-authentication result.error string to our enum. The SDK
 * surfaces a small set of error codes — we collapse them into a bounded set
 * so PostHog cardinality stays low and dashboards can alert on `lockout`
 * specifically, which is the one that matters operationally.
 */
function classifyBiometricError(error: string | undefined): BiometricResult {
  if (!error) return 'hw_error';
  if (error === 'user_cancel' || error === 'system_cancel' || error === 'app_cancel') return 'cancel';
  if (error === 'lockout' || error === 'lockout_permanent') return 'lockout';
  if (error === 'not_enrolled') return 'not_enrolled';
  return 'hw_error';
}

export const biometrics = {
  async isAvailable(): Promise<boolean> {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      if (!compatible) return false;
      return await LocalAuthentication.isEnrolledAsync();
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] isAvailable failed:', error);
      return false;
    }
  },

  async getType(): Promise<string> {
    try {
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        return 'Face ID';
      }
      if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        return 'Fingerprint';
      }
      if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
        return 'Iris';
      }
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] getType failed:', error);
    }
    return 'Biometric';
  },

  async isEnabled(): Promise<boolean> {
    try {
      const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      return value === 'true';
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] isEnabled failed:', error);
      return false;
    }
  },

  async setEnabled(enabled: boolean): Promise<boolean> {
    try {
      if (enabled) {
        await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true', {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
      } else {
        await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
      }
      return true;
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] setEnabled failed:', error);
      return false;
    }
  },

  async authenticate(reason = 'Authenticate to access Captivet'): Promise<boolean> {
    emitBiometricPromptShown();
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Use Password',
        disableDeviceFallback: false,
        fallbackLabel: 'Use Passcode',
      });
      if (result.success) {
        emitBiometricResult('success');
      } else {
        emitBiometricResult(classifyBiometricError(result.error));
      }
      return result.success;
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] authenticate failed:', error);
      emitBiometricResult('hw_error');
      return false;
    }
  },

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    } catch (error) {
      if (__DEV__) console.error('[Biometrics] clear failed:', error);
    }
  },
};

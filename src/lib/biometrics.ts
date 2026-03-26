import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const BIOMETRIC_ENABLED_KEY = 'captivet_biometric_enabled';

export const biometrics = {
  async isAvailable(): Promise<boolean> {
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      if (!compatible) return false;
      return await LocalAuthentication.isEnrolledAsync();
    } catch (error) {
      console.error('[Biometrics] isAvailable failed:', error);
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
      console.error('[Biometrics] getType failed:', error);
    }
    return 'Biometric';
  },

  async isEnabled(): Promise<boolean> {
    try {
      const value = await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY);
      return value === 'true';
    } catch (error) {
      console.error('[Biometrics] isEnabled failed:', error);
      return false;
    }
  },

  async setEnabled(enabled: boolean): Promise<void> {
    try {
      if (enabled) {
        await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, 'true', {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
      } else {
        await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
      }
    } catch (error) {
      console.error('[Biometrics] setEnabled failed:', error);
    }
  },

  async authenticate(reason = 'Authenticate to access Captivet'): Promise<boolean> {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: 'Use Password',
        disableDeviceFallback: false,
        fallbackLabel: 'Use Passcode',
      });
      return result.success;
    } catch (error) {
      console.error('[Biometrics] authenticate failed:', error);
      return false;
    }
  },

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(BIOMETRIC_ENABLED_KEY);
    } catch (error) {
      console.error('[Biometrics] clear failed:', error);
    }
  },
};

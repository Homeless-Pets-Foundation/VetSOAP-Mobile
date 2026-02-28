import * as SecureStore from 'expo-secure-store';

const KEYS = {
  ACCESS_TOKEN: 'vetsoap:access_token',
  REFRESH_TOKEN: 'vetsoap:refresh_token',
  SESSION: 'vetsoap:session',
} as const;

export const secureStorage = {
  async getToken(): Promise<string | null> {
    return SecureStore.getItemAsync(KEYS.ACCESS_TOKEN);
  },

  async setToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, token);
  },

  async getRefreshToken(): Promise<string | null> {
    return SecureStore.getItemAsync(KEYS.REFRESH_TOKEN);
  },

  async setRefreshToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, token);
  },

  async getSession(): Promise<string | null> {
    return SecureStore.getItemAsync(KEYS.SESSION);
  },

  async setSession(session: string): Promise<void> {
    await SecureStore.setItemAsync(KEYS.SESSION, session);
  },

  async clearAll(): Promise<void> {
    await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN);
    await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN);
    await SecureStore.deleteItemAsync(KEYS.SESSION);
  },
};

import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_PREFERENCE_KEY = 'captivet.themePreference.v1';
const THEME_PREFERENCES = new Set<ThemePreference>(['system', 'light', 'dark']);

export function normalizeThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.has(value as ThemePreference) ? (value as ThemePreference) : 'system';
}

export async function getThemePreference(): Promise<ThemePreference> {
  try {
    return normalizeThemePreference(await AsyncStorage.getItem(THEME_PREFERENCE_KEY));
  } catch {
    return 'system';
  }
}

export async function setThemePreference(value: ThemePreference): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_PREFERENCE_KEY, normalizeThemePreference(value));
  } catch {
    // Device-scoped preference only; failing closed to current in-memory theme is fine.
  }
}

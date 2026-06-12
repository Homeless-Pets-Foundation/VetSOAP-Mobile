import { useCallback, useEffect, useState } from 'react';
import { useColorScheme } from 'nativewind';
import {
  getThemePreference,
  setThemePreference as persistThemePreference,
  type ThemePreference,
} from '../lib/themePreference';

export function useThemePreference() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [isLoaded, setIsLoaded] = useState(false);

  const applyPreference = useCallback(
    (value: ThemePreference) => {
      try {
        setColorScheme(value);
      } catch (error) {
        if (__DEV__) console.error('[Theme] Failed to apply theme preference:', error);
      }
    },
    [setColorScheme]
  );

  useEffect(() => {
    let cancelled = false;
    getThemePreference()
      .then((value) => {
        if (cancelled) return;
        setPreferenceState(value);
        applyPreference(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applyPreference]);

  const setPreference = useCallback(
    (value: ThemePreference) => {
      setPreferenceState(value);
      applyPreference(value);
      persistThemePreference(value).catch(() => {});
    },
    [applyPreference]
  );

  return {
    preference,
    setPreference,
    isLoaded,
    colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
  } as const;
}

import { useColorScheme } from 'nativewind';
import { DARK_THEME_COLORS, LIGHT_THEME_COLORS } from '../constants/colors';

export function useThemeColors() {
  const { colorScheme } = useColorScheme();
  return colorScheme === 'dark' ? DARK_THEME_COLORS : LIGHT_THEME_COLORS;
}

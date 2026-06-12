/**
 * Color constants for places that can't take a Tailwind class — primarily
 * lucide icon `color` props and inline styles. Values mirror
 * tailwind.config.js exactly; if a value changes there it must change here.
 *
 * Dark-mode groundwork: new code imports from here instead of inlining hex
 * literals. Later sweeps replace direct imports with `useThemeColors()`;
 * keeping every icon hex routed through this module makes that mechanical.
 */
export const LIGHT_THEME_COLORS = {
  white: '#ffffff',

  brand500: '#0d8775',
  brand600: '#0a7465',

  surface: '#fafaf9',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#f5f5f4',
  contentPrimary: '#1c1917',
  contentBody: '#44403c',
  contentSecondary: '#57534e',
  contentTertiary: '#a8a29e',
  contentInverse: '#ffffff',
  contentOnBrand: '#ffffff',
  borderDefault: '#e7e5e4',
  borderStrong: '#d6d3d1',

  statusInfoBg: '#dbeafe',
  statusInfoBorder: '#bfdbfe',
  statusInfoFg: '#1d4ed8',
  statusWarningBg: '#fef3c7',
  statusWarningBorder: '#fde68a',
  statusWarningFg: '#b45309',
  statusDangerBg: '#fee2e2',
  statusDangerBorder: '#fecaca',
  statusDangerFg: '#b91c1c',
  statusSuccessBg: '#dcfce7',
  statusSuccessBorder: '#bbf7d0',
  statusSuccessFg: '#15803d',

  scrim: 'rgba(0, 0, 0, 0.4)',
  toastBg: '#292524',
  toastFg: '#ffffff',

  stone300: '#d6d3d1',
  stone400: '#a8a29e',
  stone500: '#78716c',
  stone600: '#57534e',
  stone700: '#44403c',
  stone900: '#1c1917',

  success600: '#16a34a',
  warning500: '#f59e0b',
  warning600: '#d97706',
  warning700: '#b45309',
  danger500: '#ef4444',
  danger600: '#dc2626',
  danger700: '#b91c1c',
  info600: '#2563eb',

  soapSubjective: '#0d8775',
  soapObjective: '#2563eb',
  soapAssessment: '#d97706',
  soapPlan: '#7c3aed',
} as const;

export const DARK_THEME_COLORS: Record<keyof typeof LIGHT_THEME_COLORS, string> = {
  white: '#ffffff',

  brand500: '#2dd4bf',
  brand600: '#14b8a6',

  surface: '#161412',
  surfaceRaised: '#1f1d19',
  surfaceSunken: '#292520',
  contentPrimary: '#fafaf9',
  contentBody: '#e7e5e4',
  contentSecondary: '#d6d3d1',
  contentTertiary: '#a8a29e',
  contentInverse: '#1c1917',
  contentOnBrand: '#1c1917',
  borderDefault: '#44403c',
  borderStrong: '#57534e',

  statusInfoBg: '#1e3a8a',
  statusInfoBorder: '#2563eb',
  statusInfoFg: '#bfdbfe',
  statusWarningBg: '#78350f',
  statusWarningBorder: '#d97706',
  statusWarningFg: '#fde68a',
  statusDangerBg: '#7f1d1d',
  statusDangerBorder: '#dc2626',
  statusDangerFg: '#fecaca',
  statusSuccessBg: '#14532d',
  statusSuccessBorder: '#16a34a',
  statusSuccessFg: '#bbf7d0',

  scrim: 'rgba(0, 0, 0, 0.6)',
  toastBg: '#e7e5e4',
  toastFg: '#1c1917',

  stone300: '#57534e',
  stone400: '#a8a29e',
  stone500: '#d6d3d1',
  stone600: '#e7e5e4',
  stone700: '#f5f5f4',
  stone900: '#fafaf9',

  success600: '#22c55e',
  warning500: '#fbbf24',
  warning600: '#f59e0b',
  warning700: '#fcd34d',
  danger500: '#f87171',
  danger600: '#ef4444',
  danger700: '#fecaca',
  info600: '#60a5fa',

  soapSubjective: '#2dd4bf',
  soapObjective: '#60a5fa',
  soapAssessment: '#fbbf24',
  soapPlan: '#a78bfa',
};

/**
 * @deprecated Use `useThemeColors()` inside components so colors follow the
 * active NativeWind color scheme. Kept until legacy consumers migrate.
 */
export const COLORS = LIGHT_THEME_COLORS;

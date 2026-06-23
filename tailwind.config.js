/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // Required for NativeWind v4 setColorScheme(); later sweeps migrate screens onto these tokens.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic tokens (dark-mode groundwork). Backed by CSS vars in global.css
        // that resolve to today's stone palette in light mode. New code uses
        // these; old screens keep literal stone-* classes until they're swept.
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-raised': 'rgb(var(--color-surface-raised) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--color-surface-sunken) / <alpha-value>)',
        'content-primary': 'rgb(var(--color-content-primary) / <alpha-value>)',
        'content-body': 'rgb(var(--color-content-body) / <alpha-value>)',
        'content-secondary': 'rgb(var(--color-content-secondary) / <alpha-value>)',
        'content-tertiary': 'rgb(var(--color-content-tertiary) / <alpha-value>)',
        'content-inverse': 'rgb(var(--color-content-inverse) / <alpha-value>)',
        'content-on-brand': 'rgb(var(--content-on-brand) / <alpha-value>)',
        'border-default': 'rgb(var(--color-border-default) / <alpha-value>)',
        'border-strong': 'rgb(var(--color-border-strong) / <alpha-value>)',
        scrim: 'rgb(var(--scrim))',
        toast: {
          bg: 'rgb(var(--toast-bg) / <alpha-value>)',
          fg: 'rgb(var(--toast-fg) / <alpha-value>)',
        },
        status: {
          info: {
            bg: 'rgb(var(--status-info-bg) / <alpha-value>)',
            border: 'rgb(var(--status-info-border) / <alpha-value>)',
            fg: 'rgb(var(--status-info-fg) / <alpha-value>)',
          },
          warning: {
            bg: 'rgb(var(--status-warning-bg) / <alpha-value>)',
            border: 'rgb(var(--status-warning-border) / <alpha-value>)',
            fg: 'rgb(var(--status-warning-fg) / <alpha-value>)',
          },
          danger: {
            bg: 'rgb(var(--status-danger-bg) / <alpha-value>)',
            border: 'rgb(var(--status-danger-border) / <alpha-value>)',
            fg: 'rgb(var(--status-danger-fg) / <alpha-value>)',
          },
          success: {
            bg: 'rgb(var(--status-success-bg) / <alpha-value>)',
            border: 'rgb(var(--status-success-border) / <alpha-value>)',
            fg: 'rgb(var(--status-success-fg) / <alpha-value>)',
          },
        },
        brand: {
          50: '#eefbf7',
          100: '#d5f5ec',
          200: '#aeead9',
          300: '#79d9c2',
          400: '#44c1a5',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: '#095e53',
          800: '#084b43',
          900: '#063e38',
          teal: '#0d8775',
          'teal-light': '#0bb89a',
          amber: '#f59e0b',
        },
        stone: {
          50: '#fafaf9',
          100: '#f5f5f4',
          200: '#e7e5e4',
          300: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          600: '#57534e',
          700: '#44403c',
          800: '#292524',
          900: '#1c1917',
        },
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        info: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        soap: {
          subjective: 'rgb(var(--soap-subjective) / <alpha-value>)',
          objective: 'rgb(var(--soap-objective) / <alpha-value>)',
          assessment: 'rgb(var(--soap-assessment) / <alpha-value>)',
          plan: 'rgb(var(--soap-plan) / <alpha-value>)',
        },
      },
      fontFamily: {
        // Variable Inter, embedded at build time (app.config.ts expo-font plugin).
        // Weights come from font-medium/font-semibold/font-bold via fontWeight.
        // system-ui fallback keeps an old dev-client (pre-embed) rendering.
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        caption: ['12px', { lineHeight: '16px' }],
        'body-sm': ['13px', { lineHeight: '18px' }],
        body: ['15px', { lineHeight: '22px' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
        heading: ['18px', { lineHeight: '26px' }],
        title: ['20px', { lineHeight: '28px' }],
        display: ['24px', { lineHeight: '32px' }],
        timer: ['48px', { lineHeight: '56px' }],
      },
      borderRadius: {
        card: '14px',
        btn: '12px',
        input: '10px',
        pill: '9999px',
        badge: '12px',
      },
      screens: {
        'tablet': '600px',
        'tablet-lg': '800px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08)',
        'card-md': '0 4px 12px rgba(0,0,0,0.10)',
        btn: '0 1px 2px rgba(0,0,0,0.05)',
        // Brand-teal glow — powers the hero waveform / active slot / CTA.
        // boxShadow style supported on both platforms in RN 0.83.
        glow: '0 0 16px rgba(13,135,117,0.35)',
      },
    },
  },
  plugins: [],
};

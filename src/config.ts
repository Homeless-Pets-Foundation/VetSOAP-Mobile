const configErrors: string[] = [];

// IMPORTANT: Expo/Metro only inlines EXPO_PUBLIC_* env vars when accessed
// via static dot notation (e.g. process.env.EXPO_PUBLIC_API_URL).
// Dynamic access like process.env[key] is NOT replaced at build time.
// That's why each variable must be read with a literal property access below.

function requireHttps(name: string, value: string | undefined): string {
  if (!value) {
    configErrors.push(`Missing required environment variable: ${name}`);
    return '';
  }
  if (!value.startsWith('https://')) {
    configErrors.push(`${name} must use HTTPS in production`);
    return '';
  }
  return value;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value) {
    configErrors.push(`Missing required environment variable: ${name}`);
    return '';
  }
  return value;
}

export const API_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000')
  : requireHttps('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL);

export const SUPABASE_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_SUPABASE_URL || '')
  : requireHttps('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL);

export const SUPABASE_ANON_KEY = __DEV__
  ? (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '')
  : requireValue('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);

// In dev, warn loudly when Supabase config is missing — the app will render but
// auth will silently fail because supabase.ts falls back to a placeholder client.
if (__DEV__ && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.warn(
    '[Config] EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is empty. ' +
    'Auth will not work. Check .env and restart Metro with --clear.'
  );
}

// Specific R2 bucket hostname for upload URL validation (e.g. "<account-id>.r2.cloudflarestorage.com")
// Soft default — missing hostname weakens upload URL validation but doesn't brick the app.
export const R2_BUCKET_HOSTNAME = process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME || '';

if (!R2_BUCKET_HOSTNAME) {
  console.warn(
    '[Config] EXPO_PUBLIC_R2_BUCKET_HOSTNAME is not set. ' +
    'Upload URL validation will be weaker (HTTPS + signature only).'
  );
}

export const CONFIG_MISSING = configErrors.length > 0;

if (CONFIG_MISSING) {
  if (__DEV__) console.error('[Config] Missing or invalid environment variables:', configErrors);
}

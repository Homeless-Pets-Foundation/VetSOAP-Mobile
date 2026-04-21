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
// Required in production — missing hostname causes fail-closed upload validation (all uploads rejected).
// In dev, missing hostname weakens validation to HTTPS + signature only.
export const R2_BUCKET_HOSTNAME = __DEV__
  ? (process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME || '')
  : requireValue('EXPO_PUBLIC_R2_BUCKET_HOSTNAME', process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME);

if (__DEV__ && !R2_BUCKET_HOSTNAME) {
  console.warn(
    '[Config] EXPO_PUBLIC_R2_BUCKET_HOSTNAME is not set. ' +
    'Upload URL validation will be weaker in dev (HTTPS + signature only). ' +
    'This will block all uploads in a production build.'
  );
}

// Google OAuth client IDs for native Sign-In.
// Optional — missing values disable Google sign-in gracefully (the button
// renders an error instead of crashing). Apple has no client-side config;
// the iOS bundle identifier IS the Apple audience.
// - WEB_CLIENT_ID: Web-application OAuth client registered in Google Cloud
//   and paired with the Supabase Google provider. All ID tokens must be
//   signed for this audience, regardless of platform, or Supabase rejects them.
// - IOS_CLIENT_ID: iOS OAuth client registered in Google Cloud with
//   bundleId = com.captivet.mobile. Only used on iOS by GoogleSignin.configure().
export const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '';
export const GOOGLE_IOS_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';

if (__DEV__ && !GOOGLE_WEB_CLIENT_ID) {
  console.warn(
    '[Config] EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is not set. ' +
    'Google Sign-In button will show an error until it is configured.'
  );
}

if (__DEV__ && !GOOGLE_IOS_CLIENT_ID) {
  console.warn(
    '[Config] EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is not set. ' +
    'Google Sign-In will remain disabled on iOS builds until it is configured.'
  );
}

// Server-draft creation debounce window (ms). When > 0, autoSaveDraft delays
// the POST /api/recordings {isDraft:true} call by this many ms, giving the
// user a chance to tap Submit before a draft row is ever written. Submit /
// upload-completion / stash all interrupt the timer so no orphan row leaks.
// 0 or unset = legacy immediate-create behavior (can race with Submit and
// produce orphan draft rows that show up alongside completed recordings).
// Recommended: 800ms.
export const DRAFT_DEBOUNCE_MS = (() => {
  const raw = process.env.EXPO_PUBLIC_DRAFT_DEBOUNCE_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 0;
})();

// Monitoring — all optional. Missing keys silently disable the corresponding
// SDK (graceful no-op). We never throw from monitoring init (CLAUDE.md rule 1).
export const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';
export const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY || '';
export const POSTHOG_HOST =
  process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';

export const CONFIG_MISSING = configErrors.length > 0;

if (CONFIG_MISSING) {
  if (__DEV__) console.error('[Config] Missing or invalid environment variables:', configErrors);
}

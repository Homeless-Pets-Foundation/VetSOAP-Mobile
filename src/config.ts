function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requireUrl(key: string): string {
  const value = requireEnv(key);
  if (!value.startsWith('https://')) {
    throw new Error(`${key} must use HTTPS in production`);
  }
  return value;
}

export const API_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000')
  : requireUrl('EXPO_PUBLIC_API_URL');

export const SUPABASE_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_SUPABASE_URL || '')
  : requireUrl('EXPO_PUBLIC_SUPABASE_URL');

export const SUPABASE_ANON_KEY = __DEV__
  ? (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '')
  : requireEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');

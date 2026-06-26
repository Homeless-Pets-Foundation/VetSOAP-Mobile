import { Platform } from 'react-native';
import { supabase } from './supabase';
import { GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from '../config';
import { captureMessage, measurePhase } from '../lib/monitoring';

// Lazy-load social auth native modules to avoid crashing on dev client APKs
// built before these dependencies were added. Each module is only required
// the first time the corresponding sign-in path is actually invoked.
function getGoogleSignin() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-google-signin/google-signin') as typeof import('@react-native-google-signin/google-signin');
}
function getAppleAuthentication() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-apple-authentication') as typeof import('expo-apple-authentication');
}
function getCrypto() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-crypto') as typeof import('expo-crypto');
}

export type AuthResult = {
  error: string | null;
  cancelled?: boolean;
};

let googleConfigured = false;
let pendingAppleProfileSync: Promise<void> | null = null;
let resolvePendingAppleProfileSync: (() => void) | null = null;

type GoogleAuthStage =
  | 'not_configured'
  | 'configure'
  | 'native_sign_in'
  | 'missing_id_token'
  | 'supabase_exchange';

type JwtPayload = {
  aud?: unknown;
  azp?: unknown;
  iss?: unknown;
  exp?: unknown;
};

function errorCodeOf(error: unknown): string {
  const maybeError = error as { code?: unknown; name?: unknown; status?: unknown };
  if (typeof maybeError.code === 'string' && maybeError.code.length > 0) return maybeError.code;
  if (typeof maybeError.status === 'number') return `status_${maybeError.status}`;
  if (typeof maybeError.name === 'string' && maybeError.name.length > 0) return maybeError.name;
  return 'unknown';
}

function errorStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : null;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as JwtPayload;
  } catch {
    return null;
  }
}

function classifyGoogleClientId(value: unknown): 'web' | 'ios' | 'other_google' | 'missing' | 'unknown' {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  if (value === GOOGLE_WEB_CLIENT_ID) return 'web';
  if (value === GOOGLE_IOS_CLIENT_ID) return 'ios';
  if (value.endsWith('.apps.googleusercontent.com')) return 'other_google';
  return 'unknown';
}

function expState(exp: unknown): 'future' | 'expired' | 'invalid' | 'missing' {
  if (exp === undefined || exp === null) return 'missing';
  if (typeof exp !== 'number') return 'invalid';
  return exp * 1000 > Date.now() ? 'future' : 'expired';
}

function reportGoogleAuthFailure(
  stage: GoogleAuthStage,
  error?: unknown,
  extra?: Record<string, unknown>
): void {
  captureMessage('google_sign_in_failed', 'warning', {
    tags: {
      phase: 'auth_sign_in',
      auth_provider: 'google',
      google_auth_stage: stage,
      platform: Platform.OS,
      error_code: errorCodeOf(error),
    },
    extra: {
      error_status: errorStatusOf(error),
      google_web_client_configured: GOOGLE_WEB_CLIENT_ID.length > 0,
      google_ios_client_configured: GOOGLE_IOS_CLIENT_ID.length > 0,
      ...extra,
    },
  });
}

function googleTokenDiagnostics(idToken: string): Record<string, unknown> {
  const payload = decodeJwtPayload(idToken);
  return {
    id_token_present: true,
    id_token_payload_decoded: Boolean(payload),
    id_token_aud: classifyGoogleClientId(payload?.aud),
    id_token_azp: classifyGoogleClientId(payload?.azp),
    id_token_issuer:
      payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com'
        ? 'accounts_google'
        : typeof payload?.iss === 'string'
          ? 'other'
          : 'missing',
    id_token_exp: expState(payload?.exp),
  };
}

function isGoogleSignInConfiguredForCurrentPlatform(): boolean {
  if (!GOOGLE_WEB_CLIENT_ID) return false;
  if (Platform.OS === 'ios' && !GOOGLE_IOS_CLIENT_ID) return false;
  return true;
}

async function persistAppleProfileMetadata(
  credential: { email?: string | null; fullName?: { givenName?: string | null; familyName?: string | null } | null }
): Promise<void> {
  const metadata: Record<string, string> = {};

  if (credential.email) {
    metadata.email = credential.email;
  }

  if (credential.fullName) {
    const AppleAuthentication = getAppleAuthentication();
    const formattedName = AppleAuthentication.formatFullName(credential.fullName as Parameters<typeof AppleAuthentication.formatFullName>[0]).trim();
    if (formattedName) {
      metadata.fullName = formattedName;
    }
    if (credential.fullName.givenName) {
      metadata.given_name = credential.fullName.givenName;
    }
    if (credential.fullName.familyName) {
      metadata.family_name = credential.fullName.familyName;
    }
  }

  if (Object.keys(metadata).length === 0) return;

  const { error } = await supabase.auth.updateUser({ data: metadata });
  if (error) {
    if (__DEV__) console.error('[socialAuth] Failed to persist Apple profile metadata:', error);
  }
}

/**
 * Configure the native Google Sign-In SDK. Safe to call multiple times.
 * Called lazily from the Google sign-in flow so optional native modules stay
 * off the cold-start path. Does not throw.
 */
export function configureGoogleSignIn(): void {
  if (googleConfigured) return;
  if (!isGoogleSignInConfiguredForCurrentPlatform()) {
    if (__DEV__) {
      const missing = Platform.OS === 'ios' && !GOOGLE_IOS_CLIENT_ID
        ? 'GOOGLE_IOS_CLIENT_ID'
        : 'GOOGLE_WEB_CLIENT_ID';
      console.warn(`[socialAuth] ${missing} is empty; Google Sign-In will fail until it is set.`);
    }
    return;
  }

  try {
    measurePhase('google_sign_in_configure', { platform: Platform.OS }, () => {
      const { GoogleSignin } = getGoogleSignin();
      GoogleSignin.configure({
        webClientId: GOOGLE_WEB_CLIENT_ID,
        iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
        scopes: ['profile', 'email'],
        offlineAccess: false,
      });
    });
    googleConfigured = true;
  } catch (error) {
    reportGoogleAuthFailure('configure', error);
    if (__DEV__) console.error('[socialAuth] GoogleSignin.configure failed:', error);
  }
}

/**
 * Native Google Sign-In -> Supabase session.
 * Returns { error: null } on success. Cancellation is marked with cancelled=true.
 * All failures are caught - this function never throws.
 */
export async function signInWithGoogleNative(): Promise<AuthResult> {
  if (!isGoogleSignInConfiguredForCurrentPlatform()) {
    reportGoogleAuthFailure('not_configured', undefined, {
      required_ios_client: Platform.OS === 'ios',
    });
    return {
      error:
        Platform.OS === 'ios'
          ? 'Google Sign-In is not configured on this iOS build.'
          : 'Google Sign-In is not configured on this build.',
    };
  }

  try {
    if (!googleConfigured) configureGoogleSignIn();
    const { GoogleSignin } = getGoogleSignin();

    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }

    const response = await GoogleSignin.signIn();
    if (response.type === 'cancelled') {
      return { error: null, cancelled: true };
    }

    const idToken = response.data.idToken;
    if (!idToken) {
      reportGoogleAuthFailure('missing_id_token', undefined, {
        id_token_present: false,
        response_type: response.type,
      });
      return { error: 'Google did not return an identity token. Please try again.' };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });
    if (error) {
      reportGoogleAuthFailure('supabase_exchange', error, googleTokenDiagnostics(idToken));
      if (__DEV__) console.error('[socialAuth] Supabase Google sign-in failed:', error);
      return { error: 'Could not sign you in with Google. Please try again.' };
    }
    return { error: null };
  } catch (error) {
    const { statusCodes } = getGoogleSignin();
    const code = (error as { code?: string })?.code;
    if (code === statusCodes.SIGN_IN_CANCELLED) {
      return { error: null, cancelled: true };
    }
    if (code === statusCodes.IN_PROGRESS) {
      return { error: 'Sign-in is already in progress.' };
    }
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      return { error: 'Google Play Services is not available on this device.' };
    }
    reportGoogleAuthFailure('native_sign_in', error);
    if (__DEV__) console.error('[socialAuth] Google sign-in threw:', error);
    return { error: 'Google Sign-In failed. Please try again.' };
  }
}

/**
 * Convert random bytes into a hex string nonce. Apple sees the SHA-256 hash,
 * while Supabase needs the raw nonce for validation.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Native Apple Sign-In -> Supabase session.
 * iOS only; on other platforms returns an unavailable error.
 */
export async function signInWithAppleNative(): Promise<AuthResult> {
  if (Platform.OS !== 'ios') {
    return { error: 'Apple Sign-In is only available on iOS.' };
  }

  try {
    const AppleAuthentication = getAppleAuthentication();
    const Crypto = getCrypto();

    const available = await AppleAuthentication.isAvailableAsync();
    if (!available) {
      return { error: 'Apple Sign-In is not available on this device.' };
    }

    const rawNonce = bytesToHex(Crypto.getRandomBytes(32));
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      return { error: 'Apple did not return an identity token. Please try again.' };
    }

    pendingAppleProfileSync = new Promise<void>((resolve) => {
      resolvePendingAppleProfileSync = resolve;
    });

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) {
      resolvePendingAppleProfileSync?.();
      resolvePendingAppleProfileSync = null;
      pendingAppleProfileSync = null;
      if (__DEV__) console.error('[socialAuth] Supabase Apple sign-in failed:', error);
      return { error: 'Could not sign you in with Apple. Please try again.' };
    }

    try {
      await persistAppleProfileMetadata(credential);
    } finally {
      resolvePendingAppleProfileSync?.();
      resolvePendingAppleProfileSync = null;
    }

    await pendingAppleProfileSync;
    pendingAppleProfileSync = null;
    return { error: null };
  } catch (error) {
    resolvePendingAppleProfileSync?.();
    resolvePendingAppleProfileSync = null;
    pendingAppleProfileSync = null;
    const code = (error as { code?: string })?.code;
    if (code === 'ERR_REQUEST_CANCELED') {
      return { error: null, cancelled: true };
    }
    if (__DEV__) console.error('[socialAuth] Apple sign-in threw:', error);
    return { error: 'Apple Sign-In failed. Please try again.' };
  }
}

export async function signOutNativeGoogle(): Promise<void> {
  try {
    const { GoogleSignin } = getGoogleSignin();
    if (!GoogleSignin.hasPreviousSignIn()) return;
    await GoogleSignin.signOut();
  } catch (error) {
    if (__DEV__) console.error('[socialAuth] Native Google sign-out failed:', error);
  }
}

export async function waitForPendingAppleProfileSync(): Promise<void> {
  if (!pendingAppleProfileSync) return;
  try {
    await pendingAppleProfileSync;
  } finally {
    pendingAppleProfileSync = null;
  }
}

/**
 * Google sign-in failure classification.
 *
 * Two hazards live in this catch block and neither had a test.
 *
 * 1. `getGoogleSignin()` is the lazy require (rule 19) and was called AGAIN
 *    inside the catch. If the original throw WAS that require failing — an old
 *    dev-client APK built before the dependency existed, the exact case the lazy
 *    require exists for — the second call rethrew the same module error out of a
 *    function documented as never throwing.
 * 2. The branches compared `error.code` against `statusCodes.X` bare. With the
 *    table unavailable (or a member missing) that is `undefined === undefined`
 *    for any error carrying no code, which would report a hard native failure as
 *    a user cancellation and swallow it silently.
 *
 * Context: Sentry REACT-NATIVE-1P arrived with iOS `error_code: '-1'`
 * (kGIDSignInErrorCodeUnknown). It is NOT a cancellation — the one `-1` that is
 * one (`access_denied`) is rewritten to the cancel code natively before it ever
 * reaches JS — so it must land on the reported branch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTsModule } from './helpers/loadTs.mjs';

process.env.EXPO_PUBLIC_API_URL = 'https://api.captivet.com';
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://shdzitupjltfyembqowp.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web.apps.googleusercontent.com';
process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = 'ios.apps.googleusercontent.com';

const noop = new Proxy({}, { get: () => () => {} });

/** @param google `null` makes the lazy require throw, as an old dev client does. */
async function loadSocialAuth(google, signInImpl) {
  const captured = [];
  const mod = await loadTsModule('src/auth/socialAuth.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    '@sentry/react-native': noop,
    'posthog-react-native': noop,
    'expo-constants': { default: { expoConfig: {} } },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} },
    '@supabase/supabase-js': {
      createClient: () => ({ auth: { signInWithIdToken: async () => ({ error: null }) } }),
    },
    '@react-native-google-signin/google-signin': new Proxy({}, {
      get(_t, prop) {
        if (google === null) throw new Error('Native module RNGoogleSignin does not exist');
        if (prop === 'GoogleSignin') return { signIn: signInImpl, hasPlayServices: async () => true, configure() {} };
        if (prop === 'statusCodes') return google;
        return undefined;
      },
    }),
  }, { captureMessage: (...a) => captured.push(a) });
  return { signInWithGoogleNative: mod.signInWithGoogleNative, captured };
}

const IOS_STATUS_CODES = {
  SIGN_IN_CANCELLED: '-5',
  IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  SIGN_IN_REQUIRED: '-4',
};

test('an iOS -1 (unknown) is a reported failure, never a silent cancellation', async () => {
  const { signInWithGoogleNative } = await loadSocialAuth(IOS_STATUS_CODES, async () => {
    throw Object.assign(new Error('RNGoogleSignIn: Unknown error in google sign in.'), { code: '-1' });
  });
  const result = await signInWithGoogleNative();
  assert.equal(result.cancelled, undefined, '-1 must not be treated as a cancel');
  assert.equal(result.error, 'Google Sign-In failed. Please try again.');
});

test('a genuine iOS cancel code is still recognised', async () => {
  const { signInWithGoogleNative } = await loadSocialAuth(IOS_STATUS_CODES, async () => {
    throw Object.assign(new Error('The user canceled the sign in request.'), { code: '-5' });
  });
  const result = await signInWithGoogleNative();
  assert.equal(result.cancelled, true);
  assert.equal(result.error, null);
});

test('a missing native module returns an error instead of throwing out of the catch', async () => {
  const { signInWithGoogleNative } = await loadSocialAuth(null, async () => {});
  const result = await signInWithGoogleNative();
  assert.equal(result.error, 'Google Sign-In failed. Please try again.', 'must degrade, not throw');
  assert.equal(result.cancelled, undefined);
});

test('an error with no code is not matched against an unavailable code table', async () => {
  // The undefined === undefined hazard: with the table gone AND the error
  // carrying no code, a bare compare would report this as a cancellation.
  const { signInWithGoogleNative } = await loadSocialAuth(null, async () => {
    throw new Error('something native went wrong');
  });
  const result = await signInWithGoogleNative();
  assert.equal(result.cancelled, undefined);
  assert.equal(result.error, 'Google Sign-In failed. Please try again.');
});

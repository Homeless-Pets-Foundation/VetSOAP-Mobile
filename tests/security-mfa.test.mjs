import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadTsModule(path) {
  let source;
  try {
    source = await read(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assert.fail(`${path} should exist and export executable helpers`);
    }
    throw error;
  }

  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireForVm,
  });
  return module.exports;
}

test('mobile API client exposes global MFA_REQUIRED handling', async () => {
  const client = await read('src/api/client.ts');

  assert.match(client, /setOnMfaRequired\(/);
  assert.match(client, /code === 'MFA_REQUIRED'/);
  assert.match(client, /onMfaRequired\?\.\(/);
});

test('mobile auth provider supports bearer MFA routes and token rotation', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(provider, /mfaRequired/);
  assert.match(provider, /listMfaFactors/);
  assert.match(provider, /enrollMfaFactor/);
  assert.match(provider, /startMfaChallenge/);
  assert.match(provider, /verifyMfaChallenge/);
  assert.match(provider, /X-Supabase-Refresh-Token/);
  assert.match(provider, /supabase\.auth\.setSession/);
});

test('mobile MFA bearer routes preserve device binding and null-json guards', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(provider, /secureStorage\.getDeviceId\(\)/);
  assert.match(provider, /X-Device-Id/);
  assert.match(provider, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)\) \?\? \{\}/);
  assert.match(provider, /validateRequestUrl\(mfaUrl\)/);
  assert.match(provider, /AbortController/);
  assert.match(provider, /clearTimeout\(timeout\)/);
  assert.doesNotMatch(provider, /data\.error \|\| `Request failed with status/);
});

test('mobile exposes MFA auth route and protects app layout from half-auth timeout', async () => {
  const authLayout = await read('app/(auth)/_layout.tsx');
  const appLayout = await read('app/(app)/_layout.tsx');
  const mfaScreen = await read('app/(auth)/mfa.tsx');

  assert.match(authLayout, /<Stack\.Screen name="mfa"/);
  assert.match(appLayout, /mfaRequired/);
  assert.match(mfaScreen, /Verify your identity/);
  assert.match(mfaScreen, /autoBootstrapKeyRef/);
  assert.match(mfaScreen, /const bootstrapKey = `\$\{isAuthenticated \? '1' : '0'\}:\$\{mfaRequired \? '1' : '0'\}:\$\{mfaReason \?\? ''\}`/);
  assert.match(mfaScreen, /if \(autoBootstrapKeyRef\.current === bootstrapKey\) return;/);
  assert.match(mfaScreen, /const profileLoaded = await retryFetchUser\(\);[\s\S]*if \(profileLoaded\) \{[\s\S]*returnToApp\(\);/);
  assert.match(appLayout, /HALF_AUTH_TIMEOUT_MS = 30_000/);
  assert.match(appLayout, /halfAuthTimedOut/);
  assert.match(appLayout, /half_auth_timeout/);
  assert.match(appLayout, /\}, \[halfAuthTimedOut, isHalfAuth\]\)/);
  assert.match(appLayout, /Sign Out Without Profile/);
  assert.match(appLayout, /signOut\(\{ recoveryMode: 'best_effort' \}\)/);
  assert.doesNotMatch(appLayout, /forcing signOut/);
});

test('mobile auth provider does not mark MFA_REQUIRED as a loaded user profile', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(provider, /type FetchUserAttemptResult = 'loaded' \| 'deferred'/);
  assert.match(provider, /retryFetchUser: \(\) => Promise<boolean>/);
  assert.match(
    provider,
    /error instanceof ApiError && error\.code === 'MFA_REQUIRED'[\s\S]*return 'deferred';/
  );
  assert.match(provider, /if \(result === 'loaded'\) \{[\s\S]*setUserFetchState\('success'\)/);
  assert.match(provider, /return true;/);
  assert.match(provider, /setUserFetchState\('idle'\);\s*return false;/);
});

test('mobile auth provider applies profile when device registration needs recovery UI', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  const mfaScreen = await read('app/(auth)/mfa.tsx');
  const deviceCapacity = await read('src/hooks/useDeviceCapacity.ts');

  assert.match(
    provider,
    /await registerDevice\(\);\s*applyFetchedUser\(body\.user \?\? null\);\s*return 'loaded';/
  );
  assert.match(
    provider,
    /await registerDevice\(\);\s*applyFetchedUser\(data\.user\);\s*setUserFetchState\('success'\);/
  );
  assert.doesNotMatch(provider, /if \(!\(await registerDevice\(\)\)\) return 'deferred';/);
  assert.doesNotMatch(provider, /if \(!\(await registerDevice\(\)\)\) return;/);
  assert.match(provider, /if \(required \|\| user\) \{[\s\S]*setMfaRequired\(required\);/);
  assert.match(mfaScreen, /if \(!stillRequired\) \{[\s\S]*const profileLoaded = await retryFetchUser\(\);/);
  assert.match(deviceCapacity, /deviceRegistrationBlock/);
  assert.match(deviceCapacity, /deviceRegistrationPending/);
  assert.match(
    deviceCapacity,
    /enabled: canQueryDeviceSessions/
  );
});

test('device-limit has no dismiss action that can clear server-query gating', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  const modal = await read('src/components/DeviceLimitModal.tsx');

  assert.doesNotMatch(provider, /dismissDeviceRegistrationBlock/);
  assert.match(modal, /onRequestClose=\{\(\) => \{\}\}/);
  assert.doesNotMatch(modal, /dismissDeviceRegistrationBlock/);
});

test('recording retry keeps detail data visible and lets MFA redirect own MFA errors', async () => {
  const detailScreen = await read('app/(app)/(tabs)/recordings/[id].tsx');

  assert.match(
    detailScreen,
    /onSuccess: \(updatedRecording\) => \{[\s\S]*queryClient\.setQueryData\(\['recording', id\], updatedRecording\)/
  );
  assert.match(
    detailScreen,
    /if \(error instanceof ApiError && error\.code === 'MFA_REQUIRED'\) \{\s*return;\s*\}/
  );
});

test('mobile MFA enrollment handles required setup approval codes', async () => {
  const mfaScreen = await read('app/(auth)/mfa.tsx');
  const mfaPolicy = await read('src/auth/mfaPolicy.ts');
  const provider = await read('src/auth/AuthProvider.tsx');

  assert.match(mfaPolicy, /MFA_BOOTSTRAP_CODE_REQUIRED/);
  assert.match(mfaPolicy, /MFA_BOOTSTRAP_CODE_INVALID/);
  assert.match(mfaScreen, /Setup approval code/);
  assert.match(mfaScreen, /bootstrapCode\.trim\(\) \|\| undefined/);
  assert.match(mfaScreen, /status\.enrollmentRequired/);
  assert.match(mfaScreen, /mfaReason === 'MFA_ENROLLMENT_REQUIRED'[\s\S]*startEnrollment/);
  assert.match(provider, /mfaReason: string \| null/);
  assert.match(provider, /setMfaReason\(typeof data\?\.reason === 'string' \? data\.reason : null\)/);
  assert.match(mfaPolicy, /function apiErrorCode\(error: unknown\): string \| undefined/);
  assert.doesNotMatch(mfaScreen, /error instanceof ApiError/);
  assert.match(
    mfaScreen,
    /status\.enrollmentRequired[\s\S]*catch \(enrollmentError\)[\s\S]*setMode\('enroll'\)/
  );
  assert.match(provider, /refreshMfaStatus: \(\) => Promise<MfaStatusResponse>/);
  assert.match(provider, /enrollmentRequired: Boolean\(data\.enrollmentRequired\)/);
});

test('mobile MFA policy maps server errors to executable safe UI messages', async () => {
  const policy = await loadTsModule('src/auth/mfaPolicy.ts');

  assert.equal(policy.isSetupApprovalCodeError({ code: 'MFA_BOOTSTRAP_CODE_REQUIRED' }), true);
  assert.equal(policy.isSetupApprovalCodeError({ code: 'MFA_BOOTSTRAP_CODE_INVALID' }), true);
  assert.equal(policy.isSetupApprovalCodeError({ code: 'OTHER' }), false);

  assert.equal(
    policy.mfaErrorMessage({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many login attempts for goodai@drgoodvet.com',
    }),
    'Too many requests. Please try again shortly.'
  );
  assert.equal(
    policy.mfaErrorMessage({
      status: 500,
      message: 'database password leaked in server text',
    }),
    'A server error occurred. Please try again later.'
  );
  assert.equal(
    policy.mfaErrorMessage({
      code: 'MFA_BOOTSTRAP_CODE_REQUIRED',
      message: 'raw approval text',
    }),
    'Enter the setup approval code to continue.'
  );
});

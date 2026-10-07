/**
 * Guards the bounded session refresh (src/auth/sessionRefresh.ts; Codex
 * review on VetSOAP-Mobile#234).
 *
 * refreshSession() and getSession() await GoTrue's initialize(). After a
 * cold-start restore adopted the persisted session because that initialize()
 * stalled, a 401 refreshed into the same stall and waited with it, and since
 * concurrent 401s share one refresh, so did every other request. The
 * foreground-resume refresh held that same lock on an unbounded getSession().
 *
 * The decision is executed here; the AuthProvider wiring is fenced by regex
 * because tests/helpers/loadTs.mjs cannot load `.tsx`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProviderFunction } from './helpers/loadProviderCallback.mjs';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');
const load = () => loadTsModule('src/auth/sessionRefresh.ts');
const hang = () => new Promise(() => {});
// Results come from the module's own VM realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('no refresh is attempted while GoTrue is still starting up', async () => {
  const { attemptSessionRefresh } = await load();
  let calls = 0;
  const outcome = await attemptSessionRefresh(async () => {
    calls += 1;
    return { error: null };
  }, true);
  assert.deepEqual(plain(outcome), { kind: 'unresolved', reason: 'init_pending' });
  assert.equal(calls, 0, 'it would only queue behind the stalled startup');
});

test('a refresh that never answers is unresolved at the bound, not left hanging', async () => {
  const { attemptSessionRefresh } = await load();
  const outcome = await attemptSessionRefresh(hang, false, 20);
  assert.deepEqual(plain(outcome), { kind: 'unresolved', reason: 'timeout' });
});

test('GoTrue\'s own answer passes through: refreshed, or failed with its error', async () => {
  const { attemptSessionRefresh } = await load();
  assert.deepEqual(plain(await attemptSessionRefresh(async () => ({ error: null }), false, 1_000)), {
    kind: 'refreshed',
  });
  const error = { name: 'AuthApiError', status: 400 };
  assert.deepEqual(plain(await attemptSessionRefresh(async () => ({ error }), false, 1_000)), {
    kind: 'failed',
    error,
  });
});

test('a refresh that throws is not mistaken for a timeout', async () => {
  // A throw keeps its existing handling (the 401 path signs out); only the
  // deadline may read as "GoTrue could not answer".
  const { attemptSessionRefresh, boundedAuthCall } = await load();
  await assert.rejects(
    () => attemptSessionRefresh(async () => { throw new Error('boom'); }, false, 1_000),
    /boom/,
  );
  assert.deepEqual(plain(await boundedAuthCall(async () => 'value', 1_000)), { timedOut: false, value: 'value' });
  assert.deepEqual(plain(await boundedAuthCall(hang, 20)), { timedOut: true });
});

test('only failures that say nothing about the session count as transient', async () => {
  const { isTransientRefreshFailure } = await load();
  for (const code of ['network', 'retryable_fetch', 'rate_limited', 'server_error']) {
    assert.equal(isTransientRefreshFailure(code), true, code);
  }
  // A refused or missing refresh token is GoTrue's answer about the session.
  for (const code of ['invalid_credentials', 'invalid_payload', 'email_not_confirmed', 'other']) {
    assert.equal(isTransientRefreshFailure(code), false, code);
  }
});

test('the transient codes are ones classifyAuthError actually returns', async () => {
  // The helper matches on classifyAuthError's output, so a renamed code would
  // quietly turn a transient failure back into a sign-out.
  const [{ isTransientRefreshFailure }, provider] = await Promise.all([
    load(),
    read('src/auth/AuthProvider.tsx'),
  ]);
  const start = provider.indexOf('function classifyAuthError(');
  const body = provider.slice(start, provider.indexOf('\n}\n', start));
  const codes = [...new Set([...body.matchAll(/return '([a-z_]+)';/g)].map((match) => match[1]))];
  assert.ok(codes.length >= 8, 'classifyAuthError changed shape');
  assert.deepEqual(
    codes.filter((code) => isTransientRefreshFailure(code)).sort(),
    ['network', 'rate_limited', 'retryable_fetch', 'server_error'],
  );
});

test('a 401 refresh that fails transiently keeps the session, like the foreground path', async () => {
  // Codex review on VetSOAP-Mobile#234: after the 3s retry, any failure signed
  // the vet out. During a split outage after a restore, that discarded the
  // offline session for a GoTrue network error.
  const provider = await read('src/auth/AuthProvider.tsx');
  const onUnauthorized = provider.slice(
    provider.indexOf('apiClient.setOnUnauthorized('),
    provider.indexOf('apiClient.setOnSessionExpired(')
  );
  const retryFailed = onUnauthorized.slice(onUnauthorized.indexOf("if (retry.kind === 'failed') {"));
  const keep = retryFailed.indexOf('if (isTransientRefreshFailure(errorCode)) {');
  const signOut = retryFailed.indexOf('await handleSignOut(');
  assert.ok(keep > 0, 'the retry-failed branch must classify the failure');
  assert.ok(keep < signOut, 'and keep a transient one before signing out');
  assert.match(retryFailed.slice(keep, signOut), /return 'unresolved';/);

  const foreground = provider.slice(
    provider.indexOf('const handleAppStateChange = (nextState: AppStateStatus) => {'),
    provider.indexOf("AppState.addEventListener('change', handleAppStateChange)")
  );
  assert.match(foreground, /if \(isTransientRefreshFailure\(errorCode\)\) \{/);
  // One definition: neither path keeps its own list.
  assert.doesNotMatch(foreground, /errorCode === '/);
  assert.doesNotMatch(onUnauthorized, /errorCode === '/);
});

/**
 * The foreground-resume refresh, executed. A 401 that arrives while it runs
 * waits on it, so what it RETURNS is what that request acts on: `'unresolved'`
 * fails it as retryable, while a plain return lets ApiClient take its 401 as
 * final and sign the vet out. A transient failure returned nothing, so a GoTrue
 * network error signed the vet out after all (Codex review on
 * VetSOAP-Mobile#234).
 */
async function foregroundRefresh({ session, getSessionError = null, refreshError = null }) {
  const sessionRefresh = await load();
  const events = [];
  const breadcrumb = (_category, name, data) => events.push(['breadcrumb', name, data?.reason]);
  const trackEvent = () => {};
  const refreshPromiseRef = { current: null };
  const handleAppStateChange = await loadProviderFunction('handleAppStateChange', {
    refreshPromiseRef,
    goTrueInitPendingRef: { current: false },
    boundedAuthCall: sessionRefresh.boundedAuthCall,
    attemptSessionRefresh: sessionRefresh.attemptSessionRefresh,
    isTransientRefreshFailure: sessionRefresh.isTransientRefreshFailure,
    classifyAuthError: await loadProviderFunction('classifyAuthError', {}),
    refreshUnresolved: await loadProviderFunction('refreshUnresolved', { breadcrumb, trackEvent }),
    supabase: {
      auth: {
        getSession: async () => ({ data: { session }, error: getSessionError }),
        refreshSession: async () => {
          events.push(['refresh']);
          return { error: refreshError };
        },
        signOut: async ({ scope }) => {
          events.push(['signOut', scope]);
        },
      },
    },
    breadcrumb,
    trackEvent,
    captureException: () => events.push(['captureException']),
  });
  handleAppStateChange('active');
  const outcome = await refreshPromiseRef.current;
  return { outcome, events };
}

// Inside the 10-minute window, so the resume refreshes.
const expiringSession = () => ({
  access_token: 'synthetic-access',
  expires_at: Math.floor(Date.now() / 1000) + 60,
});
const named = (events, ...names) => events.filter(([name]) => names.includes(name));

test('a foreground refresh that fails transiently answers a waiting 401 with unresolved', async () => {
  for (const refreshError of [
    { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    { name: 'AuthApiError', message: 'Too many requests', status: 429 },
    { name: 'AuthApiError', message: 'Internal error', status: 500 },
  ]) {
    const { outcome, events } = await foregroundRefresh({ session: expiringSession(), refreshError });
    assert.equal(outcome, 'unresolved', refreshError.message);
    assert.deepEqual(named(events, 'refresh', 'signOut'), [['refresh']], 'the session is kept');
  }
});

test('a foreground refresh GoTrue refuses still signs out locally', async () => {
  const { outcome, events } = await foregroundRefresh({
    session: expiringSession(),
    refreshError: { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 },
  });
  assert.equal(outcome, undefined);
  assert.deepEqual(named(events, 'refresh', 'signOut'), [['refresh'], ['signOut', 'local']]);
});

test('getSession failing in transit before the refresh is unresolved too', async () => {
  // getSession() refreshes a near-expiry session itself and reports no session
  // when that fails; that is GoTrue not answering, not a signed-out device.
  const { outcome, events } = await foregroundRefresh({
    session: null,
    getSessionError: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
  });
  assert.equal(outcome, 'unresolved');
  assert.deepEqual(named(events, 'refresh', 'signOut'), []);
});

test('the foreground refresh still answers plainly when GoTrue gave a verdict', async () => {
  // No session and no error: GoTrue holds no session to keep.
  let run = await foregroundRefresh({ session: null });
  assert.equal(run.outcome, undefined);
  assert.deepEqual(named(run.events, 'refresh', 'signOut'), []);
  // A refusal on getSession itself.
  run = await foregroundRefresh({
    session: null,
    getSessionError: { name: 'AuthApiError', message: 'Invalid Refresh Token', status: 400 },
  });
  assert.equal(run.outcome, undefined);
  // A refresh that succeeded: the waiting request retries with the new token.
  run = await foregroundRefresh({ session: expiringSession() });
  assert.equal(run.outcome, undefined);
  assert.deepEqual(named(run.events, 'refresh', 'signOut'), [['refresh']]);
});

test('AuthProvider refreshes on a 401 only through the bounded path, and never signs out on it', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  const onUnauthorized = provider.slice(
    provider.indexOf('apiClient.setOnUnauthorized('),
    provider.indexOf('apiClient.setOnSessionExpired(')
  );
  assert.ok(onUnauthorized.length > 0);
  assert.doesNotMatch(onUnauthorized, /await supabase\.auth\.refreshSession\(\)/);
  const attempts = onUnauthorized.match(
    /attemptSessionRefresh\(\s*\(\) => supabase\.auth\.refreshSession\(\),\s*goTrueInitPendingRef\.current\s*\)/g
  );
  assert.equal(attempts?.length, 2, 'the first refresh and its 3s retry are both bounded');
  assert.match(onUnauthorized, /if \(first\.kind === 'unresolved'\) return refreshUnresolved\('on_auth_state', first\.reason\);/);
  assert.match(onUnauthorized, /if \(retry\.kind === 'unresolved'\) return refreshUnresolved\('on_auth_state', retry\.reason\);/);
  // Waiting on a refresh already in flight passes its outcome through.
  assert.match(onUnauthorized, /if \(refreshPromiseRef\.current\) \{\s*return await refreshPromiseRef\.current;/);
  assert.match(onUnauthorized, /refreshPromiseRef\.current = doRefresh\(\);\s*return await refreshPromiseRef\.current;/);

  const helper = provider.slice(
    provider.indexOf('function refreshUnresolved('),
    provider.indexOf('function refreshUnresolved(') + 600
  );
  assert.match(helper, /return 'unresolved';/);
  assert.doesNotMatch(helper, /handleSignOut|signOut\(|setLogoutReason/);
});

test('the foreground refresh is bounded and stands aside while GoTrue starts up', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  const foreground = provider.slice(
    provider.indexOf('const handleAppStateChange = (nextState: AppStateStatus) => {'),
    provider.indexOf("AppState.addEventListener('change', handleAppStateChange)")
  );
  assert.ok(foreground.length > 0);
  // It holds the lock every 401 handler waits on, so it must never hang.
  assert.match(foreground, /if \(goTrueInitPendingRef\.current\) \{[\s\S]*?return;\s*\}/);
  assert.match(foreground, /const current = await boundedAuthCall\(\(\) => supabase\.auth\.getSession\(\)\);/);
  assert.match(foreground, /if \(current\.timedOut\) return refreshUnresolved\('foreground', 'timeout'\);/);
  assert.match(
    foreground,
    /attemptSessionRefresh\(\s*\(\) => supabase\.auth\.refreshSession\(\),\s*goTrueInitPendingRef\.current\s*\)/
  );
  assert.doesNotMatch(foreground, /await supabase\.auth\.(?:getSession|refreshSession)\(\)/);
});

test('GoTrue counts as starting up until its own initialize() settles', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  assert.match(provider, /const goTrueInitPendingRef = useRef\(true\);/);
  // GoTrue's promise itself, not a deadline around it: a deadline firing says
  // nothing about whether GoTrue has finished.
  assert.match(
    provider,
    /goTrueInitPendingRef\.current = true;\s*const settleGoTrueInit = \(\) => \{\s*goTrueInitPendingRef\.current = false;\s*\};\s*supabase\.auth\.initialize\(\)\.then\(settleGoTrueInit, settleGoTrueInit\);/
  );
});

test('auth-js still behaves the way the startup tracking assumes', async () => {
  // initialize() must hand back the startup already in flight (not start a
  // second one), and refreshSession()/getSession() must wait on that same
  // promise. If an auth-js upgrade changes either, this tracking is wrong.
  const gotrue = await read('node_modules/@supabase/auth-js/dist/main/GoTrueClient.js');
  assert.match(gotrue, /async initialize\(\) \{[\s\S]{0,40}?if \(this\.initializePromise\) \{\s*return await this\.initializePromise;/);
  assert.match(gotrue, /async refreshSession\(currentSession\) \{\s*await this\.initializePromise;/);
  assert.match(gotrue, /async getSession\(\) \{\s*await this\.initializePromise;/);
});

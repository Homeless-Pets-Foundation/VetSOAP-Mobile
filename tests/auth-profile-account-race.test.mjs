import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProviderCallback } from './helpers/loadProviderCallback.mjs';
import { loadTsModule } from './helpers/loadTs.mjs';

const { ApiError, RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');
const { isRetryableFetchUserError, fetchUserErrorMessage } = await loadTsModule('src/auth/fetchUserErrors.ts');
const { restoredExpiryExplains, restoredUserIdFor } = await loadTsModule('src/auth/sessionRestore.ts');
const authA = '11111111-1111-4111-8111-111111111111';
const authB = '22222222-2222-4222-8222-222222222222';
const clinicA = '33333333-3333-4333-8333-333333333333';
const clinicB = '44444444-4444-4444-8444-444444444444';
const bodyA = { user: { id: clinicA, email: 'a@example.test', fullName: 'Synthetic A', role: 'veterinarian', organizationId: 'org-a' }, organization: { name: 'Synthetic clinic' } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness({ request = async () => bodyA, register = async () => true, cacheRead } = {}) {
  const events = [], stored = new Map();
  const cache = await loadTsModule('src/lib/userProfileCache.ts', {
    './secureStorage': { secureStorage: {
      getRawItem: async key => stored.get(key) ?? null,
      setRawItem: async (key, value) => { stored.set(key, value); return true; },
    } },
  });
  const refs = {
    authGenerationRef: { current: 0 }, authSessionUserIdRef: { current: authA },
    fetchUserInFlightRef: { current: null }, activeUserRef: { current: null },
    restoredSessionRef: { current: null }, registerDeviceInFlightRef: { current: null },
  };
  const scopes = {draft:clinicA,stash:clinicA,durable:clinicA};
  const queryData = new Map([['prior-account', {marker:'synthetic'}]]);
  const record = name => value => events.push([name, value]);
  const closure = {
    ...refs,
    queryClient: { clear: () => queryData.clear() }, stopQueryPersistence: record('stopPersistence'),
    setStashUserId: id => { scopes.stash = id; }, draftStorage: { setUserId: id => { scopes.draft = id; } },
    durableTombstone: {setUserId: id => {scopes.durable = id;}}, durableReconcileHold: {setUserId: () => {}}, durableActiveStore: {setUserId: () => {}},
    invalidateDurableRecoveries: () => {}, durableRecoveryStore: {clear: () => {}}, clearTelemetryIdentity: () => {},
    setSession: record('session'), setDeviceRegistrationBlock: record('deviceBlock'), setDeviceRegistrationPending: record('devicePending'),
    setMfaRequired: record('mfaRequired'), setMfaReturnPath: record('mfaReturnPath'), setMfaReason: record('mfaReason'), setActiveMfaChallenge: record('challenge'),
    ApiError, isRetryableFetchUserError, fetchUserErrorMessage, restoredExpiryExplains, restoredUserIdFor,
    apiClient: { get: request, post: async () => { events.push(['bootstrap']); } },
    registerDevice: register, measurePhase: (_name, _tags, fn) => fn(),
    withTimeout: promise => promise,
    withOrganizationName: body => body.user && ({ ...body.user, organizationName: body.organization?.name }),
    applyFetchedUser: user => { refs.activeUserRef.current = user; events.push(['apply', user]); },
    saveProfileCache: cache.saveProfileCache, getCachedProfile: cacheRead ?? cache.getCachedProfile,
    supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: refs.authSessionUserIdRef.current } } } }) } },
    waitForPendingAppleProfileSync: async () => {}, handleSignOutRef: { current: async () => events.push(['signOut']) },
    setUserFetchState: record('state'), setUserFetchError: record('error'), setProfileSource: record('source'),
    setLogoutReason: record('logoutReason'), handleMfaRequiredResponse: record('mfa'),
    breadcrumb: () => {}, trackEvent: () => {},
    // Preserve retry control flow without a seven-second test delay.
    setTimeout: fn => setTimeout(fn, 0),
  };
  const fetchUser = await loadProviderCallback('fetchUser', closure);
  const applyAuthSession = await loadProviderCallback('applyAuthSession', closure);
  function switchAccount() {
    refs.authGenerationRef.current++;
    refs.authSessionUserIdRef.current = authB;
    refs.fetchUserInFlightRef.current = null;
    refs.activeUserRef.current = { id: clinicB };
    events.length = 0;
  }
  return { fetchUser, applyAuthSession, refs, events, cache, stored, scopes, queryData, switchAccount };
}

test('live profile caches its login binding while retaining the clinic storage id', async () => {
  const h = await harness();
  assert.equal(await h.fetchUser(), true);
  const cached = await h.cache.getCachedProfile(authA);
  assert.equal(cached.id, clinicA);
  assert.equal(cached.authUserId, authA);
  assert.equal(cached.organizationName, 'Synthetic clinic');
  assert.equal(await h.cache.getCachedProfile(authB), null);
});

test('a late successful profile from the signed-out account cannot replace the new user', async () => {
  const response = deferred();
  const h = await harness({ request: () => response.promise });
  const flight = h.fetchUser();
  h.switchAccount();
  response.resolve(bodyA);
  assert.equal(await flight, false);
  assert.equal(h.refs.activeUserRef.current.id, clinicB);
  assert.deepEqual(h.events, []);
  assert.equal(h.stored.size, 0);
});

test('switching during device registration prevents old profile application', async () => {
  const registration = deferred(), entered = deferred();
  const h = await harness({ register: () => { entered.resolve(); return registration.promise; } });
  const flight = h.fetchUser();
  await entered.promise;
  h.switchAccount();
  registration.resolve(true);
  assert.equal(await flight, false);
  assert.deepEqual(h.events, []);
  assert.equal(h.stored.size, 0);
});

test('a late MFA refusal cannot move the new account into the old MFA screen', async () => {
  const response = deferred();
  const h = await harness({ request: () => response.promise });
  const flight = h.fetchUser();
  h.switchAccount();
  response.reject(new ApiError('Synthetic refusal', 403, false, {}, 'MFA_REQUIRED'));
  assert.equal(await flight, false);
  assert.deepEqual(h.events, []);
});

test('an offline retry restores a profile with distinct auth and clinic identities', async () => {
  const h = await harness({ request: async () => { throw new RequestTimeoutError('Request timeout after 30000ms'); } });
  await h.cache.saveProfileCache(bodyA.user, authA);
  assert.equal(await h.fetchUser(), true);
  assert.equal(h.refs.activeUserRef.current.id, clinicA);
  assert.ok(h.events.some(([name, value]) => name === 'source' && value === 'cache'));
});

test('switching during a cache read prevents applying the departing profile', async () => {
  const cacheResult = deferred(), entered = deferred();
  const h = await harness({
    request: async () => { throw new RequestTimeoutError('Request timeout after 30000ms'); },
    cacheRead: () => { entered.resolve(); return cacheResult.promise; },
  });
  const flight = h.fetchUser();
  await entered.promise;
  h.switchAccount();
  cacheResult.resolve({ ...bodyA.user, authUserId: authA, cachedAt: Date.now() });
  assert.equal(await flight, false);
  assert.deepEqual(h.events, []);
});


test('failed device registration still applies the current profile for recovery UI', async () => {
  const h = await harness({ register: async () => false });
  assert.equal(await h.fetchUser(), true);
  assert.equal(h.refs.activeUserRef.current.id, clinicA);
});


test('direct SDK account replacement clears the outgoing profile and read scopes', async () => {
  const h = await harness();
  await h.fetchUser();
  h.refs.fetchUserInFlightRef.current = Promise.resolve(true);
  h.refs.registerDeviceInFlightRef.current = Promise.resolve(true);
  h.applyAuthSession({ user: { id: authB }, access_token: 'synthetic-next' });
  assert.equal(h.refs.authGenerationRef.current, 1);
  assert.equal(h.refs.authSessionUserIdRef.current, authB);
  assert.equal(h.refs.activeUserRef.current, null);
  assert.equal(h.refs.fetchUserInFlightRef.current, null);
  assert.equal(h.refs.registerDeviceInFlightRef.current, null);
  assert.deepEqual(h.scopes, {draft:null,stash:null,durable:null});
  assert.equal(h.queryData.size, 0);
  assert.ok(h.events.some(([name, value]) => name === 'stopPersistence' && value.removeStored));
  // Clearing the active account must not delete its offline profile or recordings.
  assert.equal((await h.cache.getCachedProfile(authA)).id, clinicA);
  assert.equal(await h.cache.getCachedProfile(authB), null);
});

test('same-user token rotation retains active work, scopes and shared flights', async () => {
  const h = await harness();
  await h.fetchUser();
  const flight = Promise.resolve(true);
  h.refs.fetchUserInFlightRef.current = flight;
  h.refs.registerDeviceInFlightRef.current = flight;
  h.events.length = 0;
  h.applyAuthSession({ user: { id: authA }, access_token: 'synthetic-rotated' });
  assert.equal(h.refs.authGenerationRef.current, 0);
  assert.equal(h.refs.activeUserRef.current.id, clinicA);
  assert.equal(h.refs.fetchUserInFlightRef.current, flight);
  assert.equal(h.refs.registerDeviceInFlightRef.current, flight);
  assert.deepEqual(h.scopes, {draft:clinicA,stash:clinicA,durable:clinicA});
  assert.equal(h.queryData.size, 1);
  assert.deepEqual(h.events.map(([name]) => name), ['session']);
});

test('a replacement account starts its own profile flight while the old request is pending', async () => {
  const prior = deferred();
  let requests = 0;
  const h = await harness({ request: () => requests++ === 0 ? prior.promise : Promise.resolve({user:{...bodyA.user,id:clinicB}}) });
  const departing = h.fetchUser();
  h.applyAuthSession({user:{id:authB},access_token:'synthetic-next'});
  assert.equal(await h.fetchUser(), true);
  prior.resolve(bodyA);
  assert.equal(await departing, false);
  assert.equal(requests, 2);
  assert.equal(h.refs.activeUserRef.current.id, clinicB);
  assert.equal((await h.cache.getCachedProfile(authB)).id, clinicB);
});

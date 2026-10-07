import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { QueryClient, dehydrate } from '@tanstack/react-query';
import { loadTsModule } from './helpers/loadTs.mjs';

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'synthetic@example.invalid' };
const token = (expiresAt) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: user.id, exp: expiresAt, iat: expiresAt - 3600, aud: 'authenticated' })).toString('base64url'),
  'synthetic-signature',
].join('.');

function authFixture(expiresAt) {
  let raw = JSON.stringify({ access_token: token(expiresAt), refresh_token: 'synthetic-refresh', expires_at: expiresAt, token_type: 'bearer', user });
  let answer;
  const network = new Promise((resolve) => { answer = resolve; });
  const client = createClient('https://synthetic.example.supabase.co', 'synthetic-anon', {
    auth: {
      autoRefreshToken: false, detectSessionInUrl: false, persistSession: true,
      storageKey: 'synthetic-session',
      storage: { getItem: async () => raw, setItem: async (_key, value) => { raw = value; }, removeItem: async () => { raw = null; } },
    },
    global: { fetch: async () => network },
  });
  return {
    client,
    stored: () => raw,
    completeRefresh() {
      const expiry = Math.floor(Date.now() / 1000) + 7200;
      answer(new Response(JSON.stringify({ access_token: token(expiry), refresh_token: 'synthetic-rotated', expires_in: 7200, token_type: 'bearer', user }), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  };
}

test('installed Supabase SDK stalled cold restore retains attributable storage until rotation completes', async () => {
  const fixture = authFixture(Math.floor(Date.now() / 1000) - 3600);
  const { boundedAuthCall } = await loadTsModule('src/auth/sessionRefresh.ts');
  const { sessionRestoreTrigger, parsePersistedSession } = await loadTsModule('src/auth/sessionRestore.ts');
  const session = fixture.client.auth.getSession();
  try {
    const bounded = await boundedAuthCall(() => session, 20);
    assert.equal(bounded.timedOut, true);
    assert.equal(sessionRestoreTrigger(null), 'unanswered');
    assert.equal(parsePersistedSession(fixture.stored()).user.id, user.id);
  } finally {
    fixture.completeRefresh();
    const result = await session;
    assert.equal(result.error, null);
    assert.equal(result.data.session.refresh_token, 'synthetic-rotated');
    fixture.client.auth.stopAutoRefresh();
  }
});

test('installed Supabase SDK explicit refresh stays bounded and preserves the prior session', async () => {
  const fixture = authFixture(Math.floor(Date.now() / 1000) + 3600);
  const restored = await fixture.client.auth.getSession();
  assert.equal(restored.data.session.user.id, user.id);
  const { attemptSessionRefresh } = await loadTsModule('src/auth/sessionRefresh.ts');
  const refresh = fixture.client.auth.refreshSession();
  try {
    const result = await attemptSessionRefresh(() => refresh, false, 20);
    assert.equal(result.kind, 'unresolved');
    assert.equal(result.reason, 'timeout');
    assert.equal(JSON.parse(fixture.stored()).refresh_token, 'synthetic-refresh');
  } finally {
    fixture.completeRefresh();
    assert.equal((await refresh).error, null);
    assert.equal(JSON.parse(fixture.stored()).refresh_token, 'synthetic-rotated');
    fixture.client.auth.stopAutoRefresh();
  }
});

async function persistenceFixture(storage) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const persistence = await loadTsModule('src/lib/queryPersistence.ts', {
    '@react-native-async-storage/async-storage': storage,
    './queryClient': { queryClient },
    'expo-application': { nativeApplicationVersion: 'synthetic' },
  });
  return { queryClient, ...persistence };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'SDK persistence did not complete');
    await delay(10);
  }
}

test('installed TanStack packages retain cached reads after an offline refetch without persisting auth', async () => {
  const stored = new Map();
  const fixture = await persistenceFixture({
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => { stored.set(key, value); },
    removeItem: async (key) => { stored.delete(key); },
  });
  try {
    fixture.startQueryPersistence('synthetic-user');
    await delay(0);
    fixture.queryClient.setQueryData(['patient', 'synthetic-patient'], { id: 'synthetic-patient' });
    fixture.queryClient.setQueryData(['session'], { value: 'synthetic-private-state' });
    await assert.rejects(fixture.queryClient.fetchQuery({ queryKey: ['patient', 'synthetic-patient'], queryFn: async () => { throw new Error('synthetic-offline'); }, staleTime: 0 }), /synthetic-offline/);
    await waitFor(() => {
      const raw = stored.get('captivet_rq_cache_synthetic-user');
      return raw && JSON.parse(raw).clientState.queries.some((query) => query.state.status === 'error');
    });
    const snapshot = JSON.parse(stored.get('captivet_rq_cache_synthetic-user'));
    assert.deepEqual(snapshot.clientState.queries.map((query) => query.queryKey), [['patient', 'synthetic-patient']]);
    assert.equal(snapshot.clientState.queries[0].state.status, 'error');
    assert.deepEqual(snapshot.clientState.queries[0].state.data, { id: 'synthetic-patient' });
    fixture.stopQueryPersistence({ removeStored: false });
    fixture.queryClient.clear();
    fixture.startQueryPersistence('synthetic-user');
    await waitFor(() => fixture.queryClient.getQueryData(['patient', 'synthetic-patient']) !== undefined);
    assert.deepEqual(fixture.queryClient.getQueryData(['patient', 'synthetic-patient']), { id: 'synthetic-patient' });
    assert.equal(fixture.queryClient.getQueryData(['session']), undefined);
  } finally {
    fixture.stopQueryPersistence({ removeStored: false });
    fixture.queryClient.clear();
  }
});

test('installed TanStack hydration discards a prior account read that completes after switching', async () => {
  const snapshot = (account, id) => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    client.setQueryData(['patient', id], { id });
    const result = JSON.stringify({ timestamp: Date.now(), buster: `synthetic:${account}`, clientState: dehydrate(client) });
    client.clear();
    return result;
  };
  let release;
  const prior = new Promise((resolve) => { release = resolve; });
  const next = snapshot('account-b', 'patient-b');
  const fixture = await persistenceFixture({
    getItem: async (key) => key.endsWith('account-a') ? prior : next,
    setItem: async () => {}, removeItem: async () => {},
  });
  try {
    fixture.startQueryPersistence('account-a');
    fixture.stopQueryPersistence({ removeStored: false });
    fixture.queryClient.clear();
    fixture.startQueryPersistence('account-b');
    release(snapshot('account-a', 'patient-a'));
    await waitFor(() => fixture.queryClient.getQueryData(['patient', 'patient-b']) !== undefined);
    await delay(0);
    assert.equal(fixture.queryClient.getQueryData(['patient', 'patient-a']), undefined);
    assert.deepEqual(fixture.queryClient.getQueryData(['patient', 'patient-b']), { id: 'patient-b' });
  } finally {
    fixture.stopQueryPersistence({ removeStored: false });
    fixture.queryClient.clear();
  }
});

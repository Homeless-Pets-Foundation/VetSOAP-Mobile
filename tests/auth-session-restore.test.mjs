/**
 * Guards the offline-first cold-start session restore (Sentry REACT-NATIVE-1K).
 *
 * `supabase.auth.getSession()` awaits GoTrue's initialize(), which refreshes an
 * access token within 90s of expiry over the network and retries a retryable
 * failure for up to 30s. After the 1h token lifetime that put the network on
 * every cold start: offline, getSession() resolved `session: null` with an
 * AuthRetryableFetchError (GoTrue keeps the session in storage), and on a slow
 * link it outlived the 10s deadline. Either way a signed-in vet landed on the
 * sign-in screen — and offline could not get back to their drafts.
 *
 * The decision is executed here; the AuthProvider wiring is fenced by regex
 * because tests/helpers/loadTs.mjs cannot load `.tsx`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');
const load = () => loadTsModule('src/auth/sessionRestore.ts');
// Results come from the module's own VM realm; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW_S = 1_790_000_000;
function persisted(overrides = {}) {
  return JSON.stringify({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: NOW_S - 60,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'user-a', aud: 'authenticated' },
    ...overrides,
  });
}

test('restores only when GoTrue could not answer, or could not read storage', async () => {
  const { sessionRestoreTrigger } = await load();

  // withTimeout yields null when the deadline fired or getSession rejected.
  assert.equal(sessionRestoreTrigger(null), 'unanswered');
  assert.equal(sessionRestoreTrigger(undefined), 'unanswered');

  // Offline: GoTrue kept the session in storage and reported a retryable error.
  const retryable = { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' };
  assert.equal(
    sessionRestoreTrigger({ data: { session: null }, error: retryable }),
    'retryable_error'
  );

  // No session and no error is not proof of a sign-out: GoTrue reads storage
  // through the lenient adapter, which turns a Keystore failure into "nothing
  // stored" (Codex review on VetSOAP-Mobile#234). The strict read decides.
  assert.equal(sessionRestoreTrigger({ data: { session: null }, error: null }), 'no_session');
  assert.equal(sessionRestoreTrigger({ data: { session: null } }), 'no_session');
  // An unexpected shape fails toward "no restore".
  assert.equal(sessionRestoreTrigger({ error: null }), null);

  // A non-retryable error is GoTrue's answer about the session: it already
  // removed a dead one.
  assert.equal(
    sessionRestoreTrigger({
      data: { session: null },
      error: { name: 'AuthApiError', status: 400, message: 'Invalid Refresh Token' },
    }),
    null
  );
  assert.equal(
    sessionRestoreTrigger({ data: { session: null }, error: { name: 'AuthSessionMissingError' } }),
    null
  );
  // A delivered session is the normal path, never a restore.
  assert.equal(
    sessionRestoreTrigger({ data: { session: { access_token: 'x' } }, error: retryable }),
    null
  );
  // Look-alikes without the exact name fail toward "no restore".
  assert.equal(
    sessionRestoreTrigger({ data: { session: null }, error: { message: 'AuthRetryableFetchError' } }),
    null
  );
  assert.equal(sessionRestoreTrigger({ data: { session: null }, error: 'AuthRetryableFetchError' }), null);
});

test('parses the session GoTrue persisted and rejects anything it cannot attribute', async () => {
  const { parsePersistedSession } = await load();

  const session = parsePersistedSession(persisted());
  assert.ok(session);
  assert.equal(session.user.id, 'user-a');
  assert.equal(session.access_token, 'access');
  assert.equal(session.refresh_token, 'refresh');

  for (const raw of [
    null,
    undefined,
    '',
    '{not json',
    'null',
    '[]',
    '"a string"',
    persisted({ access_token: '' }),
    persisted({ access_token: 42 }),
    persisted({ refresh_token: '' }),
    persisted({ refresh_token: null }),
    persisted({ expires_at: 'soon' }),
    persisted({ expires_at: null }),
    persisted({ user: null }),
    persisted({ user: { id: '' } }),
    persisted({ user: { email: 'no-id@example.test' } }),
    persisted({ user: [] }),
  ]) {
    assert.equal(parsePersistedSession(raw), null, `must reject ${String(raw).slice(0, 60)}`);
  }
  // A non-finite expiry (JSON cannot carry Infinity/NaN, but a corrupt value can
  // arrive as a huge exponent) is rejected rather than treated as never-expiring.
  assert.equal(parsePersistedSession(persisted().replace(`${NOW_S - 60}`, '1e400')), null);
});

test('access-token expiry is judged on the real expiry, not GoTrue\'s 90s margin', async () => {
  const { isAccessTokenExpired } = await load();
  const nowMs = NOW_S * 1000;
  assert.equal(isAccessTokenExpired({ expires_at: NOW_S - 1 }, nowMs), true);
  assert.equal(isAccessTokenExpired({ expires_at: NOW_S }, nowMs), true);
  assert.equal(isAccessTokenExpired({ expires_at: NOW_S + 30 }, nowMs), false);
  assert.equal(isAccessTokenExpired({ expires_at: undefined }, nowMs), true);
});

test('the restore read fits inside the init watchdog budget', async () => {
  const { SESSION_RESTORE_READ_TIMEOUT_MS } = await load();
  const provider = await read('src/auth/AuthProvider.tsx');

  const getSessionMs = Number(
    provider
      .match(/withTimeout\(supabase\.auth\.getSession\(\), ([\d_]+), 'auth_init_get_session'\)/)?.[1]
      ?.replace(/_/g, '')
  );
  const watchdogMs = Number(
    provider
      .match(/const initWatchdog = setTimeout\(\(\) => \{[\s\S]*?\}, ([\d_]+)\);/)?.[1]
      ?.replace(/_/g, '')
  );
  assert.ok(Number.isFinite(getSessionMs) && getSessionMs > 0);
  assert.ok(Number.isFinite(watchdogMs) && watchdogMs > 0);
  // If the restore could outlive the watchdog, the watchdog would show the
  // sign-in screen first and the restore guard would then skip — the fix would
  // silently stop working on exactly the slow devices it exists for.
  assert.ok(
    getSessionMs + SESSION_RESTORE_READ_TIMEOUT_MS < watchdogMs,
    `${getSessionMs} + ${SESSION_RESTORE_READ_TIMEOUT_MS} must stay under ${watchdogMs}`
  );
});

test('AuthProvider restores only through the guarded, bounded path', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');

  // Wired into the no-session branch of the cold-start getSession result.
  assert.match(
    provider,
    /\} else \{\s*const trigger = sessionRestoreTrigger\(result\);\s*if \(trigger\) await restorePersistedSession\(trigger\);\s*\}/
  );

  // Rule 24 + rule 3: the read goes through the secureStorage wrapper, is
  // strict, and stays inside its budget; an unreadable store is not "no session".
  assert.match(
    provider,
    /const read = await readPersistedSession\(\s*\(\) => secureStorage\.getSessionStrict\(\),\s*SESSION_RESTORE_READ_TIMEOUT_MS\s*\);/
  );
  assert.match(
    provider,
    /const restored = read\.status === 'found' \? parsePersistedSession\(read\.raw\) : null;/
  );
  assert.match(provider, /const skipReason = read\.status === 'unreadable'\s*\?\s*'storage_unreadable'/);

  // Every reason GoTrue's own answer must win is re-checked after the await.
  assert.match(provider, /: initWatchdogFired\s*\?\s*'init_watchdog_fired'/);
  assert.match(
    provider,
    /: authEventSeen \|\| disposed \|\| authGenerationRef\.current !== initGeneration\s*\?\s*'superseded'/
  );
  assert.match(provider, /disposed = true;\s*clearTimeout\(initWatchdog\);\s*subscription\.unsubscribe\(\);/);
  assert.match(provider, /initWatchdogFired = true;\s*captureMessage\('auth_init_watchdog_fired'/);
  assert.match(provider, /if \(event === 'INITIAL_SESSION'\) return;\s*authEventSeen = true;/);

  // Adoption mirrors the normal restore path: lazy validation, never a
  // blocking getUser/refresh on the cold-start path.
  const restoreBody = provider.slice(
    provider.indexOf('const restorePersistedSession = async'),
    provider.indexOf('// Restore existing session on startup.')
  );
  assert.ok(restoreBody.length > 0);
  assert.match(restoreBody, /applyAuthSession\(restored\);/);
  assert.match(restoreBody, /sessionTimestampRef\.current = Date\.now\(\);/);
  assert.match(restoreBody, /apiClient\.setToken\(restored\.access_token\);/);
  assert.match(restoreBody, /fetchUser\(\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(restoreBody, /refreshSession\(|getUser\(|signOut\(/);
  assert.doesNotMatch(restoreBody, /secureStorage\.getSession\(\)/, 'the lenient read hides a failure');
});

test('a restore read tells a failing Keystore from a device with no session', async () => {
  // Codex review on VetSOAP-Mobile#234. The lenient read returned null for a
  // Keystore failure and the deadline did the same for a hang, so a transient
  // fault read as "no stored session" and the restore was abandoned.
  const { readPersistedSession } = await load();
  assert.deepEqual(plain(await readPersistedSession(async () => 'stored', 1_000)), {
    status: 'found',
    raw: 'stored',
  });

  let reads = 0;
  assert.deepEqual(
    plain(await readPersistedSession(async () => {
      reads += 1;
      return null;
    }, 1_000)),
    { status: 'absent' }
  );
  assert.equal(reads, 1, 'a proven absence is final');

  reads = 0;
  const flaky = async () => {
    reads += 1;
    if (reads === 1) throw new Error('keystore unavailable');
    return 'stored';
  };
  assert.deepEqual(plain(await readPersistedSession(flaky, 10_000)), { status: 'found', raw: 'stored' });
  assert.equal(reads, 2, 'a failure is retried inside the budget');
});

test('a restore read that keeps failing or hangs is unreadable, and stays inside its budget', async () => {
  const { readPersistedSession } = await load();
  let reads = 0;
  assert.deepEqual(
    plain(await readPersistedSession(async () => {
      reads += 1;
      throw new Error('keystore unavailable');
    }, 10_000)),
    { status: 'unreadable' }
  );
  assert.equal(reads, 3, 'retries are capped, not stretched to fill the budget');

  const started = Date.now();
  assert.deepEqual(plain(await readPersistedSession(() => new Promise(() => {}), 40)), {
    status: 'unreadable',
  });
  assert.ok(Date.now() - started < 1_000, 'a hung read ends with its budget');
});

test('the profile-cache fallback can find a restored user, but never across a sign-out', async () => {
  const { restoredUserIdFor } = await load();
  const stamp = { userId: 'user-a', generation: 3, expiresAt: NOW_S - 60 };
  assert.equal(restoredUserIdFor(stamp, 3), 'user-a');
  // A sign-out bumped the generation: the stamp is retired.
  assert.equal(restoredUserIdFor(stamp, 4), undefined);
  assert.equal(restoredUserIdFor(null, 0), undefined);
  assert.equal(restoredUserIdFor(undefined, 0), undefined);
  assert.equal(restoredUserIdFor({ ...stamp, userId: '', generation: 0 }, 0), undefined);

  const provider = await read('src/auth/AuthProvider.tsx');
  assert.match(provider, /const restoredSessionRef = useRef<RestoredSessionStamp \| null>\(null\);/);
  assert.match(
    provider,
    /restoredSessionRef\.current = \{\s*userId: restored\.user\.id,\s*generation: authGenerationRef\.current,\s*expiresAt: restored\.expires_at \?\? 0,\s*\};/
  );
  // GoTrue's own session still wins; the restored id is only the fallback.
  assert.match(
    provider,
    /const sessionUserId =\s*sessionResult\?\.data\?\.session\?\.user\?\.id \?\?\s*restoredUserIdFor\(restoredSessionRef\.current, authGenerationRef\.current\);/
  );
  // Both sign-out paths bump the generation that retires the stamp.
  assert.ok((provider.match(/authGenerationRef\.current \+= 1;/g) ?? []).length >= 2);
});

test('a 401 that only the restored token\'s expiry explains still reaches the profile cache', async () => {
  // Codex review on VetSOAP-Mobile#234. The restore adopts an expired access
  // token exactly when GoTrue cannot refresh (offline, or its fetch stalled).
  // With the API reachable, /auth/me answered 401 for that expiry alone,
  // fetchUser read it as the API refusing the account, and the vet landed on
  // "Can't Load Account" instead of their drafts.
  const { restoredExpiryExplains } = await load();
  const { ApiError, RequestTimeoutError } = await loadTsModule('src/api/apiErrors.ts');
  const nowMs = NOW_S * 1000;
  const expired = { userId: 'user-a', generation: 3, expiresAt: NOW_S - 60 };
  const unauthorized = new ApiError('Unauthorized', 401);

  assert.equal(restoredExpiryExplains(unauthorized, expired, 3, nowMs), true);
  // Judged when the 401 arrives (second Codex review): a token restored with
  // 30 s to spare that has since expired, or is inside GoTrue's own 90 s
  // margin, still explains the 401.
  const nearExpiry = { ...expired, expiresAt: NOW_S + 30 };
  assert.equal(restoredExpiryExplains(unauthorized, nearExpiry, 3, nowMs + 45_000), true);
  assert.equal(restoredExpiryExplains(unauthorized, nearExpiry, 3, nowMs), true);
  // Everything else stays a refusal: a token with real life left, another
  // status, a stamp from before a sign-out, or no restore at all.
  const fresh = { ...expired, expiresAt: NOW_S + 600 };
  assert.equal(restoredExpiryExplains(unauthorized, fresh, 3, nowMs), false);
  assert.equal(restoredExpiryExplains(new ApiError('Forbidden', 403), expired, 3, nowMs), false);
  assert.equal(restoredExpiryExplains(unauthorized, expired, 4, nowMs), false);
  assert.equal(restoredExpiryExplains(unauthorized, null, 3, nowMs), false);
  assert.equal(restoredExpiryExplains(new RequestTimeoutError('deadline'), expired, 3, nowMs), false);
  assert.equal(restoredExpiryExplains({ status: 401 }, expired, 3, nowMs), false, 'only an ApiError');

  const provider = await read('src/auth/AuthProvider.tsx');
  // fetchUser lets that 401 through to the cache fallback...
  assert.match(
    provider,
    /if \(!isRetryableFetchUserError\(lastError\) && !restoredExpiryExplains\(lastError, restoredSessionRef\.current, authGenerationRef\.current, Date\.now\(\)\)\) \{/
  );
  // ...and any real session clears the stamp, so a 401 on a refreshed token
  // is a refusal again.
  assert.match(
    provider,
    /authEventSeen = true;\s*(?:\/\/[^\n]*\n\s*)*if \(newSession\?\.access_token\) restoredSessionRef\.current = null;/
  );
});

test('the restore event is in the analytics catalog with PHI-free props', async () => {
  const analytics = await read('src/lib/analytics.ts');
  assert.match(
    analytics,
    /name: 'session_restored_from_storage';\s*props: \{ trigger: 'unanswered' \| 'retryable_error' \| 'no_session'; access_token_expired: boolean \};/
  );
});

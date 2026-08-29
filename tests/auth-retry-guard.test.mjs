// CLAUDE.md rule 22 — `signIn` retries once on `AuthRetryableFetchError`.
//
// Production symptom: GoTrue's internal auto-refresh timer leaves a stale
// AbortController behind after a previous signOut. The next
// `signInWithPassword()` then rejects IMMEDIATELY with
// `AuthRetryableFetchError` (status 0, "Network request failed"), which on iOS
// turned into a sign-in loop the user could not escape. The fix is a single
// retry after a short delay, because the retry constructs a fresh controller.
//
// Rule 22 also carries a PROHIBITION that is easy to "helpfully" reintroduce:
// do NOT call `supabase.auth.signOut({ scope: 'local' })` before signing in.
// That emits SIGNED_OUT, which sends `onAuthStateChange` (rule 16) into
// `refreshSession()` — which hangs on the very same poisoned controller. A 90 s
// hang was confirmed. The retry alone is sufficient.
//
// Why this file exists: until now rule 22 had ZERO test coverage — a grep for
// `AuthRetryableFetchError` across tests/ returned nothing, while the rule is
// documented in CLAUDE.md, in docs/rn-sdk-upgrade-plan.md, and in two device
// test plans. `3b19fbb` (2026-08-04) moved @supabase/auth-js to 2.112.0, and
// docs/rn-sdk-upgrade-plan.md:253 warns in as many words that a Supabase bump
// can regress this workaround while every ordinary sign-in still passes. That
// is precisely the failure a source fence catches and a manual pass does not.
//
// Source-text, not execution: AuthProvider is a .tsx, and
// tests/helpers/loadTs.mjs resolves .ts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

test('signIn retries exactly once on AuthRetryableFetchError', async () => {
  const src = await read('src/auth/AuthProvider.tsx');

  // Anchor on the RETRY site, not classifyAuthError's earlier match on the
  // same error name.
  const guard = src.indexOf("if (error && (error as { name?: string }).name === 'AuthRetryableFetchError')");
  assert.ok(guard > 0, 'the AuthRetryableFetchError retry branch is gone — rule 22 regressed');

  // Bound the assertions to the retry block so an unrelated later
  // signInWithPassword cannot satisfy them by accident.
  const block = src.slice(guard, guard + 700);

  assert.match(block, /setTimeout\(resolve, 500\)/, 'the 500ms backoff before the retry is gone');
  assert.match(
    block,
    /const retry = await supabase\.auth\.signInWithPassword\(\{ email, password \}\)/,
    'the retry must re-issue signInWithPassword so a FRESH AbortController is built',
  );
  assert.match(block, /error = retry\.error/, 'the retry result must replace the original error');

  // Exactly one retry. A loop here would spin against a genuinely down backend.
  const retries = block.match(/signInWithPassword/g) ?? [];
  assert.equal(retries.length, 1, 'rule 22 is ONE retry, not a retry loop');
});

test('the retry is observable in analytics', async () => {
  const [src, analytics] = await Promise.all([
    read('src/auth/AuthProvider.tsx'),
    read('src/lib/analytics.ts'),
  ]);
  // Without this event a silent retry storm is invisible in production.
  assert.match(src, /trackEvent\(\{ name: 'auth_retry_fired', props: \{ op: 'sign_in' \} \}\)/);
  assert.match(analytics, /name: 'auth_retry_fired'/, 'event missing from the AnalyticsEvent union');
  // retry_used rides on the failure event so a fix can be measured.
  assert.match(src, /retry_used: retryUsed/);
});

test('AuthRetryableFetchError classifies to a PHI-free code', async () => {
  const src = await read('src/auth/AuthProvider.tsx');
  assert.match(
    src,
    /if \(error\.name === 'AuthRetryableFetchError'\) return 'retryable_fetch';/,
    'classifyAuthError must map this by NAME — status 0 alone would blur it into generic network',
  );
  // The raw message can carry an email address; only the code may be emitted.
  assert.doesNotMatch(
    src,
    /name: 'sign_in_failed',\s*props: \{[^}]*error\.message/,
    'sign_in_failed must never carry the raw error message',
  );
});

test('signIn does NOT sign out locally first (the rule-22 prohibition)', async () => {
  const src = await read('src/auth/AuthProvider.tsx');
  const start = src.indexOf('const signIn =');
  assert.ok(start > 0, 'signIn changed shape');
  const end = src.indexOf('const signOut =', start);
  const body = src.slice(start, end > start ? end : start + 6000);

  // This is the regression that turns a fast retry into a 90s hang: SIGNED_OUT
  // drives onAuthStateChange (rule 16) into refreshSession() on the same
  // poisoned controller.
  assert.doesNotMatch(
    body,
    /supabase\.auth\.signOut\(/,
    "signIn must not call supabase.auth.signOut() — rule 22 confirms a 90s hang",
  );
});

test('an in-flight sign-out is awaited before a new sign-in', async () => {
  // Complements rule 22 (PR #143): a late _removeSession() from a still-running
  // signOut would otherwise clobber the freshly-created session.
  const src = await read('src/auth/AuthProvider.tsx');
  assert.match(src, /waitForPendingSignOut\(/);
});

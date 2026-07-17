// Codex round-7 regressions (PR #143): lockout counts only credential
// rejections, visits pruning waits for real data, and the recordings list
// prefers polled data over one-shot detail fetches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('brute-force lockout advances only on invalid_credentials', async () => {
  const auth = await read('src/auth/AuthProvider.tsx');
  // Every password sign-in failure path is classified…
  assert.match(auth, /code: 'signout_pending' as const/);
  assert.match(auth, /code: 'network' as const/);
  assert.match(auth, /code: 'invalid_credentials' as const/);
  // …and the PROD fallthrough must not brand rate limits / server errors as
  // bad credentials — that recreated the outage lockout (Codex P2 round 8).
  assert.match(auth, /if \(errorCode === 'invalid_credentials'\) \{\s*\n\s*return \{ error: 'Invalid email or password', code: 'invalid_credentials' as const \};/);
  assert.match(auth, /return \{ error: 'Sign-in failed\. Please try again\.', code: 'other' as const \};/);

  const login = await read('app/(auth)/login.tsx');
  // …and only genuine credential rejections increment the counter. A network
  // outage or pending sign-out must not lock a user out locally.
  assert.match(login, /if \(result\.code === 'invalid_credentials'\) \{\s*\n\s*failedAttemptsRef\.current \+= 1;/);
  // Social failures (config/native/network) never advance the counter — the
  // provider's own prompt guards brute force; the gate still applies.
  const socialStart = login.indexOf('const handleSocial = useCallback');
  const socialEnd = login.indexOf('const AppleAuthenticationButton');
  const socialBody = login.slice(socialStart, socialEnd);
  assert.doesNotMatch(socialBody, /failedAttemptsRef\.current \+= 1/);
  assert.match(socialBody, /lockoutUntilRef\.current > Date\.now\(\)/);
});

test('visits pruning waits for real (non-placeholder) expanded data', async () => {
  const src = await read('app/(app)/(tabs)/patient/[id].tsx');
  // keepPreviousData makes recordingsData truthy immediately with the SMALLER
  // page — pruning then would delete the last successful page while the
  // expanded request can still fail offline.
  assert.match(src, /isPlaceholderData: recordingsIsPlaceholder/);
  assert.match(src, /if \(!id \|\| !recordingsData \|\| recordingsIsPlaceholder\) return;/);
});

test('recordings list prefers polled list data; detail is fallback only', async () => {
  const src = await read('app/(app)/(tabs)/recordings/index.tsx');
  // The list polls processing recordings every 10s; the per-id detail queries
  // fetch once on mount. Detail must not overwrite fresher list entries.
  assert.match(
    src,
    /recording\?\.id && submittedIdSet\.has\(recording\.id\) && !map\.has\(recording\.id\)/
  );
  // When a search/status filter excludes a submitted id from the list, the
  // detail query is the banner's ONLY source — it must poll while processing
  // instead of freezing at its mount-time status (Codex P2 round 8).
  assert.match(src, /listedRecordingIds\.has\(rec\.id\)\) return false/);
  assert.match(src, /const processing = !\['completed', 'failed', 'pending_metadata'\]\.includes\(rec\.status \?\? ''\)/);
});

test('card actions clear stale errors before running (Codex P2 round 8)', async () => {
  const clientEmail = await read('src/components/ClientEmailCard.tsx');
  for (const action of ['const copyDraft', 'const openMail', 'const shareDraft']) {
    const start = clientEmail.indexOf(action);
    assert.ok(start >= 0, `${action} must exist`);
    assert.match(
      clientEmail.slice(start, start + 400),
      /setErrorStatus\(null\)/,
      `${action} must clear the prior action error`
    );
  }
  const translation = await read('src/components/TranslationCard.tsx');
  const copyStart = translation.indexOf('const copySection');
  assert.match(translation.slice(copyStart, copyStart + 400), /setErrorStatus\(null\)/);
});

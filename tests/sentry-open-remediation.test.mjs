import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('draftStorage avoids self-copying durable draft segments and falls back to legacy copy/move', async () => {
  const src = await read('src/lib/draftStorage.ts');

  assert.match(src, /function sameFileUri\(a: string, b: string\): boolean/);
  assert.match(src, /copyAsync as legacyCopyAsync/);
  assert.match(src, /moveAsync as legacyMoveAsync/);
  assert.match(src, /async function copyFileReplacing\(sourceUri: string, destUri: string\): Promise<boolean>/);
  assert.match(src, /if \(sameFileUri\(segment\.uri, destUri\)\)/);
  assert.match(src, /const tempUri = `\$\{destUri\}\.tmp-\$\{Date\.now\(\)\}`/);
  assert.match(src, /new ExpoFile\(sourceUri\)\.copy\(new ExpoFile\(tempUri\)\)/);
  assert.match(src, /await legacyCopyAsync\(\{ from: sourceUri, to: tempUri \}\)/);
  assert.match(src, /new ExpoFile\(tempUri\)\.move\(new ExpoFile\(destUri\)\)/);
  assert.match(src, /await legacyMoveAsync\(\{ from: tempUri, to: destUri \}\)/);
  assert.match(src, /await copyFileReplacing\(segment\.uri, destUri\)/);
});

test('draft orphan sweep stays out of Sentry warnings after successful cleanup', async () => {
  const src = await read('src/lib/draftStorage.ts');

  assert.match(src, /emitDraftOrphanSweep\(found, cleaned\)/);
  assert.match(src, /draftBreadcrumb\('orphan_sweep_deleted', \{ found, cleaned \}\)/);
  assert.doesNotMatch(src, /draftCaptureWarning\('draft_orphan_sweep_deleted'/);
});

test('production API URL ignores missing or Railway fallback env values', async () => {
  const src = await read('src/config.ts');

  assert.match(src, /const CANONICAL_API_URL = 'https:\/\/api\.captivet\.com'/);
  assert.match(src, /const RAILWAY_FALLBACK_HOST = 'api-production-8e5e\.up\.railway\.app'/);
  assert.match(src, /function normalizeProductionApiUrl\(value: string \| undefined\): string/);
  assert.match(src, /parsed\.hostname === RAILWAY_FALLBACK_HOST/);
  assert.match(src, /: normalizeProductionApiUrl\(process\.env\.EXPO_PUBLIC_API_URL\)/);
});

test('auth init defers token validation to the first authed request (no blocking cold-start getUser)', async () => {
  const src = await read('src/auth/AuthProvider.tsx');

  // getSession stays bounded (local read can still hang on a poisoned bridge).
  assert.match(
    src,
    /withTimeout\(supabase\.auth\.getSession\(\), [\d_]+, 'auth_init_get_session'\)/
  );

  // The blocking cold-start getUser/refreshSession preflight is gone — it was
  // the dominant watchdog stall (RN-D) and logged offline users out via
  // clearAll(). Lazy validation via apiClient.onUnauthorized/onSessionExpired
  // replaces it.
  assert.doesNotMatch(src, /'auth_init_get_user'/);
  assert.doesNotMatch(src, /'auth_init_refresh_session'/);

  // Restore path now just trusts the persisted session and fetches the user;
  // a stale token surfaces as a 401 on that request, not a startup stall.
  const restoreIdx = src.indexOf('if (existingSession.access_token) {');
  assert.ok(restoreIdx > -1, 'session-restore branch must be findable');
  const restoreBody = src.slice(restoreIdx, restoreIdx + 1600);
  assert.match(restoreBody, /setSession\(existingSession\);/);
  assert.match(restoreBody, /apiClient\.setToken\(existingSession\.access_token\);/);
  assert.match(restoreBody, /fetchUser\(\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(restoreBody, /secureStorage\.clearAll\(\)/);
});

test('sync_server_draft network failures are breadcrumbed, not captured as Sentry errors', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  assert.match(src, /function isNetworkRequestFailed\(error: unknown\): boolean/);
  assert.match(src, /if \(isNetworkRequestFailed\(error\)\) \{/);
  assert.match(src, /breadcrumb\('draft', 'sync_server_draft_transient_network'/);

  const catchMatch = src.match(
    /const syncServerDraft = useCallback\([\s\S]*?catch \(error\) \{([\s\S]*?)if \(__DEV__\) console\.warn\('\[Record\] syncServerDraft failed:/
  );
  assert.ok(catchMatch, 'syncServerDraft catch body must be findable');
  const catchBody = catchMatch[1];
  assert.ok(
    catchBody.indexOf("breadcrumb('draft', 'sync_server_draft_transient_network'") <
      catchBody.indexOf('captureException(error'),
    'transient network branch must run before captureException'
  );
});

test('recoverable submit failures (expected + server 5xx + transient + abort) are telemetry warnings, not Sentry exceptions', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // Existing expected-failure predicate stays intact.
  assert.match(src, /function isExpectedSubmitApiFailure\(error: unknown\): boolean/);
  assert.match(src, /error\.code === 'ROLE_FORBIDDEN'/);
  assert.match(src, /error\.code === 'CREDENTIALS_REQUIRED'/);

  // New broader predicate covers the failure classes that paged as hard errors
  // despite being recovered or server-side: 51 HTTP_500 (server fault), the
  // auto-stashed transient network deaths, and AbortError (Sentry RN-W).
  assert.match(src, /function isRecoverableSubmitFailure\(error: unknown\): boolean/);
  assert.match(src, /if \(isExpectedSubmitApiFailure\(error\)\) return true;/);
  assert.match(src, /if \(isTransientUploadError\(error\)\) return true;/);
  assert.match(src, /if \(getUploadPhase\(error\) === 'silent_check'\) return true;/);
  assert.match(src, /e\?\.status === 'number' && e\.status >= 500/);
  assert.match(src, /e\?\.name === 'AbortError' \|\| \/\\bAborted\\b\/i\.test/);

  // Severity + captureException guard both route through the broadened predicate.
  assert.match(src, /const isRecoverable = isRecoverableSubmitFailure\(error\);/);
  assert.match(src, /const telemetrySeverity = isRecoverable \? 'warning' : 'error';/);
  assert.match(src, /severity: telemetrySeverity,/);

  const severityIndex = src.indexOf('const isRecoverable = isRecoverableSubmitFailure(error);');
  assert.ok(severityIndex > -1, 'uploadSlot telemetry severity branch must be findable');
  const telemetryBody = src.slice(severityIndex, severityIndex + 2200);
  // reportClientError telemetry must still fire for every failure (server-500
  // visibility), only captureException is gated on isRecoverable.
  assert.match(telemetryBody, /reportClientError\(\{/);
  assert.match(telemetryBody, /if \(!isRecoverable\) \{\s*captureException\(error,/);
});

test('default-template SecureStore key uses an expo-secure-store-legal separator', async () => {
  const src = await read('src/lib/templatePreference.ts');

  // The ':' separator made every read/write/delete throw (Sentry RN-T,
  // op:getDefaultTemplateId) — expo-secure-store keys must match [A-Za-z0-9._-].
  assert.match(src, /return `\$\{KEY_PREFIX\}_\$\{userId\}`;/);
  assert.doesNotMatch(src, /\$\{KEY_PREFIX\}:\$\{userId\}/);

  // A concrete key built from a real UUID must satisfy the allowed charset.
  const sampleKey = `captivet_template_default_${'657f4d7c-bc17-4f79-a321-1653c9ac5feb'}`;
  assert.match(sampleKey, /^[A-Za-z0-9._-]+$/);
});

test('audio-session interruption on pause/resume is a warning breadcrumb, not a captureException', async () => {
  const src = await read('src/hooks/useAudioRecorder.ts');

  // Both catch blocks: a real error code (kills the no_code telemetry), warning
  // severity, and a breadcrumb instead of captureException so Sentry RN-X stops
  // surfacing an expected, fully-recovered native interruption as an error.
  for (const phase of ['recorder_resume', 'recorder_pause']) {
    const idx = src.indexOf(`errorCode: 'AUDIO_SESSION_INTERRUPTED',`, src.indexOf(`'${phase}'`));
    assert.ok(idx > -1, `${phase} interruption report must be findable`);
    const block = src.slice(idx - 600, idx + 120);
    assert.match(block, new RegExp(`breadcrumb\\('record', 'audio_session_interrupted', \\{\\s*phase: '${phase}'`));
    assert.match(block, /severity: 'warning',/);
    assert.match(block, /errorCode: 'AUDIO_SESSION_INTERRUPTED',/);
  }
  // Neither interruption path may captureException.
  assert.doesNotMatch(
    src,
    /captureException\(error, \{ tags: \{ component: 'useAudioRecorder', phase: 'recorder_(resume|pause)' \} \}\)/
  );
});

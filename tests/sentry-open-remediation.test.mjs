import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('draftStorage avoids self-copying durable draft segments and uses temp-copy replacement', async () => {
  const src = await read('src/lib/draftStorage.ts');

  assert.match(src, /function sameFileUri\(a: string, b: string\): boolean/);
  assert.match(src, /function copyFileReplacing\(sourceUri: string, destUri: string\): boolean/);
  assert.match(src, /if \(sameFileUri\(segment\.uri, destUri\)\)/);
  assert.match(src, /const tempUri = `\$\{destUri\}\.tmp-\$\{Date\.now\(\)\}`/);
  assert.match(src, /new ExpoFile\(sourceUri\)\.copy\(new ExpoFile\(tempUri\)\)/);
  assert.match(src, /new ExpoFile\(tempUri\)\.move\(new ExpoFile\(destUri\)\)/);
});

test('production API URL ignores missing or Railway fallback env values', async () => {
  const src = await read('src/config.ts');

  assert.match(src, /const CANONICAL_API_URL = 'https:\/\/api\.captivet\.com'/);
  assert.match(src, /const RAILWAY_FALLBACK_HOST = 'api-production-8e5e\.up\.railway\.app'/);
  assert.match(src, /function normalizeProductionApiUrl\(value: string \| undefined\): string/);
  assert.match(src, /parsed\.hostname === RAILWAY_FALLBACK_HOST/);
  assert.match(src, /: normalizeProductionApiUrl\(process\.env\.EXPO_PUBLIC_API_URL\)/);
});

test('auth init bounds getUser and refreshSession with watchdog operation labels', async () => {
  const src = await read('src/auth/AuthProvider.tsx');

  assert.match(
    src,
    /withTimeout\(\s*supabase\.auth\.getUser\(existingSession\.access_token\),\s*\d+,\s*'auth_init_get_user'\s*\)/
  );
  assert.match(
    src,
    /withTimeout\(\s*supabase\.auth\.refreshSession\(\),\s*\d+,\s*'auth_init_refresh_session'\s*\)/
  );
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

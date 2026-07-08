import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Records and Home auto-retry only retryable initial list load failures', async () => {
  const helper = await read('src/hooks/useRetryableInitialLoadError.ts');
  const records = await read('app/(app)/(tabs)/recordings/index.tsx');
  const home = await read('app/(app)/(tabs)/index.tsx');

  assert.match(helper, /INITIAL_LOAD_RETRY_DELAY_MS = 2500/);
  assert.match(helper, /captureMessage\('initial_list_load_failed', 'warning'/);
  assert.match(helper, /breadcrumb\('network', 'initial_list_load_retry_scheduled'/);
  assert.match(helper, /error\.isRetryable \|\| error\.status === 408 \|\| error\.status === 428 \|\| error\.status >= 500/);
  assert.doesNotMatch(helper, /error\.status === 401/);
  assert.doesNotMatch(helper, /error\.status === 403/);
  assert.match(helper, /refetch\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(helper, /retriedKeysRef/);

  for (const source of [records, home]) {
    assert.match(source, /useRetryableInitialLoadError/);
    assert.match(source, /useAuthDeviceRegistration/);
    assert.match(source, /const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock/);
    assert.match(source, /source: 'recordings'/);
    assert.match(source, /source: 'drafts'/);
  }

  assert.match(records, /screen: 'records'/);
  assert.match(records, /retryKey: recordingsRetryKey/);
  assert.match(home, /screen: 'home'/);
  assert.match(home, /retryKey: 'recent'/);
});

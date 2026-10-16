import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function sentryPluginBlock(config) {
  const start = config.indexOf("'@sentry/react-native/expo',");
  assert.notEqual(start, -1, '@sentry/react-native/expo must be registered');
  return config.slice(start, config.indexOf('],', start));
}

test('release builds upload Android native symbols and the R8 mapping (REACT-NATIVE-22)', () => {
  const block = sentryPluginBlock(read('app.config.ts'));
  for (const option of [
    'enableAndroidGradlePlugin: true',
    'uploadNativeSymbols: true',
    'autoUploadNativeSymbols: true',
    'includeProguardMapping: true',
    'autoUploadProguardMapping: true',
  ]) {
    assert.ok(block.includes(option), `missing ${option}`);
  }
  // The plugin writes an inline authToken into the app package; credentials
  // must stay in the EAS build environment (SENTRY_AUTH_TOKEN).
  assert.doesNotMatch(block, /authToken\s*:/);
});

test('local-test builds report to their own Sentry environment', () => {
  const config = read('app.config.ts');
  const monitoring = read('src/lib/monitoring.ts');
  const localId = monitoring.match(/const LOCAL_TEST_APPLICATION_ID = '([^']+)'/)?.[1];
  assert.equal(localId, 'com.captivet.mobile.local');
  // The id must be the one app.config.ts gives the local-test variant on both platforms.
  assert.ok(config.includes(`package: IS_LOCAL_TEST ? '${localId}'`));
  assert.ok(config.includes(`bundleIdentifier: IS_LOCAL_TEST\n        ? '${localId}'`));
  assert.match(
    monitoring,
    /environment: __DEV__\s*\? 'development'\s*: Application\.applicationId === LOCAL_TEST_APPLICATION_ID\s*\? 'local-test'\s*: 'production',/,
  );
});

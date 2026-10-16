import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HANDLED_CONFIG_CHANGES,
  mergeConfigChanges,
  applyConfigChanges,
} = require('../plugins/with-android-config-changes.js');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// What Expo SDK 55's prebuild template declares on MainActivity.
const SDK55_TEMPLATE =
  'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize';

test('handled changes cover what a clinic tablet produces in place (REACT-NATIVE-22)', () => {
  for (const flag of [
    'fontScale',
    'density',
    'fontWeightAdjustment',
    'locale',
    'layoutDirection',
    'navigation',
    'touchscreen',
    'colorMode',
  ]) {
    assert.ok(HANDLED_CONFIG_CHANGES.includes(flag), `${flag} must be handled`);
  }
});

test('merge keeps every template entry, appends the rest once, and is idempotent', () => {
  const merged = mergeConfigChanges(SDK55_TEMPLATE);
  assert.equal(merged, `${SDK55_TEMPLATE}|${HANDLED_CONFIG_CHANGES.join('|')}`);
  assert.equal(mergeConfigChanges(merged), merged);
  assert.equal(
    mergeConfigChanges(' fontScale| keyboard |'),
    ['fontScale', 'keyboard', ...HANDLED_CONFIG_CHANGES.filter((f) => f !== 'fontScale')].join('|'),
  );
  assert.equal(mergeConfigChanges(undefined), HANDLED_CONFIG_CHANGES.join('|'));
});

test('only MainActivity changes, and a missing MainActivity fails the prebuild', () => {
  const manifest = {
    manifest: {
      application: [
        {
          activity: [
            { $: { 'android:name': '.OtherActivity', 'android:configChanges': 'orientation' } },
            { $: { 'android:name': '.MainActivity', 'android:configChanges': SDK55_TEMPLATE } },
          ],
        },
      ],
    },
  };
  applyConfigChanges(manifest);
  const [other, main] = manifest.manifest.application[0].activity;
  assert.equal(other.$['android:configChanges'], 'orientation');
  assert.equal(main.$['android:configChanges'], mergeConfigChanges(SDK55_TEMPLATE));

  assert.throws(
    () => applyConfigChanges({ manifest: { application: [{ activity: [] }] } }),
    /with-android-config-changes: no \.MainActivity/,
  );
  assert.throws(() => applyConfigChanges({}), /with-android-config-changes/);
});

test('the plugin is registered in app.config.ts', () => {
  assert.match(read('app.config.ts'), /'\.\/plugins\/with-android-config-changes'/);
});

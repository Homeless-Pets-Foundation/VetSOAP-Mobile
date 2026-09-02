import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

// Manage Devices row copy (layout tier 3, 2026-09-02). The Chrome extension
// registers as "Chrome Extension · <platform> · <shortId>", and the row title
// truncated exactly the part that told two extension installs apart.

const load = () => loadTsModule('src/lib/deviceDisplay.ts');

test('splitDeviceName moves the distinguishing tail into the title', async () => {
  const { splitDeviceName } = await load();
  assert.deepEqual(
    { ...splitDeviceName('Chrome Extension · Windows · 3f9a2b1c', 'Web Browser') },
    { title: 'Windows · 3f9a2b1c', subtitleHead: 'Chrome Extension' }
  );
});

test('splitDeviceName leaves a plain device name alone', async () => {
  const { splitDeviceName } = await load();
  assert.deepEqual(
    { ...splitDeviceName('Pixel 10 Pro XL', 'Android Phone') },
    { title: 'Pixel 10 Pro XL', subtitleHead: 'Android Phone' }
  );
  assert.deepEqual(
    { ...splitDeviceName(null, 'iPad') },
    { title: 'iPad', subtitleHead: 'iPad' }
  );
  assert.deepEqual(
    { ...splitDeviceName('  ', 'Device') },
    { title: 'Device', subtitleHead: 'Device' }
  );
});

test('formatDeviceTypeLabel keeps the four-way phone/tablet mapping (rule 23)', async () => {
  const { formatDeviceTypeLabel } = await load();
  assert.equal(formatDeviceTypeLabel('ios_tablet'), 'iPad');
  assert.equal(formatDeviceTypeLabel('ios_phone'), 'iPhone');
  assert.equal(formatDeviceTypeLabel('android_tablet'), 'Android Tablet');
  assert.equal(formatDeviceTypeLabel('android_phone'), 'Android Phone');
  assert.equal(formatDeviceTypeLabel('web'), 'Web Browser');
  assert.equal(formatDeviceTypeLabel(null), 'Device');
  assert.equal(formatDeviceTypeLabel('kiosk'), 'kiosk');
});

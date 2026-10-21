// AppLockGuard must lock with an OVERLAY once the signed-in tree has been
// shown. The shipped behaviour returned the lock screen INSTEAD of
// `children` on a resume re-lock, which unmounted the whole (app) stack: a
// screen-off recording was stopped the moment the vet unlocked to finish it,
// and unsaved SOAP edits / navigation position were lost.
//
// The component is .tsx (not loadable by loadTs), so its structure is fenced
// by source; the pure lock flag is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the lock screen replaces children only before the first reveal', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /if \(!hasRevealed && isLocked\) return lockScreen;/);
  assert.doesNotMatch(
    src,
    /if \(isLocked\) \{?\s*return/,
    'an ungated `if (isLocked) return …` unmounts the signed-in tree on re-lock',
  );
});

test('after the reveal, children stay mounted under an overlay', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  const tail = src.slice(src.indexOf('if (!hasRevealed && isLocked) return lockScreen;'));
  assert.match(tail, /\{children\}/, 'children render in the post-reveal branch');
  assert.match(tail, /\{isLocked \? \(/, 'the lock is a conditional overlay sibling');
  assert.match(tail, /StyleSheet\.absoluteFill/);
  assert.doesNotMatch(tail, /<>\{children\}<\/>/, 'a second wrapper shape would remount on reveal');
});

test('the covered tree is hidden from touch and screen readers while locked', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /pointerEvents=\{isLocked \? 'none' : 'auto'\}/);
  assert.match(src, /importantForAccessibility=\{isLocked \? 'no-hide-descendants' : 'auto'\}/);
  assert.match(src, /accessibilityElementsHidden=\{isLocked\}/);
  assert.match(src, /accessibilityViewIsModal/);
});

test('Android back is swallowed while the overlay is up', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /BackHandler\.addEventListener\('hardwareBackPress', \(\) => true\)/);
});

test('the background threshold allows a trip to the PIMS without a prompt', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  const m = src.match(/BACKGROUND_LOCK_THRESHOLD_MS = ([\d_]+);/);
  assert.ok(m, 'threshold constant present');
  assert.ok(Number(m[1].replace(/_/g, '')) >= 120_000);
});

test('ui/Sheet hides its Modal while the app is locked', async () => {
  const src = await read('src/components/ui/Sheet.tsx');
  assert.match(src, /visible=\{visible && !appLocked\}/);
});

test('appLockState notifies subscribers once per change and survives a throwing one', async () => {
  const { appLockState } = await loadTsModule('src/lib/appLockState.ts');
  const seen = [];
  const unsubBad = appLockState.subscribe(() => {
    throw new Error('broken subscriber');
  });
  const unsub = appLockState.subscribe((v) => seen.push(v));
  appLockState.setLocked(true);
  appLockState.setLocked(true);
  appLockState.setLocked(false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(appLockState.isLocked(), false);
  unsub();
  unsubBad();
  appLockState.setLocked(true);
  assert.deepEqual(seen, [true, false]);
});

test('the lock is published before the locked frame paints, and Sheets vanish without sliding', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(
    src,
    /useLayoutEffect\(\(\) => \{\s*appLockState\.setLocked\(isLocked && hasRevealed\);/,
    'a passive effect leaves an open Sheet Modal above the lock for a frame',
  );
  const sheet = await read('src/components/ui/Sheet.tsx');
  assert.match(sheet, /animationType=\{appLocked \? 'none' : 'slide'\}/);
});

test('the lock screen never says a paused session is still recording', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /capturing \? APP_LOCK_COPY\.recordingContinues : APP_LOCK_COPY\.recordingPaused/);
  assert.match(src, /recordingActivity\.subscribeCapturing\(setCapturing\)/);
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(
    record,
    /const shouldStayAwake = recorder\.state === 'recording';\s*recordingActivity\.setCapturing\(shouldStayAwake\);/,
    'capture flag follows the actual recorder state, not recorder ownership',
  );
});

test('recordingActivity keeps capture separate from ownership', async () => {
  const { recordingActivity } = await loadTsModule('src/lib/recordingActivity.ts');
  const captures = [];
  const owned = [];
  recordingActivity.subscribeCapturing((v) => captures.push(v));
  recordingActivity.subscribe((v) => owned.push(v));
  recordingActivity.setActive(true); // recording
  recordingActivity.setCapturing(true);
  recordingActivity.setCapturing(false); // paused: still owned
  assert.equal(recordingActivity.isActive(), true);
  assert.equal(recordingActivity.isCapturing(), false);
  assert.deepEqual(captures, [true, false]);
  assert.deepEqual(owned, [true]);
});

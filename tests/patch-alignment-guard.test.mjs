// patch-package is VERSION-BLIND, and that silence is a native-behavior hazard.
//
// patch-package selects a patch by package PATH, never by version. A patch
// whose filename names an older version is still applied to whatever is
// installed; if the hunks happen to apply, it prints a warning and exits 0.
// `--error-on-fail` does not change that — it only fires when a hunk fails.
//
// Both patches here carry NATIVE Kotlin/Gradle behavior that no typecheck and
// no Node test can observe at runtime:
//   - expo-audio: the parallelized foreground-service binding that cuts legacy
//     Android recorder start latency, the binder-assignment reorder that keeps
//     the new parallel await off a null binder, and the constant-bitrate
//     seeking that makes durable ADTS AAC seekable on Android.
//   - ffmpeg-kit-react-native: the AAR override onto the self-hosted 16KB
//     page-size build.
//
// package.json declares `~55.0.16` and `^6.0.2`; both ranges admit newer
// versions (55.0.18 is published). Nothing else compares a patch filename to
// the version that will actually install — tests/legacy-android-recorder-
// latency.test.mjs checks the APPLIED RESULT and stays green against a
// stale-but-still-applying patch, and tests/audio-player-duration.test.mjs
// hardcodes the filename, so a RENAME breaks it but a version bump without a
// rename does not: exactly the dangerous direction.
//
// This guard makes that drift a red check instead of a warning nobody reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

/**
 * `<pkg>+<version>.patch`, split on the LAST '+' so a future scoped package
 * (`@scope+name+1.2.3.patch`) parses correctly.
 */
function parsePatchName(fileName) {
  const stem = fileName.replace(/\.patch$/, '');
  const split = stem.lastIndexOf('+');
  assert.ok(split > 0, `unparseable patch filename: ${fileName}`);
  return {
    pkg: stem.slice(0, split).replace(/\+/g, '/'),
    version: stem.slice(split + 1),
  };
}

async function listPatches() {
  const entries = await readdir(new URL('patches/', root));
  return entries.filter((name) => name.endsWith('.patch')).sort();
}

test('every patch names the version that will actually be installed', async () => {
  const [patchFiles, pkgRaw, lockRaw] = await Promise.all([
    listPatches(),
    read('package.json'),
    read('package-lock.json'),
  ]);
  assert.ok(patchFiles.length > 0, 'patches/ is empty — did a patch get dropped?');

  const pkg = JSON.parse(pkgRaw);
  const lock = JSON.parse(lockRaw);
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };

  for (const file of patchFiles) {
    const { pkg: name, version } = parsePatchName(file);

    // The lock is what `npm ci` installs, so this is the assertion that fires
    // on a lock refresh — the quiet path that would otherwise land 55.0.16-era
    // Kotlin on newer source.
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    assert.equal(
      locked,
      version,
      `${file} targets ${version} but package-lock.json resolves ${name}@${locked}. ` +
        `Regenerate the patch against the installed version and rename the file.`,
    );

    // Catch a declared bump before the lock even refreshes.
    const range = declared[name];
    assert.ok(range, `${name} is patched but not declared in package.json`);
    assert.equal(
      range.replace(/^[~^]/, ''),
      version,
      `${file} targets ${version} but package.json declares ${name}@${range}.`,
    );
  }
});

test('the set of patched packages is the one this guard was written for', async () => {
  // Deliberately exact. A new patch inherits none of the reasoning above, so it
  // must arrive with a conscious update here rather than silently joining a
  // fence that was never checked against it.
  const patched = (await listPatches()).map((file) => parsePatchName(file).pkg);
  assert.deepEqual(patched.sort(), ['expo-audio', 'ffmpeg-kit-react-native']);
});

test('the ffmpeg AAR override is actually applied in node_modules', async () => {
  // Nothing covered this before. The expected version is parsed OUT OF THE
  // PATCH so bumping the AAR cannot leave a stale literal behind here.
  const patch = await read('patches/ffmpeg-kit-react-native+6.0.2.patch');
  const wanted = [
    ...patch.matchAll(/^\+ffmpegKit\.android\.(main|lts)\.version=(.+)$/gm),
  ];
  assert.equal(wanted.length, 2, 'the ffmpeg patch no longer sets both AAR versions');

  const applied = await read('node_modules/ffmpeg-kit-react-native/android/gradle.properties');
  for (const [, channel, version] of wanted) {
    assert.match(
      applied,
      new RegExp(`^ffmpegKit\\.android\\.${channel}\\.version=${version.trim()}$`, 'm'),
      `ffmpeg ${channel} AAR override is not applied in node_modules — ` +
        `postinstall/patch-package did not run, or the patch silently failed.`,
    );
  }
});

test('the expo-audio constant-bitrate seeking hunk is applied in node_modules', async () => {
  // tests/audio-player-duration.test.mjs asserts this hunk in the PATCH FILE;
  // tests/legacy-android-recorder-latency.test.mjs asserts the other two hunks
  // in node_modules. This is the one that was checked nowhere on disk — and it
  // is what makes durable ADTS AAC seekable on Android.
  const applied = await read(
    'node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt',
  );
  assert.match(applied, /import androidx\.media3\.extractor\.DefaultExtractorsFactory/);
  assert.match(applied, /setConstantBitrateSeekingEnabled\(true\)/);
  assert.match(applied, /setConstantBitrateSeekingAlwaysEnabled\(true\)/);
});

test('postinstall applies patches and fails the install when a hunk will not apply', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.match(pkg.scripts.postinstall, /^patch-package\b/);
  // Makes a local install fail the way CI already does. It does NOT cover the
  // version-mismatch case above — that is what this file's first test is for.
  assert.match(pkg.scripts.postinstall, /--error-on-fail/);
  // The expo-audio patch is Kotlin: without buildFromSource the patched source
  // is ignored in favour of a prebuilt AAR and the fixes never ship.
  assert.deepEqual(pkg.expo?.autolinking?.android?.buildFromSource, ['expo-audio']);
});

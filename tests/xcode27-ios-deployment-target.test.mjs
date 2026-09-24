// Xcode 27 guard: iOS builds only compile when BOTH halves of the deployment-
// target fix are in place.
//
//   1. plugins/with-min-pod-deployment-target.js raises every pod target to 16.0
//      in the Podfile's post_install. Without it, pods still declaring iOS 9.0
//      (SDWebImage, RNSVG, Sentry, GoogleSignIn, ...) are a hard Xcode 27 error.
//   2. expo-build-properties ios.deploymentTarget is '16.0'. At 15.1 the app
//      target cannot import the 16.0 `Expo` module, and expo-router 55.0.18
//      uses UIAction.subtitle (iOS 16+) unguarded.
//
// The two values must agree, and the plugin must stay registered right after
// the ffmpeg pod-source plugin (outside the Google-only block, so every build
// gets it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const require = createRequire(root);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

const plugin = require('./plugins/with-min-pod-deployment-target.js');

test('app.config.ts pins the iOS deployment target to 16.0', async () => {
  const cfg = await read('app.config.ts');
  const targets = [...cfg.matchAll(/deploymentTarget:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['16.0']);
  assert.equal(plugin.MIN_POD_DEPLOYMENT_TARGET, '16.0', 'pod floor must match the app target');
});

test('min-pod-deployment-target plugin is registered right after the ffmpeg pod source', async () => {
  const cfg = await read('app.config.ts');
  assert.match(
    cfg,
    /'\.\/plugins\/with-ffmpeg-ios-pod-source\.js',\s*(?:\/\/[^\n]*\n\s*)*'\.\/plugins\/with-min-pod-deployment-target\.js',/,
  );
  const googleBlock = cfg.slice(cfg.indexOf('if (process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME)'));
  assert.doesNotMatch(googleBlock, /with-min-pod-deployment-target/, 'must apply to every iOS build');
});

const PODFILE = [
  "target 'Captivet' do",
  '  use_native_modules!',
  '  post_install do |installer|',
  '    react_native_post_install(installer)',
  '  end',
  'end',
  '',
].join('\n');

test('plugin injects a raise-only loop inside post_install, idempotently', () => {
  const once = plugin.injectMinPodDeploymentTarget(PODFILE);
  const lines = once.split('\n');
  const anchor = lines.findIndex((l) => l.includes('post_install do |installer|'));
  assert.match(lines[anchor + 1], /@generated begin min-pod-deployment-target/);
  assert.match(once, /Gem::Version\.new\(current\) < Gem::Version\.new\('16\.0'\)/);
  assert.match(once, /build_settings\['IPHONEOS_DEPLOYMENT_TARGET'\] = '16\.0'/);
  assert.ok(once.indexOf('min-pod-deployment-target') < once.indexOf('react_native_post_install'));
  assert.equal(plugin.injectMinPodDeploymentTarget(once), once, 're-running prebuild must not duplicate');
});

test('plugin throws when the post_install anchor is missing', () => {
  assert.throws(
    () => plugin.injectMinPodDeploymentTarget("target 'Captivet' do\nend\n"),
    /post_install do \|installer\|/,
  );
});

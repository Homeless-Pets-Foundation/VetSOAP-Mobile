import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { injectSceneLifecycle, applySceneManifest } = require('../plugins/with-ios-scene-lifecycle.js');
const template = readFileSync(new URL('./fixtures/expo-sdk55-app-delegate.swift', import.meta.url), 'utf8');

test('SDK 55 startup moves to its scene and survives repeated prebuild', () => {
  const migrated = injectSceneLifecycle(template);
  assert.doesNotMatch(migrated, /UIWindow\(frame: UIScreen/);
  assert.equal((migrated.match(/factory.startReactNative\(/g) ?? []).length, 1);
  assert.match(migrated, /UIWindow\(windowScene: windowScene\)/);
  assert.match(migrated, /existing.windowScene = windowScene/);
  assert.match(migrated, /self.scene\(scene, openURLContexts: connectionOptions.urlContexts\)/);
  assert.match(migrated, /self.scene\(scene, continue: activity\)/);
  assert.equal(injectSceneLifecycle(migrated), migrated);
});

test('unexpected native startup or partially changed scene wiring fails explicitly', () => {
  assert.throws(() => injectSceneLifecycle(template.replace('in: window,', 'in: customWindow,')), /refusing/);
  assert.throws(() => injectSceneLifecycle(template.replace('RCTReactNativeFactory?', 'CustomFactory?')), /refusing/);
  assert.throws(() => injectSceneLifecycle(injectSceneLifecycle(template).replace('sceneDidBecomeActive', 'customDidBecomeActive')), /differs/);
});

test('manifest registers one scene and preserves unrelated plist values', () => {
  const info = applySceneManifest({ CFBundleName: 'Synthetic', UIBackgroundModes: ['audio'] });
  assert.deepEqual(info.UIBackgroundModes, ['audio']);
  assert.equal(info.CFBundleName, 'Synthetic');
  assert.equal(info.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes, false);
  assert.equal(info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).CaptivetSceneDelegate');
  assert.deepEqual(applySceneManifest(info), info);
  const reordered = { ...info, UIApplicationSceneManifest: {
    UISceneConfigurations: info.UIApplicationSceneManifest.UISceneConfigurations,
    UIApplicationSupportsMultipleScenes: false,
  } };
  assert.deepEqual(applySceneManifest(reordered), info);
  assert.throws(() => applySceneManifest({ UIApplicationSceneManifest: { custom: true } }), /different scene manifest/);
});

test('cold links populate RN launch options while warm links use the existing app delegate', () => {
  const migrated = injectSceneLifecycle(template);
  const cold = migrated.slice(migrated.indexOf('class CaptivetSceneDelegate'), migrated.indexOf('func scene(_ scene: UIScene, openURLContexts'));
  assert.match(cold, /launchOptions\[\.url\] = context.url/);
  assert.match(cold, /UIApplicationLaunchOptionsUserActivityTypeKey/);
  assert.match(cold, /UIApplicationLaunchOptionsUserActivityKey/);
  assert.match(cold, /ExpoAppDelegateSubscriberManager.application/);
  assert.doesNotMatch(cold, /RCTLinkingManager\.application|appDelegate\?\.application\(/);
  assert.match(migrated, /openURLContexts[\s\S]*appDelegate\?\.application/);
  for (const method of ['applicationDidBecomeActive','applicationWillResignActive','applicationDidEnterBackground','applicationWillEnterForeground']) {
    assert.ok(migrated.includes(`appDelegate?.${method}(UIApplication.shared)`));
  }
  assert.doesNotMatch(migrated, /NotificationCenter.default.post/);
});

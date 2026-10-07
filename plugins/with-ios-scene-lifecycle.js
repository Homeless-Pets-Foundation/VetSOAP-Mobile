// SDK 55 has no scene delegate. iOS 27 rejects its legacy window lifecycle.
// Keep this compatibility plugin until a coordinated Expo upgrade supplies one.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');

const MARKER = '// Captivet SDK 55 scene lifecycle';
const LEGACY_STARTUP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;
const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Default Configuration',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).CaptivetSceneDelegate',
    }],
  },
};

function injectSceneLifecycle(source) {
  const scene = fs.readFileSync(path.join(__dirname, 'captivet-scene-delegate.swift'), 'utf8');
  if (source.includes(MARKER)) {
    if (!source.includes(scene) || source.includes(LEGACY_STARTUP)) {
      throw new Error('with-ios-scene-lifecycle: existing scene wiring differs; review the native template.');
    }
    return source;
  }
  const anchor = '  var reactNativeFactory: RCTReactNativeFactory?';
  if (!source.includes('class AppDelegate: ExpoAppDelegate {') ||
      source.split(LEGACY_STARTUP).length !== 2 || source.split(anchor).length !== 2 ||
      source.includes('SceneDelegate') || source.includes('configurationForConnecting')) {
    throw new Error('with-ios-scene-lifecycle: expected SDK 55 AppDelegate template; refusing to overwrite custom startup.');
  }
  return source
    .replace('import React\n', 'import React\ninternal import ExpoModulesCore\n')
    .replace(anchor, `${anchor}\n  var captivetLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?`)
    .replace(LEGACY_STARTUP, '    captivetLaunchOptions = launchOptions') + `\n${MARKER}\n${scene}`;
}

function applySceneManifest(info) {
  const existing = info.UIApplicationSceneManifest;
  if (existing && !isDeepStrictEqual(existing, SCENE_MANIFEST)) {
    throw new Error('with-ios-scene-lifecycle: a different scene manifest exists; review it before migration.');
  }
  return { ...info, UIApplicationSceneManifest: SCENE_MANIFEST };
}

module.exports = function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, config => {
    config.modResults = applySceneManifest(config.modResults);
    return config;
  });
  return withAppDelegate(config, config => {
    if (config.modResults.language !== 'swift') {
      throw new Error('with-ios-scene-lifecycle: Swift AppDelegate required.');
    }
    config.modResults.contents = injectSceneLifecycle(config.modResults.contents);
    return config;
  });
};
module.exports.injectSceneLifecycle = injectSceneLifecycle;
module.exports.applySceneManifest = applySceneManifest;

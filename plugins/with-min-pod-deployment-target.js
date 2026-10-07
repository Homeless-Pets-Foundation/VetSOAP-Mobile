// Expo config plugin: raise every CocoaPods target's IPHONEOS_DEPLOYMENT_TARGET
// to the app's minimum iOS version when the pod declares something lower.
//
// Why: Xcode 27 turned stale pod deployment targets into HARD errors. Several
// pods still declare iOS 9.0 in their podspecs (SDWebImage, RNCAsyncStorage,
// GTMAppAuth, AppAuth, GTMSessionFetcher, RNSVG, Sentry, PromisesObjC,
// GoogleSignIn, GoogleUtilities) and the build fails with:
//
//   The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to
//   9.0, but the range of supported deployment target versions is 15.0 to 27.0.x
//
// React Native's own post_install (ReactNativePodsUtils.updateOSDeploymentTarget)
// only raises pod targets that CocoaPods reports through
// target_installation_results, and only to RN's floor (15.1). 15.1 is not enough
// either: expo-router 55.0.18 (the newest SDK 55 release) calls UIAction.subtitle
// (iOS 16+) in LinkPreviewNativeActionView.swift without an availability guard.
// So pods AND the app target (expo-build-properties ios.deploymentTarget in
// app.config.ts) are both pinned to 16.0 — the app target must match, or Xcode
// rejects importing the 16.0 `Expo` module from a 15.1 app.
// tests/xcode27-ios-deployment-target.test.mjs asserts the two values agree.
//
// Only RAISES targets; a pod that already declares a higher minimum is left
// alone, and RN's own step only ever raises too, so ordering inside
// post_install does not matter. Symmetric with plugins/with-ios-modular-headers.js.
// Throws if the Podfile has no `post_install do |installer|` anchor rather than
// silently producing a Podfile that fails under Xcode 27.

const { withDangerousMod } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const MIN_POD_DEPLOYMENT_TARGET = '16.0';
const POST_INSTALL_ANCHOR = /^\s*post_install do \|installer\|/;

const POST_INSTALL_LINES = [
  '    installer.pods_project.targets.each do |target|',
  '      target.build_configurations.each do |build_config|',
  "        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
  `        if current && Gem::Version.new(current) < Gem::Version.new('${MIN_POD_DEPLOYMENT_TARGET}')`,
  `          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_POD_DEPLOYMENT_TARGET}'`,
  '        end',
  '      end',
  '    end',
].join('\n');

function injectMinPodDeploymentTarget(src) {
  if (!src.split('\n').some((line) => POST_INSTALL_ANCHOR.test(line))) {
    throw new Error(
      'with-min-pod-deployment-target: `post_install do |installer|` not found in the Podfile. ' +
        'Pods with stale deployment targets fail to compile under Xcode 27 — update this plugin\'s anchor.',
    );
  }
  return mergeContents({
    tag: 'min-pod-deployment-target',
    src,
    newSrc: POST_INSTALL_LINES,
    anchor: POST_INSTALL_ANCHOR,
    offset: 1,
    comment: '#',
  }).contents;
}

function withMinPodDeploymentTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfile = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      const contents = await fs.promises.readFile(podfile, 'utf8');
      await fs.promises.writeFile(podfile, injectMinPodDeploymentTarget(contents), 'utf8');
      return config;
    },
  ]);
}

module.exports = withMinPodDeploymentTarget;
module.exports.MIN_POD_DEPLOYMENT_TARGET = MIN_POD_DEPLOYMENT_TARGET;
module.exports.injectMinPodDeploymentTarget = injectMinPodDeploymentTarget;

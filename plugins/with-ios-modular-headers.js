// Expo config plugin: force modular headers for the non-modular CocoaPods that
// GoogleSignIn's transitive Swift dependency (AppCheckCore) imports.
//
// Why: @react-native-google-signin/google-signin (16.x) pulls GoogleSignIn 9.x,
// which depends on AppCheckCore — a Swift pod. With the React Native static-
// library framework build (the default on iOS here), CocoaPods refuses to
// integrate the Swift pod unless its non-modular transitive deps build module
// maps, so `pod install` fails the build:
//
//   [!] The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and
//       `RecaptchaInterop`, which do not define modules. To opt into those
//       targets generating module maps ... specify `:modular_headers => true`
//       for particular dependencies.
//
// Expo autolinking already enables modular headers for `GoogleSignIn` itself,
// but not these transitive deps. Declaring them at the Podfile level with
// :modular_headers => true overrides the transitive setting. Symmetric with
// plugins/with-ffmpeg-ios-pod-source.js. Only registered (in app.config.ts)
// when the Google Sign-In plugin is active, so non-Google builds don't pull
// these pods in unnecessarily.

const { withDangerousMod } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const POD_LINES = [
  "  pod 'GoogleUtilities', :modular_headers => true",
  "  pod 'RecaptchaInterop', :modular_headers => true",
].join('\n');

function injectModularHeaders(src) {
  return mergeContents({
    tag: 'google-signin-modular-headers',
    src,
    newSrc: POD_LINES,
    anchor: /use_native_modules/,
    offset: 0,
    comment: '#',
  }).contents;
}

module.exports = function withIosModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfile = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile',
      );
      const contents = await fs.promises.readFile(podfile, 'utf8');
      await fs.promises.writeFile(
        podfile,
        injectModularHeaders(contents),
        'utf8',
      );
      return config;
    },
  ]);
};

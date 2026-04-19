// Expo config plugin: override CocoaPods trunk resolution of
// `ffmpeg-kit-ios-min` with a self-hosted podspec URL.
//
// Why: arthenica/ffmpeg-kit sunset the iOS release artifacts that the
// CocoaPods trunk podspec fetches from GitHub Releases, so every fresh
// `pod install` 404s on the xcframework zip. Symmetric with the existing
// self-hosted Android Maven repo wired via `extraMavenRepos` in
// app.config.ts. See docs/ios-build-prep-2026-04-18.md § "ffmpeg-kit iOS
// pod risk" for the mitigation rationale.
//
// Mechanics: inject `pod 'ffmpeg-kit-ios-min', :podspec => 'URL'` into
// the Podfile just before `use_native_modules`. CocoaPods treats a
// Podfile-level pod declaration with an explicit :podspec override as
// the authoritative source for that pod, satisfying the transitive
// `s.dependency 'ffmpeg-kit-ios-min', "6.0"` from the npm package.

const { withDangerousMod } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const DEFAULT_PODSPEC_URL =
  'https://homeless-pets-foundation.github.io/ffmpeg-kit-maven/ios/ffmpeg-kit-ios-min.podspec.json';

function injectSelfHostedPodSource(src, podspecUrl) {
  return mergeContents({
    tag: 'ffmpeg-kit-ios-min-selfhost',
    src,
    newSrc: `  pod 'ffmpeg-kit-ios-min', :podspec => '${podspecUrl}'`,
    anchor: /use_native_modules/,
    offset: 0,
    comment: '#',
  }).contents;
}

module.exports = function withFfmpegIosPodSource(config, props = {}) {
  const podspecUrl = props.podspecUrl || DEFAULT_PODSPEC_URL;
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
        injectSelfHostedPodSource(contents, podspecUrl),
        'utf8',
      );
      return config;
    },
  ]);
};

// Expo config plugin: let MainActivity absorb display/locale/input configuration
// changes instead of being destroyed and recreated.
//
// Why: Sentry REACT-NATIVE-22 (fatal ANR, 2026-10-05, SM-T220, 1.13.21+101).
// Breadcrumbs show MainActivity paused → saveInstanceState → destroyed → created
// within one second: a configuration change Expo's template does not declare
// recreated the Activity. React Native then started a fresh surface and the whole
// tree re-mounted (registerDevice, fetchUser and the durable recovery scan all
// re-ran in the breadcrumbs — a remount also discards the record screen's
// in-memory session state), and the main thread froze in Fabric's Yoga layout
// (SurfaceHandler::constraintLayout → ShadowTree::tryCommit → layoutTree) on a
// Galaxy Tab A7 Lite. That ANR killed a capture in progress: the next launch
// reported capture_ended_without_cleanup (REACT-NATIVE-1X) for the same minute.
//
// Expo SDK 55's template declares only
// keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize.
// The additions below are the remaining changes a clinic tablet can produce
// without the user leaving the app: font size, display size, Bold text, locale /
// RTL, a keyboard cover (navigation/touchscreen alongside the already-declared
// keyboard), and wide-gamut color mode.
//
// React Native 0.83 handles these in place: ReactActivity forwards
// onConfigurationChanged to ReactHostImpl, which re-reads DisplayMetrics and
// re-lays-out every attached surface when the font scale changed
// (enableFontScaleChangesUpdatingLayout, default true), DeviceInfoModule emits
// didUpdateDimensions, and AppearanceModule receives the new configuration.
// Bold text (fontWeightAdjustment) has no React Native support either way — see
// CLAUDE.md "UI Gotchas": Yoga always measures with the unadjusted font, so
// layout headroom is the fix whether or not the Activity is recreated.
//
// fontWeightAdjustment (API 31) and colorMode (API 26) are resolved by aapt2
// against compileSdk, not minSdk; older devices simply never deliver them.
//
// Written as a plugin because android/ is not committed (EAS managed build).

const { withAndroidManifest } = require('expo/config-plugins');

const PLUGIN_NAME = 'with-android-config-changes';

const HANDLED_CONFIG_CHANGES = [
  'fontScale',
  'density',
  'locale',
  'layoutDirection',
  'navigation',
  'fontWeightAdjustment',
  'colorMode',
  'touchscreen',
];

/** Union of the existing configChanges value and the additions; never drops an entry. */
function mergeConfigChanges(existing, additions = HANDLED_CONFIG_CHANGES) {
  const merged = [];
  for (const value of [...String(existing ?? '').split('|'), ...additions]) {
    const flag = value.trim();
    if (flag && !merged.includes(flag)) merged.push(flag);
  }
  return merged.join('|');
}

/** Applies the merge to MainActivity in a parsed AndroidManifest; throws if it is missing. */
function applyConfigChanges(manifest) {
  const activities = manifest?.manifest?.application?.[0]?.activity;
  const mainActivity = Array.isArray(activities)
    ? activities.find((activity) => activity?.$?.['android:name'] === '.MainActivity')
    : undefined;
  if (!mainActivity) {
    throw new Error(`${PLUGIN_NAME}: no .MainActivity in AndroidManifest.xml`);
  }
  mainActivity.$['android:configChanges'] = mergeConfigChanges(
    mainActivity.$['android:configChanges'],
  );
  return manifest;
}

const withAndroidConfigChanges = (config) =>
  withAndroidManifest(config, (cfg) => {
    applyConfigChanges(cfg.modResults);
    return cfg;
  });

module.exports = withAndroidConfigChanges;
module.exports.HANDLED_CONFIG_CHANGES = HANDLED_CONFIG_CHANGES;
module.exports.mergeConfigChanges = mergeConfigChanges;
module.exports.applyConfigChanges = applyConfigChanges;

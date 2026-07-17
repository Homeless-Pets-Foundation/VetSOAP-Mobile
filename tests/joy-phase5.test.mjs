import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function readPngDimensions(path) {
  const png = await readFile(new URL(path, root));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('processing stepper is extracted and uses warmth plus paw steps', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const stepper = await read('src/components/ProcessingStepper.tsx');
  const strings = await read('src/constants/strings.ts');

  assert.match(detail, /from '..\/..\/..\/..\/src\/components\/ProcessingStepper'/);
  assert.doesNotMatch(detail, /function ProcessingStepper/);
  assert.match(stepper, /PawPrint/);
  assert.match(stepper, /PROCESSING_WARMTH/);
  assert.match(strings, /PROCESSING_WARMTH/);
});

test('review workflow is wired through list filter, card chip, detail toggle, and API', async () => {
  const api = await read('src/api/recordings.ts');
  const list = await read('app/(app)/(tabs)/recordings/index.tsx');
  const card = await read('src/components/RecordingCard.tsx');
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const types = await read('src/types/index.ts');

  assert.match(types, /ReviewStatus = 'needs_review' \| 'reviewed'/);
  assert.match(api, /reviewStatus\?: ReviewStatus/);
  assert.match(api, /patch\(`\/api\/recordings\/\$\{recordingId\}\/review`/);
  assert.match(list, /value: 'needs_review'/);
  // WP22: the Needs Review option is always present — visibility no longer
  // shifts with which pages happen to be loaded.
  assert.match(list, /NEEDS_REVIEW_STATUS_FILTER_OPTION/);
  assert.match(list, /options=\{statusFilterOptions\}/);
  assert.match(list, /reviewStatus: reviewStatusFilter/);
  assert.match(card, /ReviewStatusChip/);
  assert.match(detail, /ReviewStatusChip/);
});

test('home shows recent patient AI summary from existing patient API', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');

  assert.match(home, /patientsApi\.get\(recentPatientId!\)/);
  assert.match(home, /aiHistorySummary/);
  assert.match(home, /Recent patient/);
  assert.match(home, /Read more/);
});

test('home keeps Captivet branding above its personalized greeting', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  const brandIndex = home.indexOf("source={require('../../../assets/logo-wordmark.png')}");
  const greetingIndex = home.indexOf('Welcome{user?.fullName');

  assert.notEqual(brandIndex, -1, 'home should render the Captivet wordmark');
  assert.notEqual(greetingIndex, -1, 'home should keep the personalized greeting');
  assert.ok(brandIndex < greetingIndex, 'brand row should appear above the greeting');
  assert.match(home, /accessibilityLabel="Captivet"/);
  assert.match(home, /Math\.min\(scale\(132\), 168\)/);
  assert.match(home, /router\.push\('\/settings'\)/);
});

test('wordmark density assets match the largest 320dp runtime treatment', async () => {
  const generator = await read('scripts/generate-icons.mjs');

  assert.deepEqual(await readPngDimensions('assets/logo-wordmark.png'), [320, 74]);
  assert.deepEqual(await readPngDimensions('assets/logo-wordmark@2x.png'), [640, 149]);
  assert.deepEqual(await readPngDimensions('assets/logo-wordmark@3x.png'), [960, 223]);
  assert.match(generator, /const w1x = 320/);
  assert.match(generator, /const w2x = 640/);
  assert.match(generator, /const w3x = 960/);
});

test('startup branding expands to near-2x without exceeding the Android splash safe zone', async () => {
  const config = await read('app.config.ts');
  const rootLayout = await read('app/_layout.tsx');

  assert.match(config, /'expo-splash-screen'/);
  assert.match(config, /image: '\.\/assets\/logo-wordmark@3x\.png'/);
  assert.match(config, /imageWidth: 320/);
  assert.match(config, /android: \{\s*imageWidth: 184/);
  assert.doesNotMatch(config, /^\s+splash:\s*\{/m);

  assert.match(rootLayout, /LOADING_WORDMARK_MAX_WIDTH = 320/);
  assert.match(rootLayout, /ANDROID_SPLASH_HANDOFF_MS = 520/);
  assert.match(rootLayout, /Math\.min\(width \* 0\.72, LOADING_WORDMARK_MAX_WIDTH\)/);
  assert.match(rootLayout, /SplashScreen\.setOptions\(\{ duration: 0, fade: false \}\)/);
  assert.match(rootLayout, /SplashScreen\.hide\(\)/);
  assert.doesNotMatch(rootLayout, /Animated\.Image/);
  assert.match(rootLayout, /setMinimumDisplayComplete\(true\)/);
  assert.match(rootLayout, /\(!isLoading && minimumDisplayComplete\)/);
  // WP12: SplashGate is theme-aware, so only iOS (white native splash)
  // pins dark icons while loading.
  assert.match(rootLayout, /isLoading && Platform\.OS !== 'android'/);
});

test('local Android testing installs beside the Play-signed production app', async () => {
  const config = await read('app.config.ts');
  const forgotPassword = await read('app/(auth)/forgot-password.tsx');

  assert.match(config, /IS_LOCAL_TEST = process\.env\.APP_VARIANT === 'local-test'/);
  assert.match(config, /name: IS_LOCAL_TEST \? 'Captivet Local' : 'Captivet'/);
  assert.match(config, /scheme: IS_LOCAL_TEST \? 'captivet-local' : 'captivet'/);
  assert.match(config, /package: IS_LOCAL_TEST \? 'com\.captivet\.mobile\.local' : 'com\.captivet\.mobile'/);
  assert.match(config, /isProduction: IS_PRODUCTION \|\| IS_LOCAL_TEST/);

  assert.match(forgotPassword, /Constants\.expoConfig\?\.scheme/);
  assert.match(forgotPassword, /Array\.isArray\(configuredScheme\)/);
  assert.match(forgotPassword, /redirectTo: getPasswordResetRedirect\(\)/);
  assert.doesNotMatch(forgotPassword, /redirectTo: 'captivet:\/\/reset-password'/);
});

test('theme preference has dark vars, root hydration, and active settings selector', async () => {
  const css = await read('global.css');
  const rootLayout = await read('app/_layout.tsx');
  const settings = await read('app/(app)/settings.tsx');
  const preference = await read('src/lib/themePreference.ts');
  const preferenceHook = await read('src/hooks/useThemePreference.ts');
  const hook = await read('src/hooks/useThemeColors.ts');
  const tailwind = await read('tailwind.config.js');

  // Must be `.dark:root` — NativeWind v4 class-based dark mode never applies a
  // bare `.dark { --vars }` block to the root (verified on device 2026-06-12).
  assert.match(css, /\.dark:root/);
  assert.match(css, /--brand-500:/);
  assert.match(rootLayout, /ThemePreferenceHydrator/);
  assert.match(rootLayout, /ThemedStatusBar/);
  assert.match(rootLayout, /setColorScheme\(preference\)/);
  assert.match(settings, /THEME_COPY/);
  assert.match(settings, /SegmentedControl<ThemePreference>/);
  assert.match(preference, /@react-native-async-storage\/async-storage/);
  assert.match(hook, /DARK_THEME_COLORS/);
  assert.match(tailwind, /500:\s*'rgb\(var\(--brand-500\)/);

  assert.doesNotMatch(settings, /THEME_SELECTOR_ENABLED/);
  assert.doesNotMatch(rootLayout, /setColorScheme\('light'\)/);
  assert.doesNotMatch(preferenceHook, /THEME_SELECTOR_ENABLED/);
  assert.match(preferenceHook, /setColorScheme\(value\)/);
});

test('audio playback watchdog arms before loading native source', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');
  const hook = await read('src/hooks/useAudioPlayback.ts');
  const watchdogIndex = player.indexOf('watchdogRef.current = setTimeout');
  const loadSourceIndex = player.indexOf('playback.loadSource(uri)');
  const resetIndex = hook.indexOf('resetPlaybackStateForNewSource();');
  const ensureModeIndex = hook.indexOf('await ensurePlaybackMode();');

  assert.notEqual(watchdogIndex, -1, 'watchdog should be armed');
  assert.notEqual(loadSourceIndex, -1, 'native loadSource call should exist');
  assert.ok(watchdogIndex < loadSourceIndex, 'watchdog must arm before loadSource can hang');
  assert.notEqual(resetIndex, -1, 'source loads must reset stale isLoaded state');
  assert.notEqual(ensureModeIndex, -1, 'playback mode setup should still run');
  assert.ok(resetIndex < ensureModeIndex, 'reset must happen before any native call can hang');
  assert.doesNotMatch(player, /lastLoadedUriRef/);
  assert.doesNotMatch(player, /isLoadedRef\.current &&/);
});

test('Phase 5 copy is centralized for profile subscription account deletion and review chip', async () => {
  const strings = await read('src/constants/strings.ts');
  const profile = await read('app/(app)/profile.tsx');
  const subscription = await read('app/(app)/subscription.tsx');
  const deleteAccount = await read('app/(app)/delete-account.tsx');
  const reviewChip = await read('src/components/ReviewStatusChip.tsx');
  const record = await read('app/(app)/(tabs)/record.tsx');

  for (const exportName of [
    'PROFILE_COPY',
    'SUBSCRIPTION_COPY',
    'DELETE_ACCOUNT_COPY',
    'REVIEW_STATUS_COPY',
  ]) {
    assert.match(strings, new RegExp(`export const ${exportName}`));
  }
  assert.match(strings, /saveFailed:\s*\{/);

  assert.match(profile, /PROFILE_COPY/);
  assert.doesNotMatch(profile, /'Name is required\.'/);
  assert.doesNotMatch(profile, /'Save Profile'/);

  assert.match(subscription, /SUBSCRIPTION_COPY/);
  assert.doesNotMatch(subscription, /'Could Not Open Billing'/);
  assert.doesNotMatch(subscription, /Current Plan/);

  assert.match(deleteAccount, /DELETE_ACCOUNT_COPY/);
  assert.doesNotMatch(deleteAccount, /'Sign Out Failed'/);
  assert.doesNotMatch(deleteAccount, /'Request Deletion'/);

  assert.match(reviewChip, /REVIEW_STATUS_COPY/);
  assert.doesNotMatch(reviewChip, /'Reviewed'/);
  assert.doesNotMatch(reviewChip, /'Needs review'/);

  assert.match(record, /TEMPLATE_DEFAULT_COPY\.saveFailed\.title/);
  assert.doesNotMatch(record, /'Default Not Saved'/);
});

test('Phase 5 SOAP edit action uses shared Button (anti-clip lives in Button) and removes dead onSaved prop', async () => {
  const soap = await read('src/components/SoapNoteView.tsx');

  assert.match(soap, /SOAP_SECTION_ACTIONS\.edit/);
  // WP17: section actions use the shared Button, which owns the Android
  // anti-clip mitigation (tests/ui-clip-guard) and haptics; no raw Pressable
  // copies of the pattern remain here.
  assert.match(soap, /<Button\s+variant="secondary"\s+size="sm"\s+icon=\{<Pencil/);
  assert.doesNotMatch(soap, /allowFontScaling=\{false\}/);
  assert.doesNotMatch(soap, /onSaved/);
});

test('record-first blank-field analytics emits only for first segment', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const eventIndex = record.indexOf("name: 'recording_started_blank_fields'");
  const firstSegmentGuardIndex = record.indexOf('slot && slot.segments.length === 0');

  assert.notEqual(eventIndex, -1, 'blank-field analytics event should exist');
  assert.notEqual(firstSegmentGuardIndex, -1, 'first-segment guard should exist');
  assert.ok(firstSegmentGuardIndex < eventIndex, 'first-segment guard should wrap analytics event');
});

test('root status bar omits backgroundColor entirely', async () => {
  const rootLayout = await read('app/_layout.tsx');
  const statusBar = rootLayout.match(/<StatusBar[\s\S]*?\/>/);

  assert.ok(statusBar, 'ThemedStatusBar should render StatusBar');
  // WP12: the prop was Android-only in expo-status-bar and the old code
  // passed it only on iOS — dead on both platforms. It must stay gone.
  assert.doesNotMatch(statusBar[0], /backgroundColor/);
  assert.match(statusBar[0], /style=\{style\}/);
});

test('client email subject-only mail retry reports copied body', async () => {
  const card = await read('src/components/ClientEmailCard.tsx');
  const strings = await read('src/constants/strings.ts');

  assert.match(strings, /bodyCopied: 'Email body copied — paste it into your message\.'/);
  assert.match(card, /setStatus\(body \? CLIENT_EMAIL_COPY\.bodyCopied : CLIENT_EMAIL_COPY\.fallbackCopied\)/);
});

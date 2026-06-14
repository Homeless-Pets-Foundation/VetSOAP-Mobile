import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
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
  assert.match(list, /hasReviewStatusInLoadedRecordings/);
  assert.match(list, /getRecordingReviewStatus\(recording\) !== null/);
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

test('theme preference has dark vars, root hydration, and active settings selector', async () => {
  const css = await read('global.css');
  const rootLayout = await read('app/_layout.tsx');
  const settings = await read('app/(app)/(tabs)/settings.tsx');
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

test('Phase 5 SOAP edit action uses Android anti-clip pattern and removes dead onSaved prop', async () => {
  const soap = await read('src/components/SoapNoteView.tsx');

  assert.match(soap, /SOAP_SECTION_ACTIONS\.edit/);
  assert.match(soap, /Android under-measures single-word Text and clips the last glyph/);
  assert.match(soap, /allowFontScaling=\{false\}/);
  assert.match(soap, /style=\{\{ flexShrink: 0, paddingRight: 2 \}\}/);
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

test('root status bar omits Android backgroundColor', async () => {
  const rootLayout = await read('app/_layout.tsx');
  const statusBar = rootLayout.match(/<StatusBar[\s\S]*?\/>/);

  assert.ok(statusBar, 'ThemedStatusBar should render StatusBar');
  assert.match(rootLayout, /Platform\.OS === 'android' \? \{\} : \{ backgroundColor: colors\.surface \}/);
  assert.match(statusBar[0], /style=\{style\}/);
});

test('client email subject-only mail retry reports copied body', async () => {
  const card = await read('src/components/ClientEmailCard.tsx');
  const strings = await read('src/constants/strings.ts');

  assert.match(strings, /bodyCopied: 'Email body copied — paste it into your message\.'/);
  assert.match(card, /setStatus\(body \? CLIENT_EMAIL_COPY\.bodyCopied : CLIENT_EMAIL_COPY\.fallbackCopied\)/);
});

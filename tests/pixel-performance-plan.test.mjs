import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootPath = fileURLToPath(new URL('../', import.meta.url));

async function read(relativePath) {
  return readFile(path.join(rootPath, relativePath), 'utf8');
}

async function collectSourceFiles(relativeDir) {
  const absoluteDir = path.join(rootPath, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(relativePath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

async function readAllSource() {
  const files = [
    ...await collectSourceFiles('app'),
    ...await collectSourceFiles('src'),
  ];
  const pairs = await Promise.all(files.map(async (file) => [file, await read(file)]));
  return pairs.map(([file, source]) => ({ file, source }));
}

test('Pixel performance plan keeps root diagnostics and named phase timing wired', async () => {
  const monitoring = await read('src/lib/monitoring.ts');
  const rootLayout = await read('app/_layout.tsx');
  const phaseSources = [
    await read('src/auth/AuthProvider.tsx'),
    await read('app/(app)/(tabs)/index.tsx'),
    await read('app/(app)/(tabs)/recordings/index.tsx'),
    await read('app/(app)/(tabs)/record.tsx'),
    await read('src/hooks/useLocalDraftRecordings.ts'),
  ].join('\n');

  assert.match(monitoring, /export function captureException\([\s\S]*\): string \| undefined/);
  assert.match(monitoring, /export function measurePhase/);
  assert.match(monitoring, /breadcrumb\('performance', 'phase_complete'/);
  assert.match(monitoring, /captureMessage\(`slow_phase_\$\{name\}`/);
  assert.match(monitoring, /fingerprint: \[message\]/);
  assert.match(monitoring, /if \(durationMs >= 5000\)/);
  assert.match(monitoring, /duration_bucket: bucketDuration\(durationMs\)/);

  assert.match(rootLayout, /rootBoundaryDiagnostics/);
  assert.ok(
    rootLayout.indexOf("pathname.includes('/recordings')") <
      rootLayout.indexOf("pathname.includes('/record')"),
    'recordings list route should be classified before the broader record route'
  );
  assert.match(rootLayout, /function RootDiagnosticsReporter\(\)/);
  assert.match(rootLayout, /tags: \{ boundary: 'root' \}/);
  assert.match(rootLayout, /extra: \{[\s\S]*rootBoundaryDiagnostics/);

  for (const phase of [
    'auth_init_get_session',
    'fetchUser',
    'registerDevice',
    'local_recovery_scan',
    'home_focus_refresh',
    'records_focus_refresh',
    'local_draft_list',
    'missing_server_draft_reconciliation',
    'record_screen_mount_work',
  ]) {
    assert.match(phaseSources, new RegExp(`measurePhase\\(\\s*'${phase}'`), phase);
  }

  assert.match(phaseSources, /'orphan_cleanup'/);
  assert.match(phaseSources, /'thirty_day_eviction'/);
  assert.match(phaseSources, /count: linkedDrafts\.length/);
});

test('Pixel performance plan keeps hot auth consumers and list rows off broad animated paths', async () => {
  const sources = await readAllSource();
  const broadAuthConsumers = sources
    .filter(({ file }) => file !== 'src/hooks/useAuth.ts')
    .filter(({ source }) => /\buseAuth\s*\(/.test(source))
    .map(({ file }) => file);
  assert.deepEqual(broadAuthConsumers, []);

  const card = await read('src/components/ui/Card.tsx');
  assert.match(card, /import \{ View, type ViewProps \} from 'react-native'/);
  assert.match(card, /if \(animated\) \{[\s\S]*<Animated\.View/);
  assert.match(card, /return \([\s\S]*<View className=\{\`\$\{baseClass\} \$\{className\}`\}/);

  const listItem = await read('src/components/ui/ListItem.tsx');
  const recordingCard = await read('src/components/RecordingCard.tsx');
  assert.doesNotMatch(listItem, /react-native-reanimated|useSharedValue|useAnimatedStyle/);
  assert.doesNotMatch(recordingCard, /react-native-reanimated|useSharedValue|useAnimatedStyle/);
  assert.match(recordingCard, /<Pressable/);
  assert.match(recordingCard, /const formattedDate = React\.useMemo/);

  for (const file of [
    'app/(app)/(tabs)/index.tsx',
    'app/(app)/(tabs)/recordings/index.tsx',
    'app/(app)/(tabs)/patient/index.tsx',
  ]) {
    assert.doesNotMatch(await read(file), /FadeIn/, file);
  }
});

test('Pixel performance plan keeps focus refresh, local drafts, pending sync, and invalidation narrowed', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  const records = await read('app/(app)/(tabs)/recordings/index.tsx');
  const localDrafts = await read('src/hooks/useLocalDraftRecordings.ts');
  const pendingSync = await read('src/hooks/usePendingDraftSync.ts');
  const record = await read('app/(app)/(tabs)/record.tsx');
  const cache = await read('src/lib/recordingQueryCache.ts');
  const draftStorage = await read('src/lib/draftStorage.ts');
  const apiClient = await read('src/api/client.ts');
  const homeFocusRefresh = home.slice(
    home.indexOf('const handleFocusRefresh'),
    home.indexOf('useFocusEffect(handleFocusRefresh)')
  );
  const recordsFocusRefresh = records.slice(
    records.indexOf('const handleFocusRefresh'),
    records.indexOf('useFocusEffect(handleFocusRefresh)')
  );

  assert.match(home, /recordingsQuery\.isStale/);
  assert.match(home, /refreshLocalDrafts/);
  assert.match(home, /local_drafts_refreshed: true/);
  assert.match(home, /refreshLocalDrafts\(\);/);
  assert.match(home, /const areLocalDraftsStaleRef = useRef\(areLocalDraftsStale\)/);
  assert.match(homeFocusRefresh, /const localDraftsStale = areLocalDraftsStaleRef\.current/);
  assert.doesNotMatch(homeFocusRefresh, /\bareLocalDraftsStale\b/);
  assert.match(records, /shouldRefetchRecordings = shouldLoadRecordings && isStale/);
  assert.match(records, /refreshLocalDrafts/);
  assert.match(records, /local_drafts_refreshed: shouldRefreshLocalDrafts/);
  assert.match(records, /if \(shouldRefreshLocalDrafts\) \{\s*refreshLocalDrafts\(\);/);
  assert.match(records, /const areLocalDraftsStaleRef = useRef\(areLocalDraftsStale\)/);
  assert.match(recordsFocusRefresh, /const localDraftsStale = areLocalDraftsStaleRef\.current/);
  assert.doesNotMatch(recordsFocusRefresh, /\bareLocalDraftsStale\b/);

  assert.match(localDrafts, /queryKey: \['local-drafts', userId\]/);
  assert.match(localDrafts, /useAuthDeviceRegistration/);
  assert.match(localDrafts, /const canReconcileServerDrafts = !!userId && !deviceRegistrationPending && !deviceRegistrationBlock/);
  assert.match(localDrafts, /const RECONCILE_INTERVAL_MS = 5 \* 60_000/);
  assert.match(localDrafts, /const RECONCILE_CONCURRENCY = 3/);
  assert.match(localDrafts, /const RECONCILE_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(localDrafts, /const RECONCILE_PROBE_DEADLINE_MS = 12_000/);
  assert.match(localDrafts, /const controller = new AbortController\(\)/);
  assert.match(localDrafts, /signal: controller\.signal/);
  assert.match(localDrafts, /allowAuthSideEffects: false/);
  assert.match(localDrafts, /finish\(\{ presence: 'unknown', interrupted: true \}, true\)/);
  assert.match(localDrafts, /AppState\.addEventListener\('change'/);
  assert.match(localDrafts, /AppState\.currentState !== 'active'/);
  assert.match(localDrafts, /draftStorage\.getUserId\(\) !== userId/);
  assert.match(localDrafts, /nextState !== 'active'/);
  assert.match(localDrafts, /reconcileInFlightByUser\.get\(userId\)/);
  assert.match(localDrafts, /reconcileInBackground\(false\)/);
  assert.match(localDrafts, /runBounded\(/);
  assert.match(localDrafts, /listDraftsForUser\(userId\)/);
  assert.match(localDrafts, /clearServerDraftIdForUser\(userId, draft\.slotId, serverDraftId\)/);
  assert.match(localDrafts, /reconcileInBackground\(false\);\s*return drafts;/);
  assert.doesNotMatch(localDrafts, /await reconcileMissingServerDrafts\(userId/);

  assert.match(apiClient, /signal\?: AbortSignal/);
  assert.match(apiClient, /signal\?\.addEventListener\('abort', abortFromExternalSignal/);
  assert.match(apiClient, /if \(allowAuthSideEffects && response\.status === 428/);
  assert.match(apiClient, /if \(allowAuthSideEffects && response\.status === 401/);

  assert.match(pendingSync, /const inFlightByUser = new Map/);
  assert.match(pendingSync, /const lastFailedAtByUser = new Map/);
  assert.match(pendingSync, /AppState\.currentState !== 'active'/);
  assert.match(pendingSync, /NetInfo\.addEventListener/);
  assert.match(pendingSync, /result\.failed > 0[\s\S]*lastFailedAtByUser\.set\(userId, Date\.now\(\)\)/);
  assert.match(pendingSync, /result\.succeeded > 0[\s\S]*invalidateRecordingCaches\(queryClient, 'draft_changed'\)/);
  assert.doesNotMatch(pendingSync, /\.finally\(\(\) => \{\s*invalidateRecordingCaches\(queryClient, 'draft_changed'\)/);
  assert.match(pendingSync, /\.catch\(\(\) => \{\}\)/);

  assert.match(record, /function scheduleNonUrgentWork/);
  assert.match(record, /InteractionManager\.runAfterInteractions\(\(\) => \{/);
  assert.match(record, /measurePhase\(label, undefined, work\)\.catch\(\(\) => \{\}\)/);
  assert.match(record, /Promise\.all\(\[\s*[\s\S]*draftStorage\.deleteDraft\(slot\.id\)[\s\S]*\]\)\.then\(\(\) => \{\s*invalidateRecordingCaches\(queryClient, 'draft_deleted'\);/);
  assert.match(record, /'record_pending_draft_scan'/);
  assert.match(record, /'orphan_cleanup'/);
  assert.match(record, /'thirty_day_eviction'/);

  assert.match(draftStorage, /export interface DraftSyncResult/);
  assert.match(draftStorage, /attempted: number;\s*succeeded: number;\s*failed: number;/);
  assert.match(draftStorage, /Promise<DraftSyncResult>/);
  assert.match(draftStorage, /result\.failed\+\+/);

  assert.match(cache, /export type RecordingCacheMutation/);
  assert.match(cache, /refetchType: 'active'/);
  assert.match(cache, /case 'review_update':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\]\]/);
  assert.match(cache, /case 'draft_changed':\s*case 'draft_deleted':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\]\]/);
  assert.match(cache, /case 'device_registration_recovered':\s*return \[\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\], \['local-drafts'\]\]/);
});

test('Pixel performance plan keeps startup, device-capacity, orientation, audio, and smoke-script changes', async () => {
  const rootLayout = await read('app/_layout.tsx');
  const socialAuth = await read('src/auth/socialAuth.ts');
  const deviceCapacity = await read('src/hooks/useDeviceCapacity.ts');
  const audioRecorder = await read('src/hooks/useAudioRecorder.ts');
  const appConfig = await read('app.config.ts');
  const smokeScript = await read('scripts/android-perf-smoke.sh');
  const smokeMode = (await stat(path.join(rootPath, 'scripts/android-perf-smoke.sh'))).mode;

  assert.match(rootLayout, /const permissionTimer = setTimeout\(\(\) => \{/);
  assert.match(rootLayout, /require\('expo-audio'\)/);
  assert.match(rootLayout, /measurePhase\('permission_snapshot'/);
  assert.doesNotMatch(rootLayout, /configureGoogleSignIn/);

  assert.match(socialAuth, /measurePhase\('google_sign_in_configure'/);
  assert.match(socialAuth, /if \(!googleConfigured\) configureGoogleSignIn\(\);\s*const \{ GoogleSignin \} = getGoogleSignin\(\);/);

  assert.match(deviceCapacity, /mode\?: 'home' \| 'manage'/);
  assert.match(deviceCapacity, /const staleTime = mode === 'manage' \? 30_000 : 5 \* 60_000/);
  assert.match(deviceCapacity, /refetchInterval: mode === 'manage' && isTabFocused \? 60_000 : false/);
  assert.match(deviceCapacity, /refetchOnWindowFocus: mode === 'manage'/);

  assert.match(appConfig, /orientation: 'portrait'/);

  assert.match(audioRecorder, /numberOfChannels: 1/);
  assert.match(audioRecorder, /bitRate: 96000/);
  assert.match(audioRecorder, /audioQuality: AudioQuality\.HIGH/);
  assert.match(audioRecorder, /let androidNotificationPermissionChecked = false/);
  assert.match(audioRecorder, /PermissionsAndroid\.check/);
  assert.match(audioRecorder, /PermissionsAndroid\.request/);

  assert.ok((smokeMode & 0o111) !== 0, 'android perf smoke script should be executable');
  assert.match(smokeScript, /OUT_ROOT="\$\{OUT_ROOT:-\/tmp\/captivet-perf-smoke\}"/);
  assert.match(smokeScript, /ADB_SERIAL/);
  assert.match(smokeScript, /devices \| tr -d '\\r'/);
  assert.match(smokeScript, /am force-stop \$\{PACKAGE_NAME\}/);
  assert.match(smokeScript, /am start -W -n \$\{PACKAGE_NAME\}\/\$\{ACTIVITY_NAME\}/);
  assert.match(smokeScript, /dumpsys gfxinfo \$\{PACKAGE_NAME\} reset/);
  assert.match(smokeScript, /dumpsys meminfo \$\{PACKAGE_NAME\}/);
  assert.match(smokeScript, /top -H -b -n 1 -p \$\{pid\}/);
  assert.match(smokeScript, /cat \/proc\/meminfo/);
  assert.match(smokeScript, /cat \/proc\/swaps/);
  assert.match(smokeScript, /pm path \$\{PACKAGE_NAME\}/);
});

test('Pixel performance plan preserves crash-prevention constraints touched by the work', async () => {
  const sources = await readAllSource();
  const allAppSource = sources.map(({ source }) => source).join('\n');

  assert.doesNotMatch(allAppSource, /invalidateQueries\(\{ queryKey: \['recordings'\]/);
  assert.doesNotMatch(allAppSource, /on(Press|Refresh|ValueChange)=\{async/);
  assert.doesNotMatch(allAppSource, /AppState\.addEventListener\([^,\n]+,\s*async/);

  const allowedSecureStoreOwners = new Set([
    'src/auth/supabase.ts',
    'src/lib/biometrics.ts',
    'src/lib/draftStorage.ts',
    'src/lib/secureStorage.ts',
    'src/lib/stashStorage.ts',
  ]);
  const directSecureStoreFiles = sources
    .filter(({ file }) => !allowedSecureStoreOwners.has(file))
    .filter(({ source }) => {
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      return /SecureStore\./.test(withoutComments);
    })
    .map(({ file }) => file);
  assert.deepEqual(directSecureStoreFiles, []);

  const authProvider = await read('src/auth/AuthProvider.tsx');
  assert.doesNotMatch(authProvider, /draftStorage\.clearAll/);
  assert.doesNotMatch(authProvider, /stashStorage\.clearAllStashes/);
  assert.doesNotMatch(authProvider, /stashAudioManager\.deleteAllStashedAudio\(\)/);
  assert.match(authProvider, /setStashUserId\(scopedUserId\);\s*draftStorage\.setUserId\(scopedUserId\);/);
});

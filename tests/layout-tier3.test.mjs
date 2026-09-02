import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Layout tier 3 (2026-09-02, plan: assess-the-overall-layout-compiled-lagoon):
// recordings list date groups + badge hygiene, attention header note, patient
// rows that can be told apart, patient detail as one scroll, settings/profile
// wording, icon-only device revoke. Structural fences; the pure helpers are
// executed in recording-date-groups / device-display.

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('recordings list groups rows by date and hides the badge on completed rows', async () => {
  const list = stripComments(await read('app/(app)/(tabs)/recordings/index.tsx'));
  assert.match(list, /<SectionList/);
  assert.doesNotMatch(list, /<FlatList/);
  assert.match(list, /groupRecordingsByDate\(displayRecordings, Date\.now\(\)\)/);
  assert.match(list, /stickySectionHeadersEnabled=\{false\}/);
  assert.match(list, /hideStatusBadge=\{item\.status === 'completed'\}/);
  const header = list.slice(list.indexOf('renderSectionHeader='), list.indexOf('contentContainerStyle='));
  assert.match(header, /accessibilityRole="header"/);
  assert.doesNotMatch(header, /Pressable/);
  // The Select gave back its fixed width so the longer placeholder fits.
  assert.doesNotMatch(list, /w-\[150px\]/);
  const copy = await read('src/constants/strings.ts');
  assert.match(copy, /searchPlaceholder: 'Search patients or clients'/);
  assert.match(copy, /dateGroupToday: 'Today'/);
  assert.match(copy, /dateGroupYesterday: 'Yesterday'/);
  assert.match(copy, /dateGroupThisWeek: 'This week'/);
  assert.match(copy, /dateGroupEarlier: 'Earlier'/);
  // draftRecordings shares ONE timestamp precedence with the grouping helper.
  const drafts = await read('src/lib/draftRecordings.ts');
  assert.match(drafts, /import \{ getCreatedAtMs, getSubmittedAtMs \} from '\.\/recordingDateGroups'/);
  assert.doesNotMatch(drafts, /function getSubmittedAtMs/);
});

test('patients search placeholder matches the recordings one (server matches clientName too)', async () => {
  const patients = await read('app/(app)/(tabs)/patient/index.tsx');
  assert.match(patients, /placeholder=\{PATIENT_LIST_COPY\.searchPlaceholder\}/);
  const copy = await read('src/constants/strings.ts');
  const block = copy.slice(copy.indexOf('export const PATIENT_LIST_COPY'), copy.indexOf('} as const;', copy.indexOf('export const PATIENT_LIST_COPY')));
  assert.match(block, /searchPlaceholder: 'Search patients or clients'/);
  assert.match(block, /lastVisit: \(date: string\): string =>/);
  assert.match(block, /visitCount: \(count: number\): string =>/);
});

test('attention: the read-only note lives on the group header, once, not on every row', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  const metaFn = section.slice(section.indexOf('function metaLineFor'), section.indexOf('interface AttentionItemRowProps'));
  assert.doesNotMatch(metaFn, /readOnlyNote/);
  assert.match(section, /subtitleNumberOfLines=\{3\}/);
  const listItem = await read('src/components/ui/ListItem.tsx');
  assert.match(listItem, /subtitleNumberOfLines\?: number/);
  assert.match(listItem, /subtitleNumberOfLines = 2/);
  const screen = await read('app/(app)/(tabs)/recordings/attention.tsx');
  const sectionsBlock = screen.slice(screen.indexOf('const sections = useMemo'), screen.indexOf('const goBack = useCallback'));
  assert.equal((sectionsBlock.match(/note: ATTENTION_FEED_COPY\.readOnlyNote/g) ?? []).length, 1);
  const headerBlock = screen.slice(screen.indexOf('renderSectionHeader='), screen.indexOf('ListHeaderComponent='));
  assert.match(headerBlock, /typed\.note/);
  assert.doesNotMatch(headerBlock, /Pressable|ChevronDown|ChevronRight/);
});

test('patient rows show client · species · breed and a last-visit date when the API sends one', async () => {
  const types = await read('src/types/index.ts');
  const patientType = types.slice(types.indexOf('export interface Patient {'), types.indexOf('}', types.indexOf('export interface Patient {')));
  assert.match(patientType, /clientName\?: string \| null/);
  assert.match(patientType, /lastVisitAt\?: string \| null/);
  const row = stripComments(await read('src/components/PatientRow.tsx'));
  assert.match(row, /patient\.clientName/);
  assert.match(row, /formatIsoShortDate\(patient\.lastVisitAt/);
  assert.match(row, /PATIENT_LIST_COPY\.lastVisit\(/);
  assert.match(row, /PATIENT_LIST_COPY\.visitCount\(/);
  const comparator = row.slice(row.indexOf('(prev, next) =>'));
  for (const field of ['clientName', 'species', 'breed', 'pimsPatientId', 'lastVisitAt', '_count?.recordings']) {
    assert.match(comparator, new RegExp(`prev\\.patient\\.${field.replace(/[?.]/g, '\\$&')} === next\\.patient\\.${field.replace(/[?.]/g, '\\$&')}`), field);
  }
  const display = await read('src/lib/recordingDisplay.ts');
  assert.match(display, /export function formatIsoShortDate\(iso: string \| null \| undefined, nowMs: number\): string/);
  assert.match(display, /typeof iso === 'string'/);
});

test('patient detail is a single scroll: no tabs, visits always enabled, no duplicate cards', async () => {
  const detail = stripComments(await read('app/(app)/(tabs)/patient/[id].tsx'));
  assert.doesNotMatch(detail, /type Tab\b|activeTab|accessibilityRole="tab"/);
  assert.match(detail, /queryKey: \['patient', id, 'recordings', visitsLimit\][\s\S]*?enabled: !!id && !accessRevoked/);
  assert.equal((detail.match(/<ScrollView/g) ?? []).length, 1);
  assert.match(detail, /PATIENT_DETAIL_COPY\.visitsHeading\(/);
  // The standalone Known Allergies / Ongoing Medications cards duplicated the
  // Patient Details card; only the ProfileField rows remain.
  assert.doesNotMatch(detail, /<Text[^>]*>Known Allergies<\/Text>/);
  assert.doesNotMatch(detail, /<Text[^>]*>Ongoing Medications<\/Text>/);
  assert.match(detail, /<ProfileField label="Known Allergies"/);
  // Header uses the settings/profile pattern (IconButton back + flex-1 title).
  assert.match(detail, /<IconButton[\s\S]*?label="Go back"/);
  assert.doesNotMatch(detail, /bg-surface-raised border-b/);
  // Pull-to-refresh refetches the profile AND the visits.
  assert.match(detail, /refetchVisits\(\)\.catch\(\(\) => \{\}\)/);
});

test('settings: tappable profile card, "Require <type>" biometric row, neutral Sign Out in ACCOUNT', async () => {
  const settings = stripComments(await read('app/(app)/settings.tsx'));
  assert.match(settings, /SETTINGS_COPY\.biometricTitle\(biometricType\)/);
  assert.match(settings, /SETTINGS_COPY\.biometricSubtitle\(biometricType\)/);
  assert.doesNotMatch(settings, /\$\{biometricType\} Lock/);
  assert.doesNotMatch(settings, /title="Edit Profile"/);
  const card = settings.slice(settings.indexOf('<ProviderIssueBanner'), settings.indexOf('<SectionHeading>ACCOUNT'));
  assert.match(card, /<Pressable[\s\S]*?accessibilityLabel="Edit profile"[\s\S]*?router\.push\('\/profile' as never\)/);
  assert.match(card, /<ChevronRight/);
  const signOut = settings.indexOf('title="Sign Out"');
  assert.ok(signOut > 0, 'Sign Out is a plain-string ListItem title');
  assert.ok(signOut > settings.indexOf('<SectionHeading>ACCOUNT') && signOut < settings.indexOf('<SectionHeading>APP'), 'Sign Out sits in ACCOUNT');
  assert.doesNotMatch(settings, /text-status-danger">Sign Out/);
  assert.match(settings, /onPress=\{handleSignOut\}/);
  const copy = await read('src/constants/strings.ts');
  assert.match(copy, /export const SETTINGS_COPY = \{/);
  assert.match(copy, /'Require biometric unlock'/);
  const profile = await read('app/(app)/profile.tsx');
  assert.match(profile, /PROFILE_COPY\.accountSection/);
  assert.doesNotMatch(copy, /accountName: 'Account Name'/);
  assert.match(copy, /accountSection: 'Account'/);
});

test('devices: icon-only revoke with a full-name a11y label, distinguishing titles', async () => {
  const devices = stripComments(await read('app/(app)/devices.tsx'));
  assert.doesNotMatch(devices, /dangerGhost/);
  assert.match(devices, /import \{ formatDeviceTypeLabel, splitDeviceName \} from '\.\.\/\.\.\/src\/lib\/deviceDisplay'/);
  assert.doesNotMatch(devices, /function formatDeviceTypeLabel/);
  const row = devices.slice(devices.indexOf('function DeviceRow'), devices.indexOf('export default function DevicesScreen'));
  assert.match(row, /<IconButton[\s\S]*?icon=\{<Trash2[\s\S]*?label=\{`Revoke \$\{fullName\}`\}[\s\S]*?loading=\{isRevoking\}/);
  assert.match(row, /splitDeviceName\(device\.deviceName, typeLabel\)/);
  // The confirm Alert keeps the FULL name.
  assert.match(devices, /const label = device\.deviceName \|\| formatDeviceTypeLabel\(device\.deviceType\);/);
});

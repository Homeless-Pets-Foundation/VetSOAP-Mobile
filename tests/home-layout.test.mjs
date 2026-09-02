import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

// Home layout reorg (2026-09-02, plan: assess-the-overall-layout-compiled-lagoon).
// Home was 7 viewports tall with the Clinic Quality card alone taking 4.5 of
// them, the Record CTA at the fold, and "✓ All Complete" rendering beside failed
// recordings. These fences keep the reorganised order and the shared contracts
// (ui/Collapsible, RecordingCard.hideStatusBadge) from drifting back.

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
// Comments may legitimately NAME the things a fence forbids ("no LayoutAnimation").
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// Objects built inside the vm realm carry that realm's prototypes; compare structure.
const plain = (value) => JSON.parse(JSON.stringify(value));

const rec = (status) => ({ status });

test('deriveRecentStatusPill: failed outranks processing, drafts, and all-complete', async () => {
  const { deriveRecentStatusPill } = await loadTsModule('src/lib/homeRecordingStatus.ts');
  assert.deepEqual(
    plain(deriveRecentStatusPill({ recordings: [rec('failed'), rec('transcribing'), rec('completed')], draftCount: 3 })),
    { kind: 'failed', count: 1, variant: 'danger' }
  );
  assert.deepEqual(
    plain(deriveRecentStatusPill({ recordings: [rec('generating'), rec('uploading'), rec('completed')], draftCount: 3 })),
    { kind: 'processing', count: 2, variant: 'warning' }
  );
  assert.deepEqual(
    plain(deriveRecentStatusPill({ recordings: [rec('completed'), rec('completed')], draftCount: 2 })),
    { kind: 'not_submitted', count: 2, variant: 'warning' }
  );
  assert.deepEqual(
    plain(deriveRecentStatusPill({ recordings: [rec('completed')], draftCount: 0 })),
    { kind: 'all_complete', count: 0, variant: 'success' }
  );
});

test('deriveRecentStatusPill never reads all-complete while a failed recording is listed', async () => {
  const { deriveRecentStatusPill } = await loadTsModule('src/lib/homeRecordingStatus.ts');
  const pill = deriveRecentStatusPill({ recordings: [rec('completed'), rec('failed')], draftCount: 0 });
  assert.equal(pill.kind, 'failed');
  assert.notEqual(pill.variant, 'success');
  // draft rows in the recent list are counted by draftCount, never as processing
  const drafts = deriveRecentStatusPill({ recordings: [rec('draft')], draftCount: 1 });
  assert.equal(drafts.kind, 'not_submitted');
});

test('Home renders the Record CTA above Needs Attention and Clinic Quality last', async () => {
  const home = stripComments(await read('app/(app)/(tabs)/index.tsx'));
  const cta = home.indexOf('Record Appointment');
  const attention = home.indexOf('<AttentionFeedSection');
  const recent = home.indexOf('>Recent Recordings<');
  const quality = home.indexOf('<QualityAnalyticsCard');
  assert.ok(cta > 0 && attention > cta, 'Record CTA must precede Needs Attention');
  assert.ok(recent > attention, 'Recent Recordings must follow Needs Attention');
  assert.ok(quality > recent, 'Clinic Quality stays last');
  assert.doesNotMatch(home, /Total Recordings/);
  assert.match(home, /deriveRecentStatusPill\(/);
  assert.match(home, /HOME_COPY\.statusPill/);
  assert.match(home, /useScrollToTop\(scrollRef\)/);
  assert.match(home, /<ScreenContainer[^>]*ref=\{scrollRef\}/);
  assert.match(home, /hideStatusBadge=\{recording\.status === 'completed'\}/);
  assert.match(home, /role=\{user\?\.role\}/);
  // The status pill sits on its own row UNDER the section title. Beside it, the
  // pill + "View All" squeezed the flex-1 title into "Recent Recordi…" at 1.3×
  // font scale (emulator, 2026-09-02); a heading that ellipsizes at the cap the
  // app itself allows is a layout bug, not a font-scaling one.
  const viewAll = home.indexOf("clipSafe('View All')");
  const pill = home.indexOf('<Badge variant={statusPill.variant}');
  assert.ok(viewAll > recent && pill > viewAll, 'status pill renders after the title row, not beside the title');
});

test('ScreenContainer forwards a ScrollView ref for scroll-to-top', async () => {
  const container = await read('src/components/ui/ScreenContainer.tsx');
  assert.match(container, /React\.forwardRef<ScrollView/);
  assert.match(container, /<ScrollView[\s\S]*ref=\{ref\}/);
});

test('RecordingCard can hide the default status badge without losing the a11y status', async () => {
  const card = await read('src/components/RecordingCard.tsx');
  assert.match(card, /hideStatusBadge\?: boolean/);
  assert.match(card, /hideStatusBadge \? null : <StatusBadge status=\{recording\.status\} \/>/);
  assert.match(card, /prev\.hideStatusBadge === next\.hideStatusBadge/);
  assert.match(card, /status \$\{recording\.status\}/);
});

test('Home attention block is compact: summary row, at most two rows, no coverage footer', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  assert.match(section, /export const HOME_ATTENTION_ROW_LIMIT = 2;/);
  assert.match(section, /ATTENTION_FEED_COPY\.homeSummary\(/);
  const component = section.slice(section.indexOf('export function AttentionFeedSection'));
  assert.doesNotMatch(component, /coverageFooter/);
  assert.match(component, /router\.push\('\/recordings\/attention' as never\)/);
});

test('ui/Collapsible is a controlled reanimated disclosure with no LayoutAnimation', async () => {
  const collapsible = stripComments(await read('src/components/ui/Collapsible.tsx'));
  assert.match(collapsible, /import \{ Text \} from '\.\/Text'/);
  assert.doesNotMatch(collapsible, /from 'react-native'[^;]*\bText\b/);
  assert.match(collapsible, /withTiming/);
  assert.doesNotMatch(collapsible, /LayoutAnimation|FadeIn|Animated\.Text/);
  assert.match(collapsible, /accessibilityState=\{\{ expanded \}\}/);
  assert.match(collapsible, /Haptics\.selectionAsync\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(collapsible, /\{expanded \? /);
  // The Clinic Quality headline ("501 completed · 29% missing details · 7 min to
  // 90%") ellipsized at "7 min t…" on a 411 dp phone with one line (emulator,
  // 2026-09-02). Two lines keep every number visible without a shorter, more
  // cryptic copy string; the title above it stays single-line.
  const headlineStart = collapsible.indexOf('{headline ? (');
  const headline = collapsible.slice(headlineStart, collapsible.indexOf('{headline}', headlineStart));
  assert.match(headline, /numberOfLines=\{2\}/, 'headline caption wraps to two lines');
  const index = await read('src/components/ui/index.ts');
  assert.match(index, /export \* from '\.\/Collapsible';/);
});

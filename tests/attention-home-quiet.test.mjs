// Home's quiet Needs Attention line (2026-10-21 UI/UX audit, UX-M11).
//
// For any practice past 100 recordings the feed's coverage is permanently
// `recent_page_only`, so the alarm-titled "Needs Attention" block sat on Home
// forever with nothing in it, and "Checking recent recordings…" flashed in and
// out on every cold open. With nothing to list, Home now shows ONE quiet line.
// Every variant stays qualified, and the six-condition clean claim is still the
// only positive one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const FEED = await loadTsModule('src/lib/attentionFeed.ts');
const COPY = (await loadTsModule('src/constants/strings.ts')).ATTENTION_FEED_COPY;

const settledRecentClean = {
  itemCount: 0,
  noticeCount: 0,
  isSettled: true,
  localSettled: true,
  isClean: false,
  isTruncated: true,
  checkedCount: 100,
};

test('any row or any qualified notice keeps the full block', () => {
  assert.equal(FEED.homeAttentionQuietState({ ...settledRecentClean, itemCount: 1 }), null);
  assert.equal(FEED.homeAttentionQuietState({ ...settledRecentClean, noticeCount: 1 }), null);
  // A notice wins even while a source is still loading: errors stay loud.
  assert.equal(
    FEED.homeAttentionQuietState({ ...settledRecentClean, isSettled: false, noticeCount: 1 }),
    null
  );
});

test('an unsettled source is a quiet checking line, never a verdict', () => {
  assert.deepEqual(plain(FEED.homeAttentionQuietState({ ...settledRecentClean, isSettled: false })), {
    kind: 'checking',
  });
  // The server page routinely settles before the slower local read.
  assert.deepEqual(plain(FEED.homeAttentionQuietState({ ...settledRecentClean, localSettled: false })), {
    kind: 'checking',
  });
  // isClean cannot short-circuit an unsettled local source.
  assert.deepEqual(
    plain(FEED.homeAttentionQuietState({ ...settledRecentClean, isClean: true, localSettled: false })),
    { kind: 'checking' }
  );
});

test('the positive claim is reserved for the six-condition isClean', () => {
  assert.deepEqual(
    plain(FEED.homeAttentionQuietState({ ...settledRecentClean, isClean: true, isTruncated: false })),
    { kind: 'clean' }
  );
  assert.equal(FEED.homeAttentionQuietLabel({ kind: 'clean' }), COPY.clean);
  assert.equal(COPY.clean, 'No supported items need attention right now');
});

test('a clean recent page is scoped by the ACTUAL checked count', () => {
  assert.deepEqual(plain(FEED.homeAttentionQuietState(settledRecentClean)), {
    kind: 'recent_clean',
    checkedCount: 100,
  });
  assert.deepEqual(plain(FEED.homeAttentionQuietState({ ...settledRecentClean, checkedCount: 37 })), {
    kind: 'recent_clean',
    checkedCount: 37,
  });
  assert.equal(
    FEED.homeAttentionQuietLabel({ kind: 'recent_clean', checkedCount: 37 }),
    'Recent check: nothing found in the last 37 updated recordings'
  );
  assert.equal(
    FEED.homeAttentionQuietLabel({ kind: 'recent_clean', checkedCount: 1 }),
    'Recent check: nothing found in the last 1 updated recording'
  );
  // Zero checked rows cannot support any claim; fall back to the full block.
  assert.equal(FEED.homeAttentionQuietState({ ...settledRecentClean, checkedCount: 0 }), null);
});

test('an unrecognized settled state falls back to the full block', () => {
  assert.equal(FEED.homeAttentionQuietState({ ...settledRecentClean, isTruncated: false }), null);
});

test('the checking line reuses the loading copy, and no quiet copy claims an all-clear', () => {
  assert.equal(FEED.homeAttentionQuietLabel({ kind: 'checking' }), COPY.loading);
  for (const label of [
    FEED.homeAttentionQuietLabel({ kind: 'checking' }),
    FEED.homeAttentionQuietLabel({ kind: 'recent_clean', checkedCount: 100 }),
  ]) {
    assert.doesNotMatch(label, /all clear|all-clear|View all|no supported items/i);
  }
});

test('the recent-page copy never hardcodes the page size', async () => {
  const strings = await read('src/constants/strings.ts');
  const line = strings.slice(strings.indexOf('homeQuietRecentClean'), strings.indexOf('\n\n', strings.indexOf('homeQuietRecentClean')));
  assert.match(line, /\$\{checked\}/);
  assert.doesNotMatch(line, /\b100\b/);
});

test('the section returns the quiet row BEFORE the header block, linking to the full screen', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  const component = section.slice(section.indexOf('export function AttentionFeedSection'));
  const early = component.indexOf('if (quietState) return <HomeAttentionQuietRow state={quietState} />;');
  const header = component.indexOf('ATTENTION_FEED_COPY.sectionTitle');
  assert.ok(early > 0 && header > early, 'the quiet row must short-circuit before the header renders');
  assert.match(component, /const quietState = homeAttentionQuietStateFor\(feed\);/);

  const row = section.slice(
    section.indexOf('function HomeAttentionQuietRow'),
    section.indexOf('interface AttentionFeedSectionProps')
  );
  assert.match(row, /router\.push\('\/recordings\/attention' as never\)/);
  assert.match(row, /accessibilityRole="button"/);
  // The accessible name starts with the visible text (WCAG 2.5.3).
  assert.match(row, /accessibilityLabel=\{`\$\{label\}\. \$\{ATTENTION_FEED_COPY\.openScreenAccessibilityLabel\}`\}/);
  assert.match(row, /accessibilityState=\{\{ busy: state\.kind === 'checking' \}\}/);
  // Not a heading: the whole point is to drop the alarm-titled header.
  assert.doesNotMatch(row, /accessibilityRole="header"/);
  // Bold-text clipping (CLAUDE.md > UI Gotchas): real width + room to wrap.
  assert.match(row, /className="text-body-sm text-content-tertiary flex-1" numberOfLines=\{2\}/);
  // A fixed footprint so the verdict replaces "Checking…" in place.
  assert.match(row, /min-h-\[44px\]/);
});

test('the quiet-state input is fed from the same notice list both surfaces use', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  const fn = section.slice(
    section.indexOf('export function homeAttentionQuietStateFor'),
    section.indexOf('interface HomeAttentionQuietRowProps')
  );
  assert.match(fn, /noticeCount: attentionStateNotices\(feed\)\.length,/);
  assert.match(fn, /isClean: feed\.isClean,/);
  assert.match(fn, /checkedCount: feed\.checkedCount,/);
});

test('Home always mounts the section; the impression keeps its old gate', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  assert.match(home, /\n\s*<AttentionFeedSection feed=\{attentionFeed\} \/>/);
  assert.doesNotMatch(home, /\? <AttentionFeedSection/);
  assert.match(home, /const attentionHasContent = homeAttentionHasContent\(attentionFeed\);/);
  assert.match(home, /useAttentionImpression\('home', attentionFeed, isTabFocused && attentionHasContent\);/);
});

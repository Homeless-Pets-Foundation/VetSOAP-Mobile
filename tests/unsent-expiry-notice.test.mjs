// Rule 13 warn-first for 30-day-old unsent work. The shipped flow was a modal
// on Record-tab mount (i.e. as an exam started) that listed nothing, offered
// no Submit despite its copy, and whose one-tap "Delete" removed every expired
// draft (server row included) and every expired stash. The ≥23-day heads-up
// was a __DEV__ console.log. Now: a non-modal banner whose Review opens the
// list where each recording is handled on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

async function evictionEffect() {
  const src = await read('app/(app)/(tabs)/record.tsx');
  const start = src.indexOf("scheduleNonUrgentWork('thirty_day_eviction'");
  const end = src.indexOf('const handleResumeStash', start);
  assert.ok(start >= 0 && end > start, 'eviction effect found');
  return { src, effect: src.slice(start, end) };
}

test('the eviction sweep never bulk-deletes and never opens a modal', async () => {
  const { effect } = await evictionEffect();
  assert.doesNotMatch(effect, /Alert\.alert/);
  assert.doesNotMatch(effect, /recordingsApi\.delete/);
  assert.doesNotMatch(effect, /deleteDraftForUser|deleteStash\(/);
});

test('≥30 days and ≥23 days both surface a notice', async () => {
  const { effect } = await evictionEffect();
  assert.match(effect, /if \(totalExpired > 0\) \{\s*setExpiryNotice\(\{\s*expired: true,/);
  assert.match(effect, /else if \(totalExpiring > 0\) \{\s*setExpiryNotice\(\{\s*expired: false,/);
  assert.doesNotMatch(effect, /approaching 30-day expiry/, 'the dev-only log is gone');
});

test('the notice is a non-modal banner whose Review goes where the recordings are', async () => {
  const { src } = await evictionEffect();
  const banner = src.slice(src.indexOf('{expiryNotice ? ('), src.indexOf('{/* Pending Drafts Banner */}'));
  assert.match(banner, /<Banner/);
  assert.match(banner, /dismissible/);
  assert.match(banner, /router\.navigate\('\/recordings\?status=draft' as never\)/);
  assert.match(banner, /setForceShowStashList\(true\)/);
});

test('copy lives in the catalog and never threatens automatic deletion', async () => {
  const strings = await read('src/constants/strings.ts');
  const block = strings.slice(strings.indexOf('export const RECORD_EXPIRY_COPY'), strings.indexOf('export const RECORD_BANNERS'));
  assert.ok(block.includes('expired:') && block.includes('expiring:') && block.includes("review: 'Review'"));
  assert.doesNotMatch(block, /will be deleted|expire[sd]? (?:and|on)/i);
});

test('Recordings honors ?status=draft once, clearing it without navigating', async () => {
  const src = await read('app/(app)/(tabs)/recordings/index.tsx');
  assert.match(src, /if \(statusParam !== 'draft'\) return;\s*setSelectedStatusFilter\('draft'\);\s*router\.setParams\(\{ status: undefined \}\);/);
});

test('attention links land on the drafts / saved sessions themselves', async () => {
  const feed = await read('src/lib/attentionFeed.ts');
  assert.match(feed, /\{ kind: 'recordings_list', status: 'draft' \}/);
  assert.match(feed, /\{ kind: 'record_tab', showSavedSessions: true \}/);
  const section = await read('src/components/AttentionFeedSection.tsx');
  assert.match(section, /destination\.status === 'draft' \? '\/recordings\?status=draft' : '\/recordings'/);
  assert.match(section, /destination\.showSavedSessions \? '\/record\?showSavedSessions=1' : '\/record'/);
});

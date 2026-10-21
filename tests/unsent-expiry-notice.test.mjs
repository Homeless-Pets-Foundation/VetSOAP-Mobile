// Rule 13 warn-first for 30-day-old unsent work. The shipped flow was a modal
// on Record-tab mount (i.e. as an exam started) that listed nothing, offered
// no Submit despite its copy, and whose one-tap "Delete" removed every expired
// draft (server row included) and every expired stash. The ≥23-day heads-up
// was a __DEV__ console.log. Now: a non-modal banner whose Review opens the
// list where each recording is handled on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

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
  // Codex review on PR #252 (round 2): one notice carries BOTH cohorts — an
  // expired recording used to hide the 23–29-day ones for the whole session.
  assert.match(
    effect,
    /if \(totalExpired \+ totalExpiring > 0\) \{\s*setExpiryNotice\(\{\s*expiredCount: totalExpired,\s*expiringCount: totalExpiring,\s*draftCount: expiredDraftCount \+ expiringDraftCount,\s*savedSessionRecordingCount: expiredSessionRecordings \+ expiringSessionRecordings,/,
  );
  assert.doesNotMatch(effect, /approaching 30-day expiry/, 'the dev-only log is gone');
});

// Codex review on PR #252: drafts were counted one each but saved SESSIONS one
// each too, so a 5-patient session read as "1 recording".
test('counts are in one unit: recordings, with saved sessions counted per slot', async () => {
  const { effect } = await evictionEffect();
  assert.match(effect, /countUnsentStashRecordings\(stashResult\.expired\)/);
  assert.match(effect, /countUnsentStashRecordings\(stashResult\.expiring\)/);
  assert.doesNotMatch(effect, /expiredStashes\.length|stashResult\.(?:expired|expiring)\.length/);
});

// Codex review on PR #252: the tab outlives a shared-tablet user switch, and a
// sweep with nothing to report left the previous vet's notice up.
test('the notice is cleared on every user-scope change and on an empty sweep', async () => {
  const { src, effect } = await evictionEffect();
  const head = src.slice(src.indexOf('const [expiryNotice, setExpiryNotice]'), src.indexOf("scheduleNonUrgentWork('thirty_day_eviction'"));
  assert.match(
    head,
    /if \(!user\?\.id\) \{\s*(?:\/\/[^\n]*\n\s*)*setExpiryNotice\(null\);\s*evictionSweptUserRef\.current = null;\s*return;/,
    'signed out: cleared, and the next sign-in sweeps again',
  );
  assert.match(
    head,
    /const isRecheck = evictionSweptUserRef\.current === user\.id;[\s\S]*?if \(!isRecheck\) \{\s*(?:\/\/[^\n]*\n\s*)*setExpiryNotice\(null\);/,
    'a different user starts clean',
  );
  assert.match(effect, /\} else \{\s*setExpiryNotice\(null\);\s*\}/);
});

// Codex review on PR #252 (round 2): the sweep ran once per user, so the
// banner kept a stale count after the vet submitted/deleted what it counted.
test('while a notice is up, it is re-checked on return to the tab and on saved-session changes', async () => {
  const { src } = await evictionEffect();
  assert.match(
    src,
    /navigation\.addListener\('focus', \(\) => \{\s*if \(expiryNoticeRef\.current\) setExpiryRecheck\(\(n\) => n \+ 1\);/,
  );
  assert.match(src, /useEffect\(\(\) => \{\s*if \(expiryNoticeRef\.current\) setExpiryRecheck\(\(n\) => n \+ 1\);\s*\}, \[stashCount\]\);/);
  assert.match(src, /if \(isRecheck && expiryRecheck === expiryRecheckSweptRef\.current\) return;/);
  assert.match(src, /\}, \[user\?\.id, expiryRecheck\]\);/);
  // A re-check is the same serialized sweep (Keystore load stays queued
  // behind the other startup sweeps; sweep-serialization fences the args).
});

test('the notice is a non-modal banner whose Review goes where the recordings are', async () => {
  const { src } = await evictionEffect();
  const banner = src.slice(src.indexOf('{expiryNotice ? ('), src.indexOf('{/* Pending Drafts Banner */}'));
  assert.match(banner, /<Banner/);
  assert.match(banner, /dismissible/);
  assert.match(banner, /onDismiss=\{\(\) => setExpiryNotice\(null\)\}/);
  // Review is offered only when drafts are involved, and opens them.
  assert.match(banner, /expiryNotice\.draftCount > 0\s*\?\s*\{\s*label: RECORD_EXPIRY_COPY\.review,/);
  assert.match(banner, /router\.navigate\('\/recordings\?status=draft' as never\)/);
  assert.match(banner, /variant=\{expiryNotice\.expiredCount > 0 \? 'warning' : 'info'\}/);
  assert.match(
    banner,
    /RECORD_EXPIRY_COPY\.message\(\{\s*expired: expiryNotice\.expiredCount,\s*expiring: expiryNotice\.expiringCount,\s*drafts: expiryNotice\.draftCount,\s*inSavedSessions: expiryNotice\.savedSessionRecordingCount,\s*\}\)/,
  );
});

// Codex review on PR #252: with drafts AND saved sessions, Review reached only
// the drafts, and saved sessions stay hidden while unsaved work is open.
test('saved-session work the notice counts is listed on the Record screen', async () => {
  const { src } = await evictionEffect();
  assert.match(src, /const expiryNoticeCoversSavedSessions = \(expiryNotice\?\.savedSessionRecordingCount \?\? 0\) > 0;/);
  assert.match(
    src,
    /\(!hasUnsavedRecordings \|\| forceShowStashList \|\| expiryNoticeCoversSavedSessions\)/,
  );
});

test('the copy says where each source is', async () => {
  const { RECORD_EXPIRY_COPY } = await loadTsModule('src/constants/strings.ts');
  assert.equal(RECORD_EXPIRY_COPY.where(2, 0), 'Review to submit or delete them.');
  assert.equal(RECORD_EXPIRY_COPY.where(1, 0), 'Review to submit or delete it.');
  assert.match(RECORD_EXPIRY_COPY.where(0, 5), /^They’re under Saved Sessions on this screen\.$/);
  assert.match(RECORD_EXPIRY_COPY.where(3, 4), /^4 are under Saved Sessions on this screen; Review opens the other 3\.$/);
  assert.match(RECORD_EXPIRY_COPY.expired(1), /^1 unsent recording is over 30 days old/);
  assert.equal(
    RECORD_EXPIRY_COPY.message({ expired: 2, expiring: 1, drafts: 3, inSavedSessions: 0 }),
    '2 unsent recordings are over 30 days old on this device. 1 more is nearly 30 days old. Review to submit or delete them.',
    'mixed ages: expired first, the expiring cohort still named',
  );
  assert.equal(
    RECORD_EXPIRY_COPY.message({ expired: 0, expiring: 1, drafts: 0, inSavedSessions: 1 }),
    '1 unsent recording is nearly 30 days old and still not submitted. It’s under Saved Sessions on this screen.',
  );
});

test('copy lives in the catalog and never threatens automatic deletion', async () => {
  const strings = await read('src/constants/strings.ts');
  const block = strings.slice(strings.indexOf('const expiryExpiredLine'), strings.indexOf('export const RECORD_BANNERS'));
  assert.ok(block.includes('expired:') && block.includes('expiring:') && block.includes("review: 'Review'"));
  assert.doesNotMatch(block, /will be deleted|expire[sd]? (?:and|on)/i);
});

test('Recordings honors ?status=draft once, clearing it without navigating', async () => {
  const src = await read('app/(app)/(tabs)/recordings/index.tsx');
  assert.match(
    src,
    /if \(statusParam !== 'draft'\) return;\s*filterFromLinkRef\.current = true;\s*setSelectedStatusFilter\('draft'\);\s*router\.setParams\(\{ status: undefined \}\);/,
  );
});

// Codex review on PR #252: the list stays mounted, so the link's filter
// outlived the visit and pinned later ordinary visits to Not Submitted.
test('the link-applied filter is dropped when the vet leaves the tab, a chosen one is kept', async () => {
  const src = await read('app/(app)/(tabs)/recordings/index.tsx');
  // TAB blur (the parent) — opening a draft's detail pushes onto this stack
  // and must keep the filter for the way back.
  assert.match(
    src,
    /const tabNavigation = navigation\.getParent\(\) \?\? navigation;\s*return tabNavigation\.addListener\('blur', \(\) => \{\s*if \(!filterFromLinkRef\.current\) return;\s*filterFromLinkRef\.current = false;\s*setSelectedStatusFilter\('all'\);/,
  );
  assert.match(src, /onValueChange=\{\(value\) => \{\s*filterFromLinkRef\.current = false;\s*setSelectedStatusFilter\(value\);/);
});

test('attention links land on the drafts / saved sessions themselves', async () => {
  const feed = await read('src/lib/attentionFeed.ts');
  assert.match(feed, /\{ kind: 'recordings_list', status: 'draft' \}/);
  assert.match(feed, /\{ kind: 'record_tab', showSavedSessions: true \}/);
  const section = await read('src/components/AttentionFeedSection.tsx');
  assert.match(section, /destination\.status === 'draft' \? '\/recordings\?status=draft' : '\/recordings'/);
  assert.match(section, /destination\.showSavedSessions \? '\/record\?showSavedSessions=1' : '\/record'/);
});

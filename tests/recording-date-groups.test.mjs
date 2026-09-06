import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

// Recordings list date groups (Today / Yesterday / This week / Earlier),
// layout tier 3 (2026-09-02). Pure helper, executed here — a wrong day
// boundary would file this morning's visit under "Yesterday".

const load = () => loadTsModule('src/lib/recordingDateGroups.ts');
const DAY = 24 * 60 * 60 * 1000;
// Local noon avoids DST edge cases in the arithmetic below.
const now = new Date(2026, 8, 2, 12, 0, 0, 0).getTime();
const startOfToday = new Date(2026, 8, 2, 0, 0, 0, 0).getTime();

test('dateGroupKeyFor uses local calendar-day boundaries', async () => {
  const { dateGroupKeyFor } = await load();
  assert.equal(dateGroupKeyFor(startOfToday, now), 'today');
  assert.equal(dateGroupKeyFor(startOfToday - 1, now), 'yesterday');
  assert.equal(dateGroupKeyFor(startOfToday - DAY, now), 'yesterday');
  assert.equal(dateGroupKeyFor(startOfToday - DAY - 1, now), 'this_week');
  assert.equal(dateGroupKeyFor(startOfToday - 6 * DAY, now), 'this_week');
  assert.equal(dateGroupKeyFor(startOfToday - 6 * DAY - 1, now), 'earlier');
  assert.equal(dateGroupKeyFor(startOfToday - 30 * DAY, now), 'earlier');
});

test('dateGroupKeyFor: the future and clock skew read as today; junk reads as earlier', async () => {
  const { dateGroupKeyFor } = await load();
  assert.equal(dateGroupKeyFor(now + DAY, now), 'today');
  assert.equal(dateGroupKeyFor(0, now), 'earlier');
  assert.equal(dateGroupKeyFor(NaN, now), 'earlier');
});

test('groupRecordingsByDate omits empty groups and keeps incoming order inside a group', async () => {
  const { groupRecordingsByDate } = await load();
  const rec = (id, submittedAt, createdAt) => ({ id, submittedAt, createdAt });
  const iso = (ms) => new Date(ms).toISOString();
  const sections = groupRecordingsByDate(
    [
      rec('pinned', null, iso(now - 1000)), // createdAt fallback (no submittedAt)
      rec('a', iso(now - 2000), iso(now - 40 * DAY)), // submittedAt wins over createdAt
      rec('old', iso(now - 20 * DAY), null),
      rec('b', iso(startOfToday - DAY + 1000), null),
    ],
    now
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(sections.map((s) => ({ key: s.key, ids: s.data.map((r) => r.id) })))),
    [
      { key: 'today', ids: ['pinned', 'a'] },
      { key: 'yesterday', ids: ['b'] },
      { key: 'earlier', ids: ['old'] },
    ]
  );
  assert.equal(groupRecordingsByDate([], now).length, 0);
});

test('dateGroupKeyFor walks calendar days, so DST cannot shift the boundaries', async () => {
  const { dateGroupKeyFor } = await load();
  // US fall-back 2026-11-01 (a 25h local day) and spring-forward 2026-03-08 (23h).
  // Subtracting a fixed 24h from start-of-today lands an hour off on both.
  const afterFallBack = new Date(2026, 10, 2, 12, 0, 0, 0).getTime();
  const yesterday0030 = new Date(2026, 10, 1, 0, 30, 0, 0).getTime();
  assert.equal(dateGroupKeyFor(yesterday0030, afterFallBack), 'yesterday');

  const afterSpringForward = new Date(2026, 2, 9, 12, 0, 0, 0).getTime();
  const twoDaysAgo2330 = new Date(2026, 2, 7, 23, 30, 0, 0).getTime();
  assert.equal(dateGroupKeyFor(twoDaysAgo2330, afterSpringForward), 'this_week');
  const yesterday2330 = new Date(2026, 2, 8, 23, 30, 0, 0).getTime();
  assert.equal(dateGroupKeyFor(yesterday2330, afterSpringForward), 'yesterday');
});

test('groupRecordingsByDate forces pinned just-submitted rows into Today', async () => {
  const { groupRecordingsByDate } = await load();
  const iso = (ms) => new Date(ms).toISOString();
  // A resumed three-day-old draft: no submittedAt, so the createdAt fallback
  // would file it under "This week", several sections below the banner.
  const resumedDraft = { id: 'resumed', submittedAt: null, createdAt: iso(now - 3 * DAY) };
  const older = { id: 'older', submittedAt: iso(now - 20 * DAY), createdAt: null };

  const unpinned = groupRecordingsByDate([resumedDraft, older], now);
  assert.deepEqual(JSON.parse(JSON.stringify(unpinned.map((s) => s.key))), ['this_week', 'earlier']);

  const pinnedSections = groupRecordingsByDate([resumedDraft, older], now, ['resumed']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pinnedSections.map((s) => ({ key: s.key, ids: s.data.map((r) => r.id) })))),
    [
      { key: 'today', ids: ['resumed'] },
      { key: 'earlier', ids: ['older'] },
    ]
  );
});

test('group titles come from the copy catalog', async () => {
  const { groupRecordingsByDate } = await load();
  const [section] = groupRecordingsByDate([{ id: 'x', createdAt: new Date(now).toISOString() }], now);
  assert.equal(section.title, 'Today');
});

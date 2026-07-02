// Regression for finding O6: countUnsentRecordings under-reported unsent work
// because it excluded RESUMED stashes. A resumed-but-unsubmitted stash is unsent
// work that nothing else represents (its draft was deleted at stash time and not
// recreated on resume), so it MUST be counted — otherwise the sign-out /
// delete-account warning shows a generic prompt with no count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

// unsentCount.ts imports only a TYPE from ../types/stash (erased at transpile),
// so it loads with no mocks.
const mod = await loadTsModule('src/lib/unsentCount.ts');

test('countUnsentStashSessions counts resumed stashes as unsent (O6)', () => {
  const sessions = [
    { id: 'a', resumedAt: '2026-07-01T00:00:00.000Z' }, // resumed, not yet submitted
    { id: 'b', resumedAt: null }, // never resumed
    { id: 'c' }, // resumedAt absent
  ];
  // Was 1 (only the un-resumed) before the fix — the resumed stash is now included.
  assert.equal(mod.countUnsentStashSessions(sessions), 3);
});

test('countUnsentStashSessions returns 0 for no sessions', () => {
  assert.equal(mod.countUnsentStashSessions([]), 0);
});

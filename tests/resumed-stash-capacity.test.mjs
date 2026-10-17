import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// A resumed saved session keeps its stash entry pinned (`resumedAt`) until the
// active session is resolved. Re-saving it must replace that entry, not add a
// sixth: at MAX_STASHES the user was told "Saved Sessions Full" for the session
// they had just resumed (device test 2026-10-16). The storage swap is executed
// in storage-read-cache.test.mjs; these are the wiring fences.

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('capacity ignores the pinned entry the active session will replace', async () => {
  const hook = stripComments(await read('src/hooks/useStashedSessions.ts'));
  assert.match(hook, /isAtCapacity: visibleStashes\.length >= MAX_STASHES/);
  assert.doesNotMatch(hook, /isAtCapacity: allStashes\.length/);
  assert.match(hook, /async \(sessionState: SessionState, replacingStashId: string \| null = null\)/);
  assert.match(hook, /stashStorage\.addStashedSession\(stashedSession, replacingStashId\)/);
});

test('both stash paths pass the stash the session was resumed from', async () => {
  const record = stripComments(await read('app/(app)/(tabs)/record.tsx'));
  const calls = record.match(/await stashSession\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 2, 'manual Save for Later and network-death auto-stash');
  for (const call of calls) {
    assert.match(call, /, resumedFromStashIdRef\.current\)$/);
  }
  // The audio dir of the replaced entry is still released after the commit.
  assert.equal((record.match(/releaseResumedStashIfAny\(\);/g) ?? []).length >= 2, true);
});

test('storage drops the replaced entry before applying the cap', async () => {
  const storage = stripComments(await read('src/lib/stashStorage.ts'));
  const add = storage.slice(storage.indexOf('async addStashedSession('), storage.indexOf('async removeStashedSession('));
  assert.match(add, /replacingId: string \| null = null/);
  assert.match(add, /const kept = replacingId \? existing\.filter\(\(s\) => s\.id !== replacingId\) : existing;/);
  assert.match(add, /if \(kept\.length >= MAX_STASHES\) return false;/);
  assert.match(add, /return await this\.saveStashedSessions\(kept\);/);
});

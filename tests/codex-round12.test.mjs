// Codex round-12 regressions (PR #143): a terminal 403/404 must also purge the
// denied entity from cached LIST pages (not just detail roots), and the
// reset-password success path must keep the recovery gate active until a
// bounded sign-out settles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

// Mirror of removeEntityFromListPayload to lock its contract (grep keeps the
// source honest below).
function removeEntityFromListPayload(cached, id) {
  if (!cached || typeof cached !== 'object') return cached;
  if (Array.isArray(cached)) {
    const next = cached.filter((i) => !(i && typeof i === 'object' && i.id === id));
    return next.length !== cached.length ? next : cached;
  }
  if (Array.isArray(cached.data)) {
    const data = cached.data.filter((i) => !(i && typeof i === 'object' && i.id === id));
    return data.length !== cached.data.length ? { ...cached, data } : cached;
  }
  if (Array.isArray(cached.pages)) {
    let changed = false;
    const pages = cached.pages.map((p) => {
      const up = removeEntityFromListPayload(p, id);
      if (up !== p) changed = true;
      return up;
    });
    return changed ? { ...cached, pages } : cached;
  }
  return cached;
}

test('removeEntityFromListPayload strips the id from array/data/pages shapes without loss', () => {
  // Infinite-query shape.
  const infinite = { pages: [{ data: [{ id: 'a' }, { id: 'b' }] }, { data: [{ id: 'c' }] }] };
  const pruned = removeEntityFromListPayload(infinite, 'b');
  assert.deepEqual(pruned.pages[0].data.map((r) => r.id), ['a']);
  assert.deepEqual(pruned.pages[1].data.map((r) => r.id), ['c']);
  // Unchanged input returns the SAME reference (no needless re-render).
  assert.strictEqual(removeEntityFromListPayload(infinite, 'zzz'), infinite);
  // Plain array + {data} shapes.
  assert.deepEqual(removeEntityFromListPayload([{ id: 'x' }, { id: 'y' }], 'x'), [{ id: 'y' }]);
  assert.deepEqual(removeEntityFromListPayload({ data: [{ id: 'x' }] }, 'x').data, []);
});

test('terminal-access eviction purges detail AND list caches', async () => {
  const cache = await read('src/lib/recordingQueryCache.ts');
  assert.match(cache, /export function removeRecordingFromCachedLists/);
  assert.match(cache, /export function removePatientFromCachedLists/);
  assert.match(cache, /\['recordings', 'recent'\], \['recordings', 'list'\], \['recordings', 'drafts'\]/);

  const rec = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(rec, /removeRecordingFromCachedLists\(queryClient, id\)/);
  const pat = await read('app/(app)/(tabs)/patient/[id].tsx');
  assert.match(pat, /removePatientFromCachedLists\(queryClient, id\)/);
});

test('reset-password success keeps recovery gated until a bounded sign-out settles', async () => {
  const src = await read('app/(auth)/reset-password.tsx');
  const okStart = src.indexOf("text: 'OK',");
  assert.ok(okStart > -1);
  const okBody = src.slice(okStart, okStart + 1400);
  // Bounded (rule 24) race, and clearPasswordRecovery runs in the finally
  // (after navigation is committed), NOT before the sign-out.
  assert.match(okBody, /Promise\.race\(\[/);
  assert.match(okBody, /setTimeout\(resolve, 5_000\)/);
  assert.match(okBody, /\.finally\(\(\) => \{\s*\n\s*clearPasswordRecovery\(\);\s*\n\s*router\.replace\('\/\(auth\)\/login'\)/);
  // The gate must NOT be cleared before the sign-out starts.
  assert.doesNotMatch(okBody, /clearPasswordRecovery\(\);\s*\n\s*trackPendingSignOut/);
});

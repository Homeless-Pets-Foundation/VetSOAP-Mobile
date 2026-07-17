// WP28 — offline query persistence must stay user-scoped (rule 13) and
// allowlist-only: clinical reads persist; auth/session/device/billing never do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('persistence is user-keyed, allowlisted, and success-only', async () => {
  const src = await read('src/lib/queryPersistence.ts');
  assert.match(src, /captivet_rq_cache_\$\{userId\}/);
  assert.match(src, /shouldDehydrateQuery: shouldPersistQuery/);
  // Persist on data-present, NOT status==='success': an offline refetch of a
  // hydrated query flips status to 'error' with data intact, and requiring
  // 'success' made the next write drop the only usable cached data (Codex P2
  // round 4). Queries that never held data are still excluded.
  assert.match(src, /if \(query\.state\.data === undefined\) return false;/);
  assert.doesNotMatch(src, /query\.state\.status === 'success'/);
  // Only DEFAULT list variants are persisted — every search/filter key would
  // otherwise accumulate on disk unbounded (Codex P2 round 10).
  assert.match(src, /function isPersistableListVariant/);
  assert.match(src, /if \(!isPersistableListVariant\(query\.queryKey\)\) return false;/);
  // Expire by the query's OWN dataUpdatedAt, not the snapshot envelope (Codex
  // P2 round 10) — else a repeatedly-rewritten stale entry lives forever.
  assert.match(src, /query\.state\.dataUpdatedAt/);
  assert.match(src, /Date\.now\(\) - updatedAt > PERSIST_MAX_AGE_MS/);
  for (const allowed of ['recordings', 'recording', 'soapNote', 'patients', 'patient']) {
    assert.ok(src.includes(`'${allowed}'`), `${allowed} should be persistable`);
  }
  for (const forbidden of ['device-sessions', 'orgAiModels', 'provider-issues', 'subscription']) {
    assert.ok(!src.includes(`'${forbidden}'`), `${forbidden} must never be persisted`);
  }
  // Never throw at module load / activation (rule 1).
  assert.match(src, /catch \(error\) \{\s*\n\s*if \(__DEV__\)/);
});

test('a restore that outlives its persistence scope is discarded before hydration', async () => {
  const src = await read('src/lib/queryPersistence.ts');
  // persistQueryClient's async restore cannot be cancelled; if sign-out or a
  // user switch happened while the AsyncStorage read was in flight, the stale
  // payload must be discarded BEFORE hydration (returning undefined from the
  // guarded persister) — never by clearing the shared client afterwards,
  // which would wipe a successor scope's live data and then persist the empty
  // cache over that user's snapshot (Codex P1 + P2 round 5).
  assert.match(src, /const restoreGeneration = \+\+generation/);
  assert.match(src, /const guardedPersister: Persister = \{/);
  assert.match(src, /return generation === restoreGeneration \? restored : undefined/);
  assert.match(src, /persister: guardedPersister/);
  assert.doesNotMatch(src, /generation !== restoreGeneration\) queryClient\.clear\(\)/);
  // Rule 4: the restore promise MUST be observed — persistQueryClient returns
  // the restore as the second tuple item, and discarding it leaves any
  // rejection (AsyncStorage I/O failure) unhandled → Hermes release crash
  // (Codex P1 round 6). The guarded persister also swallows read errors.
  assert.match(src, /const \[unsubscribe, restorePromise\] = persistQueryClient\(/);
  assert.match(src, /Promise\.resolve\(restorePromise\)\.catch\(/);
  assert.match(src, /restore read failed/);
  // Writes are best-effort too: the persistence subscription invokes
  // persistClient with no observing caller, so a rejected AsyncStorage write
  // (storage full) must be swallowed, not crash Hermes (Codex P1 round 7).
  assert.match(src, /persistClient: async \(client\) => \{/);
  assert.match(src, /persist write failed/);
  // A write queued inside the persister's throttle window can land AFTER
  // sign-out's removeClient and recreate the outgoing user's snapshot — the
  // sweep must re-run once the window settles (Codex P2 round 8)…
  assert.match(src, /setTimeout\(\(\) => \{[\s\S]*?PERSIST_THROTTLE_MS \+ 1000\)/);
  // …but must SKIP if the same user re-signed in within the window and a
  // fresh persister now owns this exact key — else it wipes the new session's
  // snapshot (Codex P2 round 9).
  assert.match(src, /if \(active\?\.userId === current\.userId\) return;/);
  // Stop must invalidate any in-flight restore.
  const stopStart = src.indexOf('export function stopQueryPersistence');
  assert.match(src.slice(stopStart, stopStart + 300), /generation \+= 1/);
});

test('AuthProvider starts persistence with the user scope and removes it on sign-out', async () => {
  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /startQueryPersistence\(scopedUserId\)/);
  // Both sign-out paths (explicit + involuntary) remove the stored snapshot
  // alongside queryClient.clear().
  const removals = auth.match(/stopQueryPersistence\(\{ removeStored: true \}\)/g) ?? [];
  assert.ok(removals.length >= 2, `expected >=2 removeStored sites, found ${removals.length}`);
});

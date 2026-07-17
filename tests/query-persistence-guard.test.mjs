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
  assert.match(src, /query\.state\.status === 'success'/);
  for (const allowed of ['recordings', 'recording', 'soapNote', 'patients', 'patient']) {
    assert.ok(src.includes(`'${allowed}'`), `${allowed} should be persistable`);
  }
  for (const forbidden of ['device-sessions', 'orgAiModels', 'provider-issues', 'subscription']) {
    assert.ok(!src.includes(`'${forbidden}'`), `${forbidden} must never be persisted`);
  }
  // Never throw at module load / activation (rule 1).
  assert.match(src, /catch \(error\) \{\s*\n\s*if \(__DEV__\)/);
});

test('a restore that outlives its persistence scope is wiped, not leaked', async () => {
  const src = await read('src/lib/queryPersistence.ts');
  // persistQueryClient's async restore cannot be cancelled; if sign-out ran
  // before it settled, the late hydration must be cleared so the outgoing
  // user's clinical data never survives into the next session (Codex P1).
  assert.match(src, /const \[unsubscribe, restorePromise\] = persistQueryClient\(/);
  assert.match(src, /const restoreGeneration = \+\+generation/);
  assert.match(src, /if \(generation !== restoreGeneration\) queryClient\.clear\(\)/);
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

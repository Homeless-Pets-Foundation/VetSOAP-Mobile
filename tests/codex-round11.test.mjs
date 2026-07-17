// Codex round-11 regressions (PR #143): a definitive 403 (access revoked) or
// 404 (deleted) must be terminal even when offline-persisted data exists — the
// cached transcript/SOAP/audio and patient profile must stop rendering and be
// evicted, not kept behind the offline-cache fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('recording detail treats 403/404 as terminal and evicts the cached record', async () => {
  const src = await read('app/(app)/(tabs)/recordings/[id].tsx');
  // Latch the terminal status…
  assert.match(src, /const \[accessRevoked, setAccessRevoked\] = useState<\{ status: number \} \| null>\(null\)/);
  assert.match(src, /error\.status === 403 \|\| error\.status === 404/);
  // …disable the query so eviction can't spawn a refetch loop…
  assert.match(src, /enabled: !!id && !accessRevoked/);
  // …evict recording + soapNote + tasks so nothing lingers in the snapshot…
  assert.match(src, /queryClient\.removeQueries\(\{ queryKey: \['recording', id\] \}\)/);
  assert.match(src, /queryClient\.removeQueries\(\{ queryKey: \['soapNote', id\] \}\)/);
  // …and render a terminal screen BEFORE the offline-cache fallback branch.
  const revokedIdx = src.indexOf('if (accessRevoked) {');
  const cachedFallbackIdx = src.indexOf('if (isError && !recording) {');
  assert.ok(revokedIdx > -1 && cachedFallbackIdx > revokedIdx, 'accessRevoked gate must precede the cached fallback');
  // Reset when navigating to a different recording.
  assert.match(src, /setAccessRevoked\(null\); \/\/ reset when navigating to a different recording/);
});

test('patient detail treats 403/404 as terminal and evicts the cached profile', async () => {
  const src = await read('app/(app)/(tabs)/patient/[id].tsx');
  assert.match(src, /const \[accessRevoked, setAccessRevoked\] = useState<\{ status: number \} \| null>\(null\)/);
  assert.match(src, /error\.status === 403 \|\| error\.status === 404/);
  assert.match(src, /enabled: !!id && !accessRevoked/);
  assert.match(src, /enabled: !!id && activeTab === 'visits' && !accessRevoked/);
  assert.match(src, /queryClient\.removeQueries\(\{ queryKey: \['patient', id\] \}\)/);
  // Terminal render branch comes right after the loading branch.
  assert.match(src, /\) : accessRevoked \? \(/);
});

/**
 * Codex review round 9 on PR #204.
 *
 * F1 invalidated the round-8 justification. I argued a torn value fails
 * JSON.parse and reads as absent — true for a MULTI-chunk value, but these lists
 * are usually ONE chunk with an unchanged count, so a late `_chunk_0` write
 * lands as fully-valid stale JSON and resurrects a pointer for a recording that
 * already finished. That is a fabricated kill report, the exact thing this
 * detector must never produce. Hence generation-namespaced writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---- F1: a late chunk write must not republish stale state ----------------

test('a late single-chunk write cannot resurrect a cleared pointer', async (t) => {
  t.diagnostic('waits out the 5s mutation deadline');
  const store = new Map();
  let gateWrites = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        // Only the chunk write stalls; the pointer write is never reached by the
        // abandoned op, which is the whole point.
        if (gateWrites && k.includes('_chunk_')) { await gate; }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  await s.setActive('live', 'slot-live', '2026-09-04T09:00:00.000Z', 'expo');

  // This write stalls in setItemAsync(_chunk_0) and is abandoned at the deadline.
  gateWrites = true;
  const abandoned = s.setActive('stale', 'slot-stale', '2026-09-04T10:00:00.000Z', 'expo');
  await abandoned;

  // The recording finishes normally and its pointer is cleared.
  gateWrites = false;
  await s.clearActive('live');

  // Now the abandoned chunk write finally lands.
  release();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 40));

  const list = await s.list();
  assert.ok(!list.some((e) => e.recordingId === 'live'), 'a cleared pointer must stay cleared');
  assert.ok(!list.some((e) => e.recordingId === 'stale'), 'an abandoned op must never publish');
});

test('writes are generation-namespaced and publish through a single pointer key', () => {
  const src = read('src/lib/durableAudio/chunkedStore.ts');
  assert.match(src, /const GEN_RING = 8;/);
  assert.match(src, /\$\{prefix\}_g\$\{gen\}_chunk_\$\{i\}/);
  assert.match(src, /\$\{prefix\}_ptr/);
  // A ring, so reuse overwrites in place and no per-write delete is needed —
  // setActive runs before the mic opens.
  // Handed out per ATTEMPT, not per publish: an abandoned write never advances
  // the pointer, so deriving from it would give the next write the same
  // generation the abandoned one is still writing into.
  assert.match(src, /const lastHandedOutGen = new Map<string, number>\(\);/);
  assert.match(src, /const base = seen \?\? current\?\.g \?\? -1;/);
  // Round 24: the candidate now skips generations whose write has not settled,
  // so the ring cannot wrap onto a slot a hung write may still land on.
  assert.match(src, /let gen = \(base \+ 1\) % GEN_RING;/);
  assert.match(src, /reserved\.has\(gen\)/);
  assert.match(src, /const inFlightGenerations = new Map<string, Set<number>>\(\);/);
});

test('the versioned reader falls back to the legacy layout for existing installs', () => {
  const src = read('src/lib/durableAudio/chunkedStore.ts');
  const fn = src.slice(
    src.indexOf('async function readVersionedInternal('),
    src.indexOf('const GEN_RING'),
  );
  // Round 25: the legacy read is STRICT too — a failed one must not read as an
  // empty store, or setActive publishes over a prior unclean-exit pointer.
  assert.match(fn, /const legacy = await readChunkedValueStrict\(prefix\);/);
  assert.match(fn, /if \(legacy\.status === 'unavailable'\) return \{ value: null, readable: false \};/);
  // ...but ONLY when the pointer is proven absent. A failed or corrupt read must
  // not revive a pre-migration list (Codex round 14).
  assert.match(fn, /if \(rawPtr !== null\) return \{ value: null, readable: false \};/);
  assert.match(fn, /getRawItemStrict/);
});

// ---- F2: telemetry must never block a recovery offer ----------------------

test('the kill probe is detached and bounded, off the recovery critical path', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /const UNCLEAN_EXIT_PROBE_TIMEOUT_MS = [\d_]+;/);
  assert.match(src, /function reportPriorUncleanExitDetached/);
  assert.match(src, /void withPromiseTimeout\(\s*reportPriorUncleanExit\(/);
  // Nothing may await the probe: the scan watchdog would publish an empty offer
  // list and the real offers could never be published afterwards.
  assert.doesNotMatch(src, /await reportPriorUncleanExit\(/);
});

// ---- F3: sign-out during a live capture -----------------------------------

test('unmounting the Record screen clears a live capture pointer', () => {
  // Signing out mid-capture runs no Finish, discard or interruption path, and
  // durable pointer keys deliberately survive secureStorage.clearAll() — so
  // without this the next launch reports that Android stopped a recording the
  // user ended by logging out.
  const src = read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /const liveCaptureRef = useRef<\{/);
  const idx = src.indexOf('const liveCaptureRef');
  // Bounded by the next declaration, not a fixed char count: the teardown grew
  // when it gained the native finalize (round 17) and a fixed slice silently
  // dropped the tail assertions.
  const block = src.slice(idx, src.indexOf('const handlePause = useCallback(', idx));
  assert.ok(block.length > 0, 'teardown block anchor');
  assert.match(block, /return \(\) => \{/);
  // Explicit user, not ambient scope: sign-out nulls the scope BEFORE unmount.
  assert.match(block, /durableActiveStore\.clearActiveForUser\(userId, slotId\)/);
  assert.match(block, /durableActiveStore\.clearActiveForUser\(userId, durableId\)/);
  // Round 17: a DURABLE capture is finalized first — clearing the breadcrumb
  // while the native singleton kept recording stranded the mic and blocked the
  // next user with BUSY.
  assert.ok(
    block.indexOf('durableRecorder.stop(') < block.indexOf('clearActiveForUser(userId, durableId)'),
    'the native finalize must precede the pointer clear',
  );
});

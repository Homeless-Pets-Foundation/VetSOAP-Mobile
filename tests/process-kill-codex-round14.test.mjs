/**
 * Codex review round 14 on PR #204 — three P2s.
 *
 * F1: the scope gate added in an earlier round covered only the EXPO pointer
 * writes. Both durable writes still called setActive unguarded, so a sign-out
 * during floor hydration / free-space checks filed user A's pointer in user B's
 * store (shared clinic tablets, rule 13).
 *
 * F2: migration leaves the legacy `_count`/`_chunk_*` keys in place. A transient
 * Keystore failure reading `_ptr` was collapsed to "no pointer", which fell
 * through to the legacy layout and revived a pre-migration list.
 *
 * F3: the launch probe cleared stale pointers by id, from a snapshot. Expo
 * pointers are keyed by slotId and a resumed draft reuses its slot id, so a
 * capture started while the detached probe ran could be deleted by it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

// ---- F1 -------------------------------------------------------------------

test('both durable pointer writes are gated on the initiating user', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  // Round 24 turned these into awaited pre-start writes; the scope gate is what
  // this fence is about and it survives in `if (scopeUnchanged())` form.
  // Literal patterns, not built from strings: naming the DURABLE arguments keeps
  // the expo pre-start write (gated the same way) out of the count, and avoids
  // hand-escaping a regex, which CodeQL rightly flagged as incomplete.
  assert.match(
    src,
    /if \(scopeUnchanged\(\)\) \{\s*\n\s*await racePreStartPointerWrite\(\s*\n\s*durableActiveStore\.setActive\(recordingId, slotId/,
    'fresh-start write must be scope-gated',
  );
  assert.match(
    src,
    /if \(scopeUnchanged\(\)\) \{\s*\n\s*await racePreStartPointerWrite\(\s*\n\s*durableActiveStore\.setActive\(existingDurable\.recordingId, slotId/,
    'resume write must be scope-gated',
  );
  // An unguarded durable write must not creep back in.
  assert.doesNotMatch(
    src,
    /const activePointerWrite = raceDurableActiveWrite\(/,
    'no ungated durable pointer write',
  );
});

// ---- F2 -------------------------------------------------------------------

function loadStore(store, failPtrRead) {
  return loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failPtrRead() && k.endsWith('_ptr')) throw new Error('keystore unavailable');
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
}

const LEGACY = JSON.stringify([{ recordingId: 'old', slotId: 's-old' }]);
const CURRENT = JSON.stringify([{ recordingId: 'new', slotId: 's-new' }]);

/**
 * A SecureStore that has been migrated, plus a SECOND module instance standing
 * in for a later process start. The fresh instance is the whole point: within
 * the process that published, the in-memory high-water mark legitimately answers
 * the read, so the revival Codex describes can only appear on a later launch.
 */
async function migratedThenRelaunched({ migrate = true } = {}) {
  const store = new Map();
  let fail = false;
  const first = await loadStore(store, () => false);
  await first.writeChunkedValue(PREFIX, LEGACY);
  if (migrate) await first.writeChunkedValueVersioned(PREFIX, CURRENT);
  const relaunched = await loadStore(store, () => fail);
  return { store, relaunched, failPtr: (v) => { fail = v; } };
}

test('an unreadable pointer never revives the pre-migration list', async () => {
  const h = await migratedThenRelaunched();
  assert.equal(await h.relaunched.readChunkedValueVersioned(PREFIX), CURRENT, 'sanity');
  h.failPtr(true);
  const got = await h.relaunched.readChunkedValueVersioned(PREFIX);
  assert.notEqual(got, LEGACY, 'a failed pointer read must not fall back to legacy');
  assert.equal(got, null, 'unavailable reads as absent; readList maps null to []');
});

test('a genuinely absent pointer still reads the legacy layout', async () => {
  // Never migrated: the fallback this branch exists for must keep working.
  const h = await migratedThenRelaunched({ migrate: false });
  assert.equal(await h.relaunched.readChunkedValueVersioned(PREFIX), LEGACY);
});

test('a present-but-corrupt pointer does not revive legacy either', async () => {
  const h = await migratedThenRelaunched();
  h.store.set(`${PREFIX}_ptr`, 'not json'); // migrated, but the pointer is unusable
  assert.equal(await h.relaunched.readChunkedValueVersioned(PREFIX), null);
});

// ---- F3 -------------------------------------------------------------------

test('pruning keeps an entry renewed after the cutoff', async () => {
  const store = new Map();
  const mod = await loadTsModule('src/lib/durableAudio/activeStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const s = mod.durableActiveStore;
  s.setUserId('u1');
  const CUTOFF = '2026-09-04T12:00:00.000Z';
  await s.setActive('slot-a', 'slot-a', '2026-09-04T11:00:00.000Z', 'expo'); // stale
  await s.setActive('slot-b', 'slot-b', '2026-09-04T11:30:00.000Z', 'expo'); // stale
  // The vet resumes a draft and restarts capture on slot-b while the detached
  // probe is still working through its snapshot. Same id, new timestamp.
  await s.setActive('slot-b', 'slot-b', '2026-09-04T12:05:00.000Z', 'expo');

  await s.pruneStartedBefore('u1', CUTOFF);

  const list = await s.list();
  const ids = list.map((e) => e.recordingId);
  assert.ok(!ids.includes('slot-a'), 'the genuinely stale entry is pruned');
  assert.ok(ids.includes('slot-b'), 'the renewed live capture keeps its breadcrumb');
  assert.equal(list.length, 1);
});

test('the launch probe prunes by timestamp, not by a snapshot of ids', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  // Round 28: the prune now runs BEFORE the emit and gates it on confirmed
  // removal, so the call moved but the invariant (prune by timestamp, never by a
  // snapshot of ids) is unchanged.
  assert.match(src, /\.pruneStartedBefore\(userId, PROCESS_START_ISO\)/);
  assert.match(src, /if \(!pruned\) return;/);
  // The id-keyed clear is what deleted a renewed pointer. Scope to the probe:
  // clearActive is legitimate elsewhere in this file.
  const start = src.indexOf('async function reportPriorUncleanExit(');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(start > 0 && body.length > 0, 'anchor');
  assert.doesNotMatch(body, /clearActive\(/, 'the probe must not clear by id');
});

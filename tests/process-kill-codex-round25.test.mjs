/**
 * Codex review round 25 on PR #204 — a P1 caused by round 24's own fix, plus a
 * P2 in the legacy migration path.
 *
 * F1: making the pointer write awaited put an await between the pre-start scope
 * gate and the native call, so the gate was stale by the time the recorder was
 * invoked. The engine is a process singleton, so starting for a departed user
 * holds the microphone and fails the next user with BUSY.
 *
 * F2: the legacy fallback used the LENIENT reader but reported readable: true.
 * On an upgraded install a transient `_count`/chunk failure therefore read as an
 * empty store, and the next setActive published a generation holding only the
 * new capture — permanently hiding the prior unclean-exit pointer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

test('scope is rechecked between the pointer await and each native call', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  const fn = src.slice(
    src.indexOf('const startRecordingForSlot = useCallback('),
    src.indexOf('const handleStop = useCallback('),
  );
  for (const call of ['recorder.start({ userId: user.id, slotId, recordingId })', 'recorder.resumeDurable(']) {
    const nativeIdx = fn.indexOf(call);
    assert.ok(nativeIdx > 0, `anchor ${call}`);
    const before = fn.slice(0, nativeIdx);
    const lastGate = before.lastIndexOf('if (!scopeUnchanged()) {');
    const lastAwaitWrite = before.lastIndexOf('await racePreStartPointerWrite(');
    assert.ok(lastGate > lastAwaitWrite, `${call} must be gated AFTER the pointer await`);
  }
});

test('a failed legacy read is unavailable, not empty', async () => {
  const store = new Map();
  let failChunks = false;
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failChunks && k.includes('_chunk_')) throw new Error('keystore exploded');
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  // A never-migrated install: legacy value present, no `_ptr`.
  const legacy = JSON.stringify([{ recordingId: 'prior', slotId: 's' }]);
  await mod.writeChunkedValue(PREFIX, legacy);
  assert.equal(await mod.readChunkedValueVersioned(PREFIX), legacy, 'sanity: migration read works');

  failChunks = true;
  await assert.rejects(
    () => mod.readChunkedValueVersionedStrict(PREFIX),
    (e) => e?.code === 'STRICT_READ_UNAVAILABLE',
    'a failed legacy read must be unavailable, never absent',
  );
});

test('the built-regex CodeQL finding is gone', () => {
  // The fence built a RegExp from a string with hand-rolled escaping that
  // covered `.` but not `\`. Literal patterns remove the class entirely.
  const src = read('tests/process-kill-codex-round14.test.mjs');
  assert.doesNotMatch(src, /new RegExp\(/);
});

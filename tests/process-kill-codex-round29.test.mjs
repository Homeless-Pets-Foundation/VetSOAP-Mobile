/**
 * Codex review round 29 on PR #204 — two P2s.
 *
 * F1: the DURABLE success branch of handleStop still discarded its clear
 * promise, so it raced autoSaveDraft. Round 16 fixed the expo sibling; the
 * round-21 conversion to clearCapturePointer left this one as `void`. A process
 * death during the seconds-long autosave, with the clear still in flight, leaves
 * a pointer for a recording that finished cleanly.
 *
 * F2: the round-24 all-slots-reserved fallback recycled a reserved generation.
 * If the new write published that generation before the older, still-unsettled
 * write to it landed, the late write would overwrite the chunks the CURRENT
 * pointer names and resurrect a completed capture. Refusing under-reports;
 * recycling fabricates — and this store always prefers the former.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

test('every clear before the autosave is awaited, on both backends', () => {
  const src = read('app/(app)/(tabs)/record.tsx');
  const fn = src.slice(
    src.indexOf('const handleStop = useCallback('),
    src.indexOf('const handleContinueRecording = useCallback('),
  );
  const autosave = fn.indexOf('await autoSaveDraftRef.current(persistedSlot)');
  assert.ok(autosave > 0, 'autosave anchor');
  const before = fn.slice(0, autosave);
  // A fire-and-forget clear in this region races the autosave it precedes.
  const fireAndForget = before.match(/void clearCapturePointer\(finishUserId, /g) ?? [];
  assert.equal(fireAndForget.length, 0, 'clears before the autosave must be awaited');
  assert.match(before, /await clearCapturePointer\(finishUserId, snap\.recordingId\);/);
  assert.match(before, /await clearCapturePointer\(finishUserId, targetSlotId\);/);
});

test('a write refuses rather than recycle a reserved generation', async () => {
  const store = new Map();
  const gates = [];
  let hangAll = false;
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) { return store.has(k) ? store.get(k) : null; },
      async setItemAsync(k, v) {
        if (hangAll && k.includes('_chunk_')) {
          await new Promise((r) => gates.push(r));
        }
        store.set(k, v);
      },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });

  // Occupy every generation in the ring with an unsettled write.
  hangAll = true;
  const hung = [];
  for (let i = 0; i < 8; i++) {
    hung.push(mod.writeChunkedValueVersioned(PREFIX, JSON.stringify([`hung${i}`])));
  }
  // Let them all reach their gated chunk write.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));

  const ninth = await mod.writeChunkedValueVersioned(PREFIX, JSON.stringify(['ninth']));
  assert.equal(ninth, false, 'must refuse rather than reuse a namespace still in flight');

  gates.forEach((r) => r());
  await Promise.all(hung);
});

test('the refusal is explicit, not a silent recycle', () => {
  const src = read('src/lib/durableAudio/chunkedStore.ts');
  const fn = src.slice(src.indexOf('export async function writeChunkedValueVersioned'));
  assert.match(fn.slice(0, 2000), /if \(reserved\.has\(gen\)\) \{[\s\S]{0,900}?return false;/);
});

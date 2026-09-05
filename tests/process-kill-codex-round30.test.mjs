/**
 * Codex review round 30 on PR #204 — two P2s.
 *
 * F1: writeChunkedValueVersioned read `_ptr` LENIENTLY to decide which
 * generation to write into. Collapsed to null by a transient failure, the first
 * mutation after launch picks generation 0 — and if the persisted pointer
 * already names generation 0, it overwrites chunks that pointer still
 * references. Should the mutation then fail or be abandoned before publishing,
 * readers follow the old pointer into a half-written payload.
 *
 * F2: the probe marked the user reported and emitted PostHog + Sentry events
 * after the prune await without rechecking scope. Analytics and Sentry
 * identities are GLOBAL, so on a shared tablet A's interruption counts could be
 * filed against B.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PREFIX = 'captivet_durable_active_u1';

test('a write refuses when the current generation cannot be read', async () => {
  const store = new Map();
  let failPtrRead = false;
  const mod = await loadTsModule('src/lib/durableAudio/chunkedStore.ts', {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
      async getItemAsync(k) {
        if (failPtrRead && k.endsWith('_ptr')) throw new Error('keystore exploded');
        return store.has(k) ? store.get(k) : null;
      },
      async setItemAsync(k, v) { store.set(k, v); },
      async deleteItemAsync(k) { store.delete(k); },
    },
  });
  const live = JSON.stringify([{ recordingId: 'live', slotId: 's' }]);
  await mod.writeChunkedValueVersioned(PREFIX, live);
  const ptrBefore = store.get(`${PREFIX}_ptr`);

  failPtrRead = true;
  assert.equal(
    await mod.writeChunkedValueVersioned(PREFIX, JSON.stringify(['replacement'])),
    false,
    'must refuse rather than guess a generation',
  );
  failPtrRead = false;

  // Nothing the live pointer references was touched.
  assert.equal(store.get(`${PREFIX}_ptr`), ptrBefore);
  assert.equal(await mod.readChunkedValueVersioned(PREFIX), live);
});

test('the probe rechecks scope after the prune, before marking or emitting', () => {
  const src = read('src/lib/durableAudio/durableRecovery.ts');
  const start = src.indexOf('async function reportPriorUncleanExit(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const gate = body.indexOf('if (!pruned) return;');
  const recheck = body.indexOf('durableActiveStore.getUserId() !== userId', gate);
  const mark = body.indexOf('uncleanExitReportedUsers.add(userId);');
  const track = body.indexOf('trackEvent({');
  const sentry = body.indexOf('captureMessage(');
  assert.ok(gate > 0 && recheck > gate, 'a scope recheck must follow the prune await');
  for (const [name, idx] of [['mark', mark], ['trackEvent', track], ['captureMessage', sentry]]) {
    assert.ok(idx > recheck, `${name} must come after the recheck`);
  }
});

test('no doesNotMatch in this suite hides inside a fixed window', () => {
  // A too-small window makes `match` fail loudly but `doesNotMatch` pass
  // vacuously, so only the latter can go silently blind as code grows.
  const files = ['process-kill-codex-round10.test.mjs', 'process-kill-codex-round26.test.mjs'];
  for (const f of files) {
    const src = read(`tests/${f}`);
    for (const m of src.matchAll(/const (\w+) = \w+\.slice\([^,]+,\s*\w+ \+ (\d+)\)/g)) {
      const re = new RegExp(String.raw`doesNotMatch\(\s*${m[1]}\b`);
      assert.doesNotMatch(src, re, `${f}: doesNotMatch on fixed-window '${m[1]}'`);
    }
  }
});

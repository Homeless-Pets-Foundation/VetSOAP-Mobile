import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

/**
 * `durableReconcileHold.remove()` reports a failed read-or-rewrite by RESOLVING
 * false, and every caller reaches it only AFTER the draft and audio it was
 * protecting are already deleted — the card is dismissed and the slot resolved,
 * so no object and no UI action remains that could retry it.
 *
 * Left alone each failure stranded one entry permanently, and because `add()`
 * REFUSES past MAX_RECONCILE_HOLDS rather than evicting, enough of them quietly
 * take away the ability to protect the NEXT identity conflict at all — the
 * exact protection this store exists to provide.
 *
 * These are executable, not source-pinned: the property is about what survives
 * a storage fault, which a regex cannot see.
 */

const root = new URL('../', import.meta.url);

/** Load reconcileHold.ts for real, with its two imports mocked. */
async function loadHold({ storage }) {
  const source = await readFile(new URL('src/lib/durableAudio/reconcileHold.ts', root), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (spec) => {
      if (spec === './chunkedStore') return storage;
      if (spec === './paths') {
        return { isValidDurableId: (id) => typeof id === 'string' && id.length > 0 && /^[A-Za-z0-9_-]+$/.test(id) };
      }
      throw new Error(`module not mocked in test: ${spec}`);
    },
    Promise, Array, Math, Number, Object, JSON, Map, Set, String,
  });
  return module.exports;
}

/**
 * Chunked-store double whose readability and writability are switchable, so a
 * transient Keystore fault can be produced and then cleared.
 */
function makeStorage() {
  const state = new Map();
  const flags = { readable: true, writable: true };
  return {
    flags,
    state,
    api: {
      async readChunkedValueStrict(prefix) {
        if (!flags.readable) return { status: 'unavailable' };
        if (!state.has(prefix)) return { status: 'absent' };
        return { status: 'present', value: state.get(prefix) };
      },
      async writeChunkedValue(prefix, value) {
        if (!flags.writable) return false;
        state.set(prefix, value);
        return true;
      },
      async deleteChunkedValue(prefix) {
        state.delete(prefix);
      },
    },
  };
}

/**
 * Cool the module's in-memory list cache the way production does.
 *
 * `loadList()` answers from cache while it is warm, so a read fault is
 * invisible until the cache is dropped — which happens on a user switch, on a
 * failed write, and on a fresh process. Without this the tests would flip
 * `readable` and observe nothing.
 */
function coolCache(hold, userId) {
  hold.setUserId(null);
  hold.setUserId(userId);
}

/** The persisted list, read straight out of the double. */
function persisted(storage, userId) {
  const raw = storage.state.get(`captivet_durable_reconcile_hold_${userId}`);
  return raw ? JSON.parse(raw) : [];
}

test('a release that cannot be written is retried by the next successful mutation', async () => {
  const storage = makeStorage();
  const { durableReconcileHold, pendingReconcileHoldReleases } = await loadHold({ storage: storage.api });
  durableReconcileHold.setUserId('u1');

  assert.equal(await durableReconcileHold.add('rec-a'), true);
  assert.equal(await durableReconcileHold.add('rec-b'), true);
  assert.deepEqual(persisted(storage, 'u1'), ['rec-a', 'rec-b']);

  // The conflict is resolved, the copy is deleted — and the store is unreadable
  // on a cold cache, which is what a fresh process after a crash looks like.
  coolCache(durableReconcileHold, 'u1');
  storage.flags.readable = false;
  assert.equal(await durableReconcileHold.remove('rec-a'), false, 'a failed release must report false');
  assert.equal(pendingReconcileHoldReleases('u1'), 1, 'the failed release must be retained');
  assert.deepEqual(persisted(storage, 'u1'), ['rec-a', 'rec-b'], 'nothing was written while unreadable');

  // Storage recovers; the next mutation applies the owed release in its own write.
  storage.flags.readable = true;
  assert.equal(await durableReconcileHold.add('rec-c'), true);
  assert.deepEqual(persisted(storage, 'u1'), ['rec-b', 'rec-c'], 'the queued release must land');
  assert.equal(pendingReconcileHoldReleases('u1'), 0, 'the queue clears once its write succeeds');
  assert.equal(await durableReconcileHold.has('rec-a'), false);
  assert.equal(await durableReconcileHold.has('rec-b'), true, 'other holds must survive');
});

test('a release whose WRITE fails is retained, not reported as done', async () => {
  const storage = makeStorage();
  const { durableReconcileHold, pendingReconcileHoldReleases } = await loadHold({ storage: storage.api });
  durableReconcileHold.setUserId('u1');
  await durableReconcileHold.add('rec-a');

  storage.flags.writable = false;
  assert.equal(await durableReconcileHold.remove('rec-a'), false);
  assert.equal(pendingReconcileHoldReleases('u1'), 1);
  assert.deepEqual(persisted(storage, 'u1'), ['rec-a'], 'the hold still protects its copy');

  storage.flags.writable = true;
  assert.equal(await durableReconcileHold.remove('rec-b'), true, 'an unrelated release also flushes the queue');
  assert.deepEqual(persisted(storage, 'u1'), []);
  assert.equal(pendingReconcileHoldReleases('u1'), 0);
});

test('queued releases are drained before the cap refuses a new hold', async () => {
  const storage = makeStorage();
  const { durableReconcileHold, MAX_RECONCILE_HOLDS } = await loadHold({ storage: storage.api });
  durableReconcileHold.setUserId('u1');

  for (let i = 0; i < MAX_RECONCILE_HOLDS; i++) {
    assert.equal(await durableReconcileHold.add(`rec-${i}`), true);
  }
  // Full: a genuine new conflict cannot be protected.
  assert.equal(await durableReconcileHold.add('rec-new'), false);

  // One of them is resolved while the store is unreadable.
  coolCache(durableReconcileHold, 'u1');
  storage.flags.readable = false;
  assert.equal(await durableReconcileHold.remove('rec-0'), false);
  storage.flags.readable = true;

  // Without the drain-before-cap ordering this still refuses, and the device is
  // permanently unable to protect a conflict because of an entry that is
  // already meant to be gone.
  assert.equal(await durableReconcileHold.add('rec-new'), true);
  const list = persisted(storage, 'u1');
  assert.equal(list.includes('rec-0'), false);
  assert.equal(list.includes('rec-new'), true);
  assert.equal(list.length, MAX_RECONCILE_HOLDS);
});

test('a queued release cannot leak into another user, or across a sign-out', async () => {
  const storage = makeStorage();
  const { durableReconcileHold, pendingReconcileHoldReleases } = await loadHold({ storage: storage.api });

  durableReconcileHold.setUserId('u1');
  await durableReconcileHold.add('shared-id');
  durableReconcileHold.setUserId('u2');
  await durableReconcileHold.add('shared-id');

  // u2 resolves its conflict while storage is down.
  coolCache(durableReconcileHold, 'u2');
  storage.flags.readable = false;
  assert.equal(await durableReconcileHold.remove('shared-id'), false);
  storage.flags.readable = true;

  // u1's identical id must be untouched by u2's owed release.
  durableReconcileHold.setUserId('u1');
  await durableReconcileHold.add('u1-other');
  assert.deepEqual(persisted(storage, 'u1'), ['shared-id', 'u1-other'], "u2's queue must not drain u1's list");
  assert.equal(pendingReconcileHoldReleases('u2'), 1);

  // Clearing u2 drops its queue with the list it referred to.
  await durableReconcileHold.clearForUser('u2');
  assert.equal(pendingReconcileHoldReleases('u2'), 0);
});

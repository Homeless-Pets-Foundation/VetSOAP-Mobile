/**
 * Reconciliation hold: a persistent, user-scoped, bounded record of durable
 * recordingIds whose audio was confirmed-uploaded but is being KEPT on this
 * device because the server row's identity metadata diverged and only a human
 * can say which visit it belongs to.
 *
 * WHY this has to be persistent: the divergence itself lives in React state, so
 * it dies with the process. The manifest, however, was already marked
 * `uploaded` — `markUploaded()` runs even when the copy is held, because it is
 * what stops recovery re-offering an already-uploaded capture. On the next
 * launch `selectRecoverableSessions()` sees a confirmed-uploaded manifest and
 * routes it to SELF-HEAL before it ever looks at draft suppression, so the
 * linked draft is deleted and the audio purged — destroying the retained copy
 * and the "submit separately" option the reconciliation card promised, for a
 * vet who simply closed the app before deciding.
 *
 * This is the opposite signal to `durableTombstone`: the tombstone says "this
 * was uploaded, its local footprint may go", and the hold says "this was
 * uploaded, but keep the local footprint until a human resolves the conflict".
 * A recordingId in the hold must therefore never be self-healed. Entries are
 * removed by whichever reconciliation action resolves the divergence — and the
 * release action removes it only AFTER the delete it authorizes has succeeded,
 * so a failure leaves the recording protected rather than exposed.
 *
 * Like the tombstone it survives `secureStorage.clearAll()` (prefixed key, not
 * in the delete allowlist) — un-sent work outlives sign-out (Rule 8).
 */
import { writeChunkedValue, readChunkedValueStrict, deleteChunkedValue } from './chunkedStore';
import { isValidDurableId } from './paths';

const KEY_PREFIX = 'captivet_durable_reconcile_hold';
/**
 * Hard cap, NOT a FIFO window. Far smaller than the tombstone's: a hold is a
 * conflict awaiting a human, and a device with dozens of them is already in
 * trouble. Unlike a tombstone, evicting the oldest entry here is destructive —
 * the evicted recording's confirmed-uploaded manifest goes straight to
 * self-heal on the next scan, deleting a local copy the vet was promised. So
 * `add()` REFUSES past the cap instead, and the caller's fail-closed path
 * (don't terminalize the manifest) keeps that recording recoverable.
 */
export const MAX_RECONCILE_HOLDS = 50;

let currentUserId: string | null = null;
let cachedListUserId: string | null = null;
let cachedList: string[] | null = null;

/**
 * Releases that could not be written, retained per user for retry.
 *
 * `remove()` reports a failed read-or-rewrite by RESOLVING false, and its
 * callers reach it only AFTER the draft and audio they were protecting are
 * already gone — the card is dismissed and the slot resolved, so no object and
 * no UI action remains that could ever retry it. Left alone, each such failure
 * strands one entry forever, and because `add()` REFUSES past
 * MAX_RECONCILE_HOLDS rather than evicting, enough of them silently take away
 * the ability to protect a future conflict at all.
 *
 * Memory-only, deliberately, and modelled on `orphanDraftRetry`: a hold id is
 * a durable recordingId or draft slot id, never PHI, and losing the queue to a
 * restart forfeits one retry opportunity, never correctness — the entry is
 * inert (whatever it protected is already deleted) until the cap matters, and
 * the cap is reached through `add()`, which drains this first.
 */
const pendingRemovals = new Map<string, Set<string>>();

/** Bound the queue itself, so a permanently unreadable store cannot grow it without limit. */
const MAX_PENDING_REMOVALS = MAX_RECONCILE_HOLDS;

function rememberPendingRemoval(userId: string, recordingId: string): void {
  const queued = pendingRemovals.get(userId) ?? new Set<string>();
  if (queued.size >= MAX_PENDING_REMOVALS && !queued.has(recordingId)) return;
  queued.add(recordingId);
  pendingRemovals.set(userId, queued);
}

/**
 * Apply every queued release to a list already proven readable, inside the
 * caller's lock. Returns whether anything changed, so the caller can fold it
 * into the single write it was going to make anyway.
 */
function applyPendingRemovals(userId: string, list: string[]): { list: string[]; changed: boolean } {
  const queued = pendingRemovals.get(userId);
  if (!queued || queued.size === 0) return { list, changed: false };
  const next = list.filter((id) => !queued.has(id));
  return { list: next, changed: next.length !== list.length };
}

/**
 * Clear the queue only once the write that applied it has SUCCEEDED. Dropping
 * it on a failed write would lose the retry that is the whole point.
 */
function commitPendingRemovals(userId: string): void {
  pendingRemovals.delete(userId);
}

/** Test/diagnostic surface: how many releases are still awaiting a writable store. */
export function pendingReconcileHoldReleases(userId: string): number {
  return pendingRemovals.get(userId)?.size ?? 0;
}

/**
 * Bumped by every cache invalidation and every publish.
 *
 * The mutation chain orders WRITES, but `has()`, `hasStrict()` and
 * `listStrict()` populate the same cache from OUTSIDE it. A read that captured
 * SecureStore's old value can finish after an `add()` has written and cached
 * the new list, publish its pre-write snapshot over the top, and the next
 * serialized mutation then trusts that stale cache and rewrites storage without
 * the new hold — whose retained audio the next startup self-heal purges. The
 * read's own RETURN value being a moment stale is fine and always was; what
 * cannot happen is a stale snapshot outliving the read into the shared cache.
 *
 * So a read publishes only if nothing invalidated or published while it was
 * awaiting. Cheaper than serializing reads behind the mutation chain, which
 * would put every membership check behind a SecureStore call that can hang.
 */
let cacheGeneration = 0;

function invalidateCache(): void {
  cachedListUserId = null;
  cachedList = null;
  cacheGeneration++;
}

/** Publish a list to the cache, invalidating any read still in flight. */
function publishCache(userId: string, list: string[]): void {
  cachedListUserId = userId;
  cachedList = list.slice();
  cacheGeneration++;
}

function prefixFor(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

type HoldLoad = { known: true; list: string[] } | { known: false };

/**
 * Strict load. "Present but unreadable" is NOT empty: building a whole-list
 * rewrite on an unproven-empty read would drop every other hold because of one
 * transient Keystore fault, and each dropped entry is a retained recording that
 * the next recovery scan would then purge.
 */
async function loadList(userId: string): Promise<HoldLoad> {
  if (cachedList && cachedListUserId === userId) {
    return { known: true, list: cachedList.slice() };
  }
  // Captured BEFORE the await: anything that invalidates or publishes while
  // this read is outstanding makes its result unfit to become the cache.
  const generation = cacheGeneration;
  const read = await readChunkedValueStrict(prefixFor(userId));
  const publishable = (): boolean => cacheGeneration === generation;
  if (read.status === 'unavailable') return { known: false };
  if (read.status === 'absent') {
    if (publishable()) publishCache(userId, []);
    return { known: true, list: [] };
  }
  try {
    const parsed: unknown = JSON.parse(read.value);
    if (!Array.isArray(parsed)) return { known: false };
    const list = parsed.filter((id): id is string => typeof id === 'string' && isValidDurableId(id));
    if (publishable()) publishCache(userId, list);
    return { known: true, list };
  } catch {
    return { known: false };
  }
}

/**
 * Lenient read for membership questions. An unreadable list answers "held" for
 * nothing, which is safe ONLY because every consumer treats a missing hold as
 * "not held" and the recovery scan's own tombstone/draft checks still apply.
 */
async function readList(userId: string): Promise<string[]> {
  const loaded = await loadList(userId);
  return loaded.known ? loaded.list : [];
}

/**
 * Serializes read-modify-write. Two slots in one session can finish
 * identity-divergent uploads at the same time; interleaved, both `add()` calls
 * read the same list, append different ids, and the second write silently drops
 * the first — while BOTH report success, so both callers go on to mark their
 * manifests uploaded. The dropped one is then purged by the next startup scan:
 * a lost recording produced by two conflicts happening at once.
 *
 * A promise chain is enough here. There is one JS context, every mutation goes
 * through this module, and the operations are short — so ordering them removes
 * the interleave entirely rather than trying to detect it.
 */
/**
 * PER USER, not global. A hung SecureStore call for user A would otherwise
 * block every later mutation for user B behind a promise that never settles —
 * on a shared clinic tablet that means B's next divergent upload waits forever
 * for a hold that can never be written.
 */
const mutationChains = new Map<string, Promise<unknown>>();

function serialize<T>(userId: string, op: () => Promise<T>): Promise<T> {
  const previous = mutationChains.get(userId) ?? Promise.resolve();
  const run = previous.then(op, op);
  // Keep the chain alive regardless of outcome; each caller sees its own result.
  mutationChains.set(
    userId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function writeList(userId: string, list: string[]): Promise<boolean> {
  invalidateCache();
  const persisted = await writeChunkedValue(prefixFor(userId), JSON.stringify(list));
  if (!persisted) return false;
  // publishCache, not a bare assignment: a read that began between the
  // invalidate above and this line saw pre-write storage, and must not be
  // allowed to overwrite what we just persisted.
  publishCache(userId, list);
  return true;
}

export const durableReconcileHold = {
  setUserId(userId: string | null): void {
    if (userId !== currentUserId) invalidateCache();
    currentUserId = userId;
  },

  getUserId(): string | null {
    return currentUserId;
  },

  /** Mark a confirmed-uploaded recording as retained pending reconciliation. */
  async add(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId || !isValidDurableId(recordingId)) return false;
    return serialize(userId, async () => {
      // Re-read INSIDE the lock: a concurrent add may have landed since this
      // call was queued, and the cached list it saw before is now stale.
      const loaded = await loadList(userId);
      if (!loaded.known) return false;
      // Drain first, and specifically BEFORE the cap test: a queue of failed
      // releases is exactly what pushes a healthy device to the cap, and
      // refusing to protect a real conflict because of entries that are
      // already meant to be gone is the failure this drain exists to prevent.
      const drained = applyPendingRemovals(userId, loaded.list);
      const list = drained.list;
      if (list.includes(recordingId)) {
        // Still owe the queue a write even on the no-op add path.
        if (drained.changed && (await writeList(userId, list))) commitPendingRemovals(userId);
        return true;
      }
      // Refuse rather than evict: dropping the oldest hold would hand a
      // retained recording to the next self-heal without anyone deciding.
      if (list.length >= MAX_RECONCILE_HOLDS) {
        if (drained.changed && (await writeList(userId, list))) commitPendingRemovals(userId);
        return false;
      }
      list.push(recordingId);
      const wrote = await writeList(userId, list);
      if (wrote && drained.changed) commitPendingRemovals(userId);
      return wrote;
    });
  },

  async has(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    return (await readList(userId)).includes(recordingId);
  },

  /**
   * Strict membership, for callers that DELETE on the answer. `has()` maps an
   * unreadable list to "not held", which is fine for a render and fatal for age
   * eviction: one transient Keystore failure would authorize deleting a
   * retained copy whose hold is sitting on disk, unread.
   */
  async hasStrict(recordingId: string): Promise<'held' | 'not_held' | 'unknown'> {
    const userId = currentUserId;
    if (!userId) return 'unknown';
    const loaded = await loadList(userId);
    if (!loaded.known) return 'unknown';
    return loaded.list.includes(recordingId) ? 'held' : 'not_held';
  },

  /**
   * Release a hold once its divergence has been resolved.
   *
   * Resolves false when the store could not be read or rewritten. Callers reach
   * this only after the copy it protected is already deleted, so there is
   * nothing left for them to retry with — the failed release is queued here
   * instead and applied by the next successful mutation for this user.
   */
  async remove(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    return serialize(userId, async () => {
      const loaded = await loadList(userId);
      if (!loaded.known) {
        rememberPendingRemoval(userId, recordingId);
        return false;
      }
      const drained = applyPendingRemovals(userId, loaded.list);
      const next = drained.list.filter((id) => id !== recordingId);
      if (next.length === drained.list.length && !drained.changed) return true;
      const wrote = await writeList(userId, next);
      if (!wrote) {
        rememberPendingRemoval(userId, recordingId);
        return false;
      }
      commitPendingRemovals(userId);
      return true;
    });
  },

  async list(): Promise<string[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return readList(userId);
  },

  /**
   * Strict read for the RECOVERY SCAN, which purges on this answer. An
   * unreadable list must not read as "nothing is held": every confirmed-uploaded
   * manifest would then be self-healed, destroying exactly the copies this store
   * exists to protect. `known: false` tells the caller to defer and retry.
   */
  async listStrict(): Promise<{ known: true; list: string[] } | { known: false }> {
    const userId = currentUserId;
    if (!userId) return { known: false };
    return loadList(userId);
  },

  async clearForUser(userId: string): Promise<void> {
    if (cachedListUserId === userId) invalidateCache();
    // The queue only ever asks for entries to be REMOVED, and the whole list is
    // about to go — keeping it would let a stale id survive into a re-signed-in
    // session's fresh store.
    commitPendingRemovals(userId);
    await deleteChunkedValue(prefixFor(userId));
    if (cachedListUserId === userId) invalidateCache();
  },
};

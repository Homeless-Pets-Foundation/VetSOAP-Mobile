/**
 * Purged-uploaded tombstone: a persistent, user-scoped, bounded record of
 * durable recordingIds whose audio was confirmed-uploaded and purged locally.
 *
 * WHY (plan: Recovery UX + Draft/Stash): after confirmUpload the manifest is
 * marked `uploaded`, the linked draft is deleted, then the manifest is purged.
 * The linked `emptyButServerLinked` draft survives sign-out (Rule 8) and
 * reappears on re-sign-in. If an offline re-sign-in self-heal could not tell the
 * row was already uploaded, cleanupOrphaned would delete the just-uploaded
 * server row. cleanupOrphaned consults this tombstone (and getStatus fails
 * closed offline) to never delete an uploaded/processed row.
 *
 * The tombstone must survive secureStorage.clearAll() (it does — prefixed key
 * not in the delete allowlist) and is pruned only once BOTH the linked draft and
 * the manifest for that recordingId are confirmed absent, or FIFO-capped.
 */
import { writeChunkedValue, readChunkedValueStrict, deleteChunkedValue } from './chunkedStore';
import { isValidDurableId } from './paths';

const KEY_PREFIX = 'captivet_durable_tombstone';
/** FIFO cap so the list cannot grow unbounded on long-lived clinic tablets. */
export const MAX_TOMBSTONES = 300;

let currentUserId: string | null = null;

/**
 * In-memory mirror of the persisted list. This module is the only writer, and
 * there is exactly one JS context, so the mirror cannot diverge.
 *
 * Why it exists: `has()` is called once per draft inside `cleanupOrphaned` and
 * `evictExpired`, and each call re-read the whole chunked value from
 * SecureStore — ~8 AndroidKeyStore round trips per probe at MAX_TOMBSTONES.
 * A sweep over N drafts therefore paid ~8N Keystore reads to answer N
 * membership questions about one list.
 *
 * Always user-keyed, and dropped whenever the user changes, so a shared clinic
 * tablet can never answer one user's membership question from another's list.
 */
let cachedListUserId: string | null = null;
let cachedList: string[] | null = null;

function invalidateCache(): void {
  cachedListUserId = null;
  cachedList = null;
}

function prefixFor(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

type TombstoneLoad =
  /** The list is known: either decoded from storage or proven not to exist. */
  | { known: true; list: string[] }
  /**
   * Present but unrecoverable — torn chunks, a Keystore failure, a corrupt
   * payload. NOT the same as empty, and callers that write MUST NOT treat it
   * as such.
   */
  | { known: false };

/**
 * Load the list, keeping "proven absent" separate from "could not be read".
 *
 * This distinction is the whole safety property of the module. The tombstone is
 * what stops `cleanupOrphaned` deleting a confirmed-uploaded recording, and a
 * writer that started from an unproven empty list would persist it — erasing up
 * to MAX_TOMBSTONES real entries because of one transient Keystore fault.
 */
async function loadList(userId: string): Promise<TombstoneLoad> {
  // Copy on the way out: `add()` mutates the array it receives.
  if (cachedList && cachedListUserId === userId) {
    return { known: true, list: cachedList.slice() };
  }

  const read = await readChunkedValueStrict(prefixFor(userId));
  if (read.status === 'unavailable') return { known: false };

  if (read.status === 'absent') {
    // No count pointer at all: proven empty, so this IS safe to cache and safe
    // to build a write on top of.
    cachedListUserId = userId;
    cachedList = [];
    return { known: true, list: [] };
  }

  let list: string[];
  try {
    const parsed = JSON.parse(read.value);
    // Present but not the shape we wrote — corrupt, not proven-empty.
    if (!Array.isArray(parsed)) return { known: false };
    list = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return { known: false };
  }

  cachedListUserId = userId;
  cachedList = list.slice();
  return { known: true, list };
}

/**
 * Lenient read for the QUERY paths (`has`, `list`). An unreadable list degrades
 * to empty, which is the safe direction for every caller: all three
 * `durableTombstone.has()` call sites in `draftStorage` treat `false` as
 * "keep the draft, do not delete". Nothing is cached in that case, so the next
 * call retries storage.
 */
async function readList(userId: string): Promise<string[]> {
  const loaded = await loadList(userId);
  return loaded.known ? loaded.list : [];
}

/**
 * Persist the list, and mirror it in memory ONLY once storage accepted it.
 *
 * `writeChunkedValue` reports a rejected chunk/count write by resolving `false`
 * rather than throwing, so an ignored result would leave the cache holding a
 * list that storage never took: `add()` would claim success, later `has()` calls
 * would answer from the phantom entry instead of retrying storage, and the
 * tombstone would simply be gone after the next launch — letting a
 * confirmed-uploaded recording resurface with stale local metadata. On failure
 * the cache stays invalidated (storage still holds the previous value, which is
 * what the next read must see) and the caller is told the mutation did not land.
 */
/**
 * Serializes read-modify-write. Every mutation here is a whole-list rewrite, so
 * two concurrent callers — a reconciliation action and another slot's upload
 * cleanup, say — can read the same list, append different ids, and have the
 * second write silently drop the first while both report success. A dropped
 * tombstone is a confirmed-uploaded recording that `cleanupOrphaned` can then
 * delete the server row for, which is the exact loss this store exists to
 * prevent. One JS context and short operations, so ordering them is enough.
 */
let mutationChain: Promise<unknown> = Promise.resolve();

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(op, op);
  mutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeList(userId: string, list: string[]): Promise<boolean> {
  // Drop the mirror first: if the write fails, the next read must go to storage
  // rather than serve a value that was never persisted.
  invalidateCache();
  const persisted = await writeChunkedValue(prefixFor(userId), JSON.stringify(list));
  if (!persisted) return false;
  cachedListUserId = userId;
  cachedList = list.slice();
  return true;
}

export const durableTombstone = {
  setUserId(userId: string | null): void {
    if (userId !== currentUserId) invalidateCache();
    currentUserId = userId;
  },

  getUserId(): string | null {
    return currentUserId;
  },

  /**
   * Record a purged-uploaded recordingId. Dedupes + FIFO-caps.
   *
   * Returns false when the existing list could not be read OR the new list could
   * not be persisted — never claim a tombstone that storage did not take. Every
   * write here is a whole-list rewrite, so building one on an unproven-empty
   * read would erase up to MAX_TOMBSTONES real entries because of a single
   * transient Keystore fault — and each erased entry is a confirmed-uploaded
   * recording that `cleanupOrphaned` could then destroy locally. Skipping ONE
   * tombstone is strictly less harmful than erasing every other one, so
   * mutations fail closed and the caller retries on the next pass.
   */
  async add(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId || !isValidDurableId(recordingId)) return false;
    return serialize(async () => {
      // Re-read inside the lock: a concurrent mutation may have landed while
      // this call was queued.
      const loaded = await loadList(userId);
      if (!loaded.known) return false;
      const list = loaded.list;
      if (list.includes(recordingId)) return true;
      list.push(recordingId);
      while (list.length > MAX_TOMBSTONES) list.shift(); // drop oldest
      return writeList(userId, list);
    });
  },

  async has(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const list = await readList(userId);
    return list.includes(recordingId);
  },

  /**
   * Remove one entry (call once draft + manifest are both confirmed gone).
   * Fails closed on an unreadable list for the same reason as `add`, and
   * reports false when the rewrite itself was rejected.
   */
  async remove(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    return serialize(async () => {
      const loaded = await loadList(userId);
      if (!loaded.known) return false;
      const next = loaded.list.filter((id) => id !== recordingId);
      if (next.length === loaded.list.length) return true; // nothing to remove
      return writeList(userId, next);
    });
  },

  async list(): Promise<string[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return readList(userId);
  },

  /**
   * Prune entries for which `stillReferenced` resolves false (draft+manifest
   * gone). Fails closed on an unreadable list — pruning against an empty view
   * would drop every entry — and reports false when the rewrite was rejected.
   */
  async prune(stillReferenced: (recordingId: string) => Promise<boolean>): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    return serialize(async () => {
      const loaded = await loadList(userId);
      if (!loaded.known) return false;
      const keep: string[] = [];
      for (const id of loaded.list) {
        if (await stillReferenced(id)) keep.push(id);
      }
      if (keep.length === loaded.list.length) return true; // nothing to prune
      return writeList(userId, keep);
    });
  },

  async clearForUser(userId: string): Promise<void> {
    if (cachedListUserId === userId) invalidateCache();
    await deleteChunkedValue(prefixFor(userId));
    if (cachedListUserId === userId) invalidateCache();
  },
};

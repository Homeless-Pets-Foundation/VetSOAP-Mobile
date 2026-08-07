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
import { writeChunkedValue, readChunkedValue, deleteChunkedValue } from './chunkedStore';
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

async function readList(userId: string): Promise<string[]> {
  // Copy on the way out: `add()` mutates the array it receives.
  if (cachedList && cachedListUserId === userId) return cachedList.slice();

  const raw = await readChunkedValue(prefixFor(userId));
  if (raw === null) {
    // `readChunkedValue` collapses THREE different situations to null: the key
    // is genuinely absent, a chunk was torn by a concurrent write, or the
    // Keystore read failed. Caching `[]` here would be a data-loss bug, not a
    // slow path: `has()` would keep answering "not uploaded" without ever
    // retrying storage, and the next `add()` would start from that empty array
    // and overwrite the real persisted tombstones with a single ID. That is the
    // guard which stops `cleanupOrphaned` from deleting a just-uploaded server
    // row. So: return empty, cache NOTHING, and let the next call retry.
    //
    // The cost of not caching is one read of the count key — not the whole
    // chunk set — and only for users who have no tombstones at all. Sweeps over
    // users who DO have tombstones (the case this cache exists for) still get
    // the full benefit.
    return [];
  }

  let list: string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Present but not the shape we wrote — corrupt, not proven-empty.
      return [];
    }
    list = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // Unparseable payload — same reasoning as above, never cache it.
    return [];
  }

  cachedListUserId = userId;
  cachedList = list.slice();
  return list;
}

async function writeList(userId: string, list: string[]): Promise<void> {
  // Drop the mirror first: if the write fails, the next read must go to storage
  // rather than serve a value that was never persisted.
  invalidateCache();
  await writeChunkedValue(prefixFor(userId), JSON.stringify(list));
  cachedListUserId = userId;
  cachedList = list.slice();
}

export const durableTombstone = {
  setUserId(userId: string | null): void {
    if (userId !== currentUserId) invalidateCache();
    currentUserId = userId;
  },

  getUserId(): string | null {
    return currentUserId;
  },

  /** Record a purged-uploaded recordingId. Dedupes + FIFO-caps. */
  async add(recordingId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId || !isValidDurableId(recordingId)) return;
    const list = await readList(userId);
    if (list.includes(recordingId)) return;
    list.push(recordingId);
    while (list.length > MAX_TOMBSTONES) list.shift(); // drop oldest
    await writeList(userId, list);
  },

  async has(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const list = await readList(userId);
    return list.includes(recordingId);
  },

  /** Remove one entry (call once draft + manifest are both confirmed gone). */
  async remove(recordingId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;
    const list = await readList(userId);
    const next = list.filter((id) => id !== recordingId);
    if (next.length !== list.length) await writeList(userId, next);
  },

  async list(): Promise<string[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return readList(userId);
  },

  /** Prune entries for which `stillReferenced` resolves false (draft+manifest gone). */
  async prune(stillReferenced: (recordingId: string) => Promise<boolean>): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;
    const list = await readList(userId);
    const keep: string[] = [];
    for (const id of list) {
      if (await stillReferenced(id)) keep.push(id);
    }
    if (keep.length !== list.length) await writeList(userId, keep);
  },

  async clearForUser(userId: string): Promise<void> {
    if (cachedListUserId === userId) invalidateCache();
    await deleteChunkedValue(prefixFor(userId));
    if (cachedListUserId === userId) invalidateCache();
  },
};

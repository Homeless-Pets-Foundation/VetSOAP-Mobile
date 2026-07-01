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

function prefixFor(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

async function readList(userId: string): Promise<string[]> {
  const raw = await readChunkedValue(prefixFor(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function writeList(userId: string, list: string[]): Promise<void> {
  await writeChunkedValue(prefixFor(userId), JSON.stringify(list));
}

export const durableTombstone = {
  setUserId(userId: string | null): void {
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
    await deleteChunkedValue(prefixFor(userId));
  },
};

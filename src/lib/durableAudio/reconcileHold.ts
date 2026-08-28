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
 * FIFO cap. Far smaller than the tombstone's: a hold is a conflict awaiting a
 * human, and a device with hundreds of them is broken in some other way.
 */
export const MAX_RECONCILE_HOLDS = 50;

let currentUserId: string | null = null;
let cachedListUserId: string | null = null;
let cachedList: string[] | null = null;

function invalidateCache(): void {
  cachedListUserId = null;
  cachedList = null;
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
  const read = await readChunkedValueStrict(prefixFor(userId));
  if (read.status === 'unavailable') return { known: false };
  if (read.status === 'absent') {
    cachedListUserId = userId;
    cachedList = [];
    return { known: true, list: [] };
  }
  try {
    const parsed: unknown = JSON.parse(read.value);
    if (!Array.isArray(parsed)) return { known: false };
    const list = parsed.filter((id): id is string => typeof id === 'string' && isValidDurableId(id));
    cachedListUserId = userId;
    cachedList = list.slice();
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

async function writeList(userId: string, list: string[]): Promise<boolean> {
  invalidateCache();
  const persisted = await writeChunkedValue(prefixFor(userId), JSON.stringify(list));
  if (!persisted) return false;
  cachedListUserId = userId;
  cachedList = list.slice();
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
    const loaded = await loadList(userId);
    if (!loaded.known) return false;
    const list = loaded.list;
    if (list.includes(recordingId)) return true;
    list.push(recordingId);
    while (list.length > MAX_RECONCILE_HOLDS) list.shift();
    return writeList(userId, list);
  },

  async has(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    return (await readList(userId)).includes(recordingId);
  },

  /** Release a hold once its divergence has been resolved. */
  async remove(recordingId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const loaded = await loadList(userId);
    if (!loaded.known) return false;
    const next = loaded.list.filter((id) => id !== recordingId);
    if (next.length === loaded.list.length) return true;
    return writeList(userId, next);
  },

  async list(): Promise<string[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return readList(userId);
  },

  async clearForUser(userId: string): Promise<void> {
    if (cachedListUserId === userId) invalidateCache();
    await deleteChunkedValue(prefixFor(userId));
    if (cachedListUserId === userId) invalidateCache();
  },
};

/**
 * Active durable-recording pointer: a persistent, user-scoped record of durable
 * recordings that were actively capturing, written by start() BEFORE the first
 * frame and cleared on clean stop/discard/confirmed-upload purge.
 *
 * Purposes (plan):
 *  - The Phase-1 startup breadcrumb "previous process exited while recording" —
 *    if an entry survives to next launch, the prior process died mid-capture.
 *  - When the launch scan cleans a zero-complete-frame durable directory as
 *    transient scratch, it also removes this pointer so no orphaned key points
 *    at a swept directory.
 *
 * Separate from DraftMetadata on purpose: draftStorage.saveDraft() does NOT
 * reject a zero-segment input, so reusing it for an active durable recording
 * would silently write an empty draft that cleanupOrphaned later deletes
 * (server row included). This store never does that.
 *
 * Survives secureStorage.clearAll() (prefixed key, not in the delete allowlist).
 */
import { writeChunkedValue, readChunkedValueWithCount, deleteChunkedValue } from './chunkedStore';
import { isValidDurableId } from './paths';
import { withPromiseTimeout } from '../promiseTimeout';

const KEY_PREFIX = 'captivet_durable_active';
const MAX_ACTIVE = 50;

export type CaptureBackend = 'durable' | 'expo';

export interface DurableActiveEntry {
  recordingId: string;
  slotId: string;
  startedAt: string;
  /**
   * Which recorder owned the capture. Absent on entries persisted before this
   * field existed — read as 'durable', which is what those entries were.
   *
   * The expo fallback writes here too. It has no durable manifest to recover,
   * so an 'expo' entry surviving to next launch is PURELY a kill signal: the
   * in-progress .m4a had no moov atom written and is unrecoverable. That is the
   * loss we are trying to measure, and it is the only backend running in
   * production until the durable flag is turned on.
   */
  backend?: CaptureBackend;
}

/** Counts of entries that survived a prior process, split by recorder. */
export interface LastExitCapture {
  durable: number;
  expo: number;
}

let currentUserId: string | null = null;

function prefixFor(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

interface ActiveListRead {
  list: DurableActiveEntry[];
  /** Persisted chunk count, threaded into the write so its stale sweep is exact. */
  chunkCount: number | null;
}

async function readList(userId: string): Promise<ActiveListRead> {
  const { value: raw, chunkCount } = await readChunkedValueWithCount(prefixFor(userId));
  if (!raw) return { list: [], chunkCount };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { list: [], chunkCount };
    return {
      list: parsed.filter(
        (e): e is DurableActiveEntry =>
          e && typeof e.recordingId === 'string' && typeof e.slotId === 'string',
      ),
      chunkCount,
    };
  } catch {
    return { list: [], chunkCount };
  }
}

// `setActive` runs on the record-start critical path (before the mic opens).
// Passing the count we just read turns the blind 16-key stale sweep into zero
// deletes in the steady state — see WriteChunkedValueOptions.
async function writeList(
  userId: string,
  list: DurableActiveEntry[],
  prevChunkCount: number | null,
): Promise<void> {
  await writeChunkedValue(prefixFor(userId), JSON.stringify(list), { prevChunkCount });
}

// Every mutation is a read-modify-write over ONE chunked value, and the
// record-start path deliberately does not await the durable pointer write before
// the native start (it is bounded by raceDurableActiveWrite instead). Serialize
// the mutations so an overlapping call — a failed start's clearActive racing its
// own still-in-flight setActive, or a re-tap while the previous write is
// pending — sees the list the previous call wrote instead of losing it. A
// rejected op never poisons the chain.
//
// Rule 24: the ops are SecureStore calls, which HANG rather than reject on a
// degraded Keystore. A never-settling op would leave this queue pending forever,
// so every later setActive/clearActive is stranded — later captures would carry
// no kill pointer at all, or keep a false one, for the rest of the session. The
// callers' own 400 ms / 3 s races only stop the CALLER waiting; they do nothing
// for the queue. So each op is bounded here too.
const MUTATION_TIMEOUT_MS = 5_000;

let mutationQueue: Promise<void> = Promise.resolve();
/**
 * Bumped whenever an op is abandoned at the deadline. A timed-out op is not
 * cancellable — the native call may still be in flight — so it must not write
 * once the queue has moved on: its list was computed from a read taken before
 * the ops that overtook it, and writing would silently revert them.
 */
let abandonGeneration = 0;
/**
 * An op that blew its deadline and is STILL RUNNING, or null.
 *
 * The isAbandoned() check makes a stalled READ safe, because the op consults it
 * before writing. It cannot make a stalled WRITE safe: by then the chunk writes
 * are already in flight, and aborting between them would leave new chunk bytes
 * under the old count pointer — a torn value that reads as garbage, which is
 * worse than the clobber it avoids (writeChunkedValue deliberately commits by
 * writing the count LAST for exactly that reason).
 *
 * So instead of racing it, we stand off: while a timed-out op is unsettled, later
 * mutations resolve WITHOUT writing. The pointer store goes briefly read-only on
 * a Keystore that is already failing, which loses some kill evidence — strictly
 * safer than a stale write silently reverting a newer one and manufacturing a
 * false or missing kill report.
 */
let stalledOp: Promise<void> | null = null;

/**
 * Clears deferred by the stand-off, replayed once the stall settles.
 *
 * The stand-off is safe for setActive — a dropped write means a MISSING pointer,
 * which merely leaves a real kill unattributable. It is NOT safe for
 * clearActive: a dropped clear leaves a pointer behind for a recording that
 * finished normally, and the next launch reports a process kill that never
 * happened. That is the exact false report this whole detector exists to avoid,
 * so clears are queued and retried instead of discarded.
 */
let pendingClearTasks: (() => Promise<void>)[] = [];

function replayPendingClears(): void {
  if (pendingClearTasks.length === 0) return;
  const tasks = pendingClearTasks;
  pendingClearTasks = [];
  // Re-enter the queue. If the store is still stalled these simply defer again,
  // which terminates as long as the stuck native call eventually settles.
  for (const task of tasks) void task().catch(() => {});
}

function serialized(
  op: (isAbandoned: () => boolean) => Promise<void>,
  onDeferred?: () => void,
): Promise<void> {
  const runOp = async (): Promise<void> => {
    // Stand off while a previous mutation is still in flight past its deadline.
    if (stalledOp) {
      onDeferred?.();
      return;
    }

    const myGeneration = abandonGeneration;
    let abandoned = false;
    const isAbandoned = (): boolean => abandoned || myGeneration !== abandonGeneration;

    const work = op(isAbandoned);
    let workSettled = false;
    const markSettled = (): void => {
      workSettled = true;
    };
    work.then(markSettled, markSettled);

    try {
      await withPromiseTimeout(work, MUTATION_TIMEOUT_MS, 'durable_active_mutation_timeout');
    } catch {
      // Timed out or failed. Abandon it so a late completion cannot clobber the
      // ops that ran while it was stuck, and let the queue advance.
      abandoned = true;
      abandonGeneration++;
      // A REJECTED op is already settled and holds nothing up; only a genuinely
      // hung one becomes the stall barrier.
      if (!workSettled) {
        const release = (): void => {
          if (stalledOp !== stuck) return;
          stalledOp = null;
          replayPendingClears();
        };
        const stuck: Promise<void> = work.then(release, release);
        stalledOp = stuck;
      }
    }
  };
  const run = mutationQueue.then(runOp, runOp);
  mutationQueue = run.catch(() => {});
  return run;
}

export const durableActiveStore = {
  setUserId(userId: string | null): void {
    currentUserId = userId;
  },

  /**
   * The scope the store is bound to right now. Callers that await between
   * deciding to act and acting re-check this, so work launched for one user can
   * never read or clear another user's pointers on a shared tablet.
   */
  getUserId(): string | null {
    return currentUserId;
  },

  setActive(
    recordingId: string,
    slotId: string,
    startedAt: string,
    backend: CaptureBackend = 'durable',
  ): Promise<void> {
    // Bind the user scope NOW, not when the queued op eventually runs. Reading
    // the mutable module global inside the closure means a slow Keystore write
    // that overlaps sign-out lands in the NEXT user's pointer store on a shared
    // tablet (Rule 13): user A loses their kill signal and user B gets a false
    // one, carrying A's recording and slot ids.
    const userId = currentUserId;
    return serialized(async (isAbandoned) => {
      if (!userId || !isValidDurableId(recordingId)) return;
      const { list: existing, chunkCount } = await readList(userId);
      // The read may have outlived our slot in the queue; writing now would
      // revert whatever ran while we were stuck.
      if (isAbandoned()) return;
      const list = existing.filter((e) => e.recordingId !== recordingId);
      list.push({ recordingId, slotId, startedAt, backend });
      while (list.length > MAX_ACTIVE) list.shift();
      await writeList(userId, list, chunkCount);
    });
  },

  clearActive(recordingId: string): Promise<void> {
    // Same scope capture as setActive — a clear that lands after a user switch
    // must not touch the new user's pointers.
    const userId = currentUserId;
    const run = (): Promise<void> =>
      serialized(
        async (isAbandoned) => {
          if (!userId) return;
          const { list, chunkCount } = await readList(userId);
          if (isAbandoned()) return;
          const next = list.filter((e) => e.recordingId !== recordingId);
          if (next.length !== list.length) await writeList(userId, next, chunkCount);
        },
        // Deferred by the stand-off: retry after the stall settles rather than
        // reporting success without clearing. The captured userId travels with
        // the retry, so a later user switch cannot redirect it.
        () => {
          pendingClearTasks.push(run);
        },
      );
    return run();
  },

  async list(): Promise<DurableActiveEntry[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return (await readList(userId)).list;
  },

  /** True if any recording was still marked active from a prior process. */
  async wasRecordingAtLastExit(): Promise<boolean> {
    return (await this.list()).length > 0;
  },

  /**
   * Per-backend counts of captures that outlived their process, for the
   * launch-time kill signal. Never throws — a Keystore failure reads as zero
   * rather than manufacturing a false kill report.
   */
  async capturesAtLastExit(): Promise<LastExitCapture> {
    let list: DurableActiveEntry[];
    try {
      list = await this.list();
    } catch {
      return { durable: 0, expo: 0 };
    }
    let durable = 0;
    let expo = 0;
    for (const e of list) {
      if (e.backend === 'expo') expo++;
      else durable++;
    }
    return { durable, expo };
  },

  clearForUser(userId: string): Promise<void> {
    return serialized(() => deleteChunkedValue(prefixFor(userId)));
  },
};

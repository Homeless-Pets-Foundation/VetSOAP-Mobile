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
import {
  writeChunkedValueVersioned,
  readChunkedValueVersioned,
  deleteChunkedValueVersioned,
} from './chunkedStore';
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

async function readList(userId: string): Promise<DurableActiveEntry[]> {
  const raw = await readChunkedValueVersioned(prefixFor(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DurableActiveEntry =>
        e && typeof e.recordingId === 'string' && typeof e.slotId === 'string',
    );
  } catch {
    return [];
  }
}

// Generation-namespaced write: a late chunk write from an op we already gave up
// on lands on keys nothing reads, so it can never resurrect a stale pointer and
// manufacture a false process-kill report. `shouldCommit` stops an abandoned op
// publishing at all.
async function writeList(
  userId: string,
  list: DurableActiveEntry[],
  shouldCommit?: () => boolean,
): Promise<void> {
  await writeChunkedValueVersioned(prefixFor(userId), JSON.stringify(list), { shouldCommit });
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
 * Serialize the read-modify-writes over this one chunked value, and bound each
 * so the queue always advances.
 *
 * Rule 24: these are SecureStore calls, which HANG rather than reject on a
 * degraded Keystore, and a hung op is not cancellable. Earlier revisions tried
 * to make a late write harmless by standing other writes off while one was
 * stuck; that wedged the store permanently if the stuck call never settled at
 * all — every later setActive dropped and every clearActive queued behind a
 * release that could never fire. Strictly worse than the clobber it prevented.
 *
 * So abandonment is handled at the only place it is actually safe: the commit.
 * `isAbandoned()` is passed down to writeChunkedValue and checked immediately
 * before the count pointer is written, so a timed-out op never publishes. If it
 * had already overwritten some chunks, the value fails JSON.parse and readList
 * reports it ABSENT — pointers are lost, which UNDER-reports a kill, and it
 * cannot fabricate one. Missing evidence over false evidence, and the next
 * successful write repairs it. Newer mutations are never blocked.
 */
function serialized(op: (isAbandoned: () => boolean) => Promise<void>): Promise<void> {
  const runOp = async (): Promise<void> => {
    const myGeneration = abandonGeneration;
    let abandoned = false;
    const isAbandoned = (): boolean => abandoned || myGeneration !== abandonGeneration;
    try {
      await withPromiseTimeout(op(isAbandoned), MUTATION_TIMEOUT_MS, 'durable_active_mutation_timeout');
    } catch {
      abandoned = true;
      abandonGeneration++;
    }
  };
  const run = mutationQueue.then(runOp, runOp);
  mutationQueue = run.catch(() => {});
  return run;
}

/** Bumped when an op is abandoned, so its late commit is refused. */
let abandonGeneration = 0;

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
      const existing = await readList(userId);
      if (isAbandoned()) return;
      const list = existing.filter((e) => e.recordingId !== recordingId);
      list.push({ recordingId, slotId, startedAt, backend });
      while (list.length > MAX_ACTIVE) list.shift();
      // Re-checked between every chunk and at the publish point: the read above
      // may be fast while the write is the part that hangs.
      await writeList(userId, list, () => !isAbandoned());
    });
  },

  clearActive(recordingId: string): Promise<void> {
    // Same scope capture as setActive — a clear that lands after a user switch
    // must not touch the new user's pointers.
    const userId = currentUserId;
    return serialized(async (isAbandoned) => {
      if (!userId) return;
      const list = await readList(userId);
      if (isAbandoned()) return;
      const next = list.filter((e) => e.recordingId !== recordingId);
      if (next.length !== list.length) {
        await writeList(userId, next, () => !isAbandoned());
      }
    });
  },

  /**
   * Clear a pointer for an EXPLICIT user, independent of the current scope.
   *
   * Sign-out rebinds this store to null (AuthProvider) BEFORE clearing the React
   * user state that unmounts the Record screen, so a teardown relying on the
   * ambient scope captures null and silently does nothing. A capture live at
   * sign-out would then be reported as an OS kill on the next launch. Callers
   * that already know whose pointer it is must use this.
   */
  clearActiveForUser(userId: string, recordingId: string): Promise<void> {
    return serialized(async (isAbandoned) => {
      if (!userId) return;
      const list = await readList(userId);
      if (isAbandoned()) return;
      const next = list.filter((e) => e.recordingId !== recordingId);
      if (next.length !== list.length) {
        await writeList(userId, next, () => !isAbandoned());
      }
    });
  },

  /**
   * Remove every entry that started before `cutoffIso`, in ONE serialized
   * mutation, for an EXPLICIT user.
   *
   * Deliberately not a loop of `clearActive(id)` over a snapshot. Expo pointers
   * are keyed by slotId and a resumed draft reuses its slot id, so between the
   * snapshot and a later clear the vet can start a NEW capture under an id the
   * snapshot also holds — clearing by id alone then deletes the LIVE pointer and
   * leaves the running capture with no breadcrumb. Comparing `startedAt` cannot
   * make that mistake: a renewed entry necessarily carries a timestamp at or
   * after the cutoff. It also collapses N Keystore write round trips into one on
   * the launch path.
   */
  pruneStartedBefore(userId: string, cutoffIso: string): Promise<void> {
    return serialized(async (isAbandoned) => {
      if (!userId) return;
      const list = await readList(userId);
      if (isAbandoned()) return;
      const next = list.filter(
        (e) => !(typeof e.startedAt === 'string' && e.startedAt < cutoffIso),
      );
      if (next.length !== list.length) {
        await writeList(userId, next, () => !isAbandoned());
      }
    });
  },

  async list(): Promise<DurableActiveEntry[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return readList(userId);
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
    return serialized(() => deleteChunkedValueVersioned(prefixFor(userId)));
  },
};

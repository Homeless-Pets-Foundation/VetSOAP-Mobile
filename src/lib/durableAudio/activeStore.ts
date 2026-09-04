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
// record-start path deliberately does not await the pointer write before the
// native start (it is bounded by raceDurableActiveWrite instead). Serialize the
// mutations so an overlapping call — a failed start's clearActive racing its
// own still-in-flight setActive, or a re-tap while the previous write is
// pending — sees the list the previous call wrote instead of losing it. A
// rejected op never poisons the chain.
let mutationQueue: Promise<void> = Promise.resolve();
function serialized(op: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(op, op);
  mutationQueue = run.catch(() => {});
  return run;
}

export const durableActiveStore = {
  setUserId(userId: string | null): void {
    currentUserId = userId;
  },

  setActive(
    recordingId: string,
    slotId: string,
    startedAt: string,
    backend: CaptureBackend = 'durable',
  ): Promise<void> {
    return serialized(async () => {
      const userId = currentUserId;
      if (!userId || !isValidDurableId(recordingId)) return;
      const { list: existing, chunkCount } = await readList(userId);
      const list = existing.filter((e) => e.recordingId !== recordingId);
      list.push({ recordingId, slotId, startedAt, backend });
      while (list.length > MAX_ACTIVE) list.shift();
      await writeList(userId, list, chunkCount);
    });
  },

  clearActive(recordingId: string): Promise<void> {
    return serialized(async () => {
      const userId = currentUserId;
      if (!userId) return;
      const { list, chunkCount } = await readList(userId);
      const next = list.filter((e) => e.recordingId !== recordingId);
      if (next.length !== list.length) await writeList(userId, next, chunkCount);
    });
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

/**
 * Tiny user-scoped chunked JSON value store over SecureStore, for durable
 * recorder bookkeeping (purged-uploaded tombstone, active-recording pointer).
 *
 * Android EncryptedSharedPreferences has a ~2KB practical per-value limit, so
 * values are split across `${prefix}_chunk_${i}` keys with a `${prefix}_count`
 * pointer (same approach as draftStorage/stashStorage). These keys use the
 * `captivet_durable_*` prefix and are NOT in secureStorage.clearAll()'s
 * delete allowlist, so they survive sign-out / session-expiry exactly like
 * RECOVERY_INTENT and DEVICE_ID (plan: must survive clearAll()).
 */
import { secureStorage } from '../secureStorage';
import { readChunksBounded, MAX_CHUNKS_PER_VALUE } from '../chunkedRead';

const CHUNK_SIZE = 1900;
const MAX_STALE_SWEEP = 16;

export interface WriteChunkedValueOptions {
  /**
   * Chunk count of the value previously stored under `prefix`, when the caller
   * has just read it (see `readChunkedValueWithCount`). Chunks at index >= the
   * persisted count are never read, so the stale sweep is hygiene, not
   * correctness — and with the previous count known it covers exactly
   * `[chunks.length, prevChunkCount)`. On the record-start path the blind
   * 16-key sweep was ~16 serial Keystore round trips awaited before the mic
   * was touched. `null`/omitted keeps the full sweep (unknown prior length).
   */
  prevChunkCount?: number | null;
  /**
   * Consulted immediately before the COUNT pointer is written — the commit
   * point. Returning false aborts without committing.
   *
   * This is how a caller cancels a write it has already given up on (see
   * activeStore's mutation deadline). Aborting here is safe in the direction
   * that matters: the count still describes the PREVIOUS length, so the value
   * either reads as it did before or, if this op had already overwritten some
   * chunks, fails JSON.parse and is read as ABSENT by every caller. Losing
   * pointers under-reports a kill; it cannot fabricate one, because a fabricated
   * read would require mixed chunk bytes to parse as a valid entry array.
   */
  shouldCommit?: () => boolean;
}

export async function writeChunkedValue(
  prefix: string,
  value: string,
  opts?: WriteChunkedValueOptions,
): Promise<boolean> {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }
  // Write chunks first, then the count pointer last (a torn write leaves the old
  // count, so a partial new value is never read).
  for (let i = 0; i < chunks.length; i++) {
    const ok = await secureStorage.setRawItem(`${prefix}_chunk_${i}`, chunks[i], 'durableChunkWrite');
    if (!ok) return false;
  }
  // Commit point. A caller that has already timed out must not publish here.
  if (opts?.shouldCommit && !opts.shouldCommit()) return false;
  const ok = await secureStorage.setRawItem(`${prefix}_count`, String(chunks.length), 'durableChunkCount');
  if (!ok) return false;
  // Sweep stale higher-index chunks left by a prior longer value.
  // Clamp to MAX_CHUNKS_PER_VALUE: `prevChunkCount` comes from persisted data,
  // and no honest value can exceed the reader's own ceiling. Without this an
  // implausible count turns hygiene into an unbounded serial delete loop.
  const prev = opts?.prevChunkCount;
  const prevUsable =
    typeof prev === 'number' && Number.isInteger(prev) && prev >= 0 && prev <= MAX_CHUNKS_PER_VALUE;
  const sweepEnd = prevUsable ? (prev as number) : chunks.length + MAX_STALE_SWEEP;
  for (let i = chunks.length; i < sweepEnd; i++) {
    await secureStorage.deleteRawItem(`${prefix}_chunk_${i}`, 'durableChunkSweep');
  }
  return true;
}

/**
 * Versioned (generation-namespaced) variant, for values where a LATE write from
 * an abandoned operation must never become readable.
 *
 * The plain writer overwrites `${prefix}_chunk_i` in place. That is fine when
 * writes always complete, but a SecureStore call that hangs past its caller's
 * deadline and lands later will overwrite whatever newer payload replaced it.
 * Checking a commit flag before the `_count` write does not help: these values
 * are typically a SINGLE chunk and keep the same count, so the resurrected JSON
 * parses cleanly and silently restores stale state. For the active-capture
 * pointer that means a recording which finished normally reappears as live, and
 * the next launch reports a process kill that never happened.
 *
 * Here each write goes to a fresh generation — `${prefix}_g{N}_chunk_i` — and
 * publishes by writing ONE pointer key, `${prefix}_ptr` = {"g":N,"n":count}.
 * A late chunk write from generation N-1 therefore lands on keys nothing reads.
 * A late POINTER write can still regress the generation, but the older
 * generation's chunks have been swept, so it reads as absent rather than stale —
 * losing a pointer under-reports a kill, it cannot fabricate one.
 */
interface VersionedPointer {
  g: number;
  n: number;
}

function parseVersionedPointer(raw: string | null): VersionedPointer | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VersionedPointer>;
    if (
      typeof parsed?.g !== 'number' ||
      typeof parsed?.n !== 'number' ||
      !Number.isInteger(parsed.g) ||
      !Number.isInteger(parsed.n) ||
      parsed.g < 0 ||
      parsed.n < 0 ||
      parsed.n > MAX_CHUNKS_PER_VALUE
    ) {
      return null;
    }
    return { g: parsed.g, n: parsed.n };
  } catch {
    return null;
  }
}

export async function readChunkedValueVersioned(prefix: string): Promise<string | null> {
  const ptr = parseVersionedPointer(
    await secureStorage.getRawItem(`${prefix}_ptr`, 'durableChunkPtrRead'),
  );
  if (!ptr) {
    // No versioned pointer yet — fall back to the legacy layout so an install
    // that predates this migration still reads its existing value.
    return readChunkedValue(prefix);
  }
  if (ptr.n === 0) return '';
  const result = await readChunksBounded(ptr.n, (i) =>
    secureStorage.getRawItem(`${prefix}_g${ptr.g}_chunk_${i}`, 'durableChunkRead'),
  );
  return result.ok ? result.parts.join('') : null;
}

/**
 * Generations rotate through a small ring rather than incrementing forever.
 *
 * A ring means no sweep is needed: reusing a generation overwrites its own keys
 * in place, and the pointer's `n` bounds how many are ever read, so a shrunken
 * value leaves at most a few unreadable orphans. That matters because setActive
 * runs on the record-start critical path, before the mic opens — a per-write
 * delete is exactly the serial-Keystore latency the record-perf work removed.
 *
 * Safety margin: a late write can only collide once GEN_RING further writes have
 * published, i.e. a call hung across eight subsequent mutations of the same
 * value. The window it closes (a single stalled write landing after the next
 * one) is the realistic case.
 */
const GEN_RING = 8;

/**
 * Last generation HANDED OUT per prefix, which is not the same as the last
 * generation published.
 *
 * Deriving the next generation from the stored pointer looks right and is
 * wrong: an abandoned write never publishes, so the pointer still names the
 * generation before it, and the very next write picks the SAME generation the
 * abandoned one is still writing into. Its late chunk write then lands under the
 * generation the new pointer references — exactly the resurrection this layout
 * exists to prevent. Handing out generations per ATTEMPT keeps them disjoint.
 *
 * In-memory only: a hung native call cannot outlive its process, so a fresh
 * process has nothing in flight to collide with, and the counter is seeded from
 * the persisted pointer on first use.
 */
const lastHandedOutGen = new Map<string, number>();

export async function writeChunkedValueVersioned(
  prefix: string,
  value: string,
  opts?: { shouldCommit?: () => boolean },
): Promise<boolean> {
  const current = parseVersionedPointer(
    await secureStorage.getRawItem(`${prefix}_ptr`, 'durableChunkPtrRead'),
  );
  const seen = lastHandedOutGen.get(prefix);
  const base = seen ?? current?.g ?? -1;
  const gen = (base + 1) % GEN_RING;
  lastHandedOutGen.set(prefix, gen);

  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }
  if (chunks.length > MAX_CHUNKS_PER_VALUE) return false;

  for (let i = 0; i < chunks.length; i++) {
    // Bail between chunks too: no point writing the rest of a generation that
    // will never be published.
    if (opts?.shouldCommit && !opts.shouldCommit()) return false;
    const ok = await secureStorage.setRawItem(`${prefix}_g${gen}_chunk_${i}`, chunks[i], 'durableChunkWrite');
    if (!ok) return false;
  }
  if (opts?.shouldCommit && !opts.shouldCommit()) return false;
  // Single-key publish. Nothing is deleted here — see GEN_RING.
  return secureStorage.setRawItem(
    `${prefix}_ptr`,
    JSON.stringify({ g: gen, n: chunks.length } satisfies VersionedPointer),
    'durableChunkPtrWrite',
  );
}

/** Full teardown for a user scope: pointer, every ring generation, and legacy. */
export async function deleteChunkedValueVersioned(prefix: string): Promise<void> {
  await secureStorage.deleteRawItem(`${prefix}_ptr`, 'durableChunkSweep');
  for (let g = 0; g < GEN_RING; g++) {
    for (let i = 0; i < MAX_STALE_SWEEP; i++) {
      await secureStorage.deleteRawItem(`${prefix}_g${g}_chunk_${i}`, 'durableChunkSweep');
    }
  }
  await deleteChunkedValue(prefix);
}

export interface ChunkedValueWithCount {
  value: string | null;
  /**
   * Persisted chunk count: `0` when no count pointer exists (proven absent),
   * the stored count when it parsed (even if the chunk set was torn — it is
   * still the upper bound a prior writer intended), `null` when the pointer is
   * corrupt so a later write falls back to the full sweep.
   */
  chunkCount: number | null;
}

/** Read the value AND its persisted chunk count, so a read-modify-write can
 *  thread the count into `writeChunkedValue` and skip the blind sweep. */
export async function readChunkedValueWithCount(prefix: string): Promise<ChunkedValueWithCount> {
  const countStr = await secureStorage.getRawItem(`${prefix}_count`, 'durableChunkCountRead');
  if (!countStr) return { value: null, chunkCount: 0 };
  const count = parseInt(countStr, 10);
  if (!Number.isFinite(count) || count < 0) return { value: null, chunkCount: null };
  // `durableTombstone.has()` calls this per draft during the orphan/eviction
  // sweeps and the list can reach ~7 chunks at MAX_TOMBSTONES, so the serial
  // version cost ~8 Keystore round trips per probe. Windowed rather than fully
  // eager because the count is persisted data and can be corrupt; a torn or
  // implausible set is still "absent".
  const result = await readChunksBounded(count, (i) =>
    secureStorage.getRawItem(`${prefix}_chunk_${i}`, 'durableChunkRead'),
  );
  if (!result.ok) {
    // A TORN set still tells us what the prior writer intended, so the count is
    // a usable sweep bound. A count the reader rejected as not credible
    // (`count_too_large`, i.e. > MAX_CHUNKS_PER_VALUE) must NOT be forwarded:
    // writeChunkedValue would take it as the sweep end and run that many
    // sequential Keystore deletes. A corrupt `_count` of 999999999 would then
    // occupy activeStore's mutation queue effectively forever, stranding every
    // later pointer write and silently disabling the process-kill detector.
    // `null` falls back to the bounded stale sweep.
    return { value: null, chunkCount: result.reason === 'count_too_large' ? null : count };
  }
  return { value: result.parts.join(''), chunkCount: count };
}

export async function readChunkedValue(prefix: string): Promise<string | null> {
  return (await readChunkedValueWithCount(prefix)).value;
}

/**
 * A read that distinguishes PROVEN ABSENCE from an unavailable value.
 *
 * `readChunkedValue` collapses "no count key", "torn chunk set" and "Keystore
 * read failed" all to `null`, which is fine for a lenient reader but is unsafe
 * for anything that then WRITES: a caller that treats unavailable as empty and
 * persists the result destroys whatever was really stored. The tombstone list is
 * exactly that case — it is the guard that stops `cleanupOrphaned` deleting a
 * confirmed-uploaded recording.
 *
 * Any native failure is reported as `unavailable` rather than propagating, so
 * callers stay total; the strict SecureStore reader keeps the Keystore call
 * wrapped and the failure reported through the usual rate-limited channel.
 */
export type ChunkedValueRead =
  | { status: 'value'; value: string }
  | { status: 'absent' }
  | { status: 'unavailable' };

export async function readChunkedValueStrict(prefix: string): Promise<ChunkedValueRead> {
  let countStr: string | null;
  try {
    countStr = await secureStorage.getRawItemStrict(
      `${prefix}_count`,
      'durableChunkCountReadStrict',
    );
  } catch {
    return { status: 'unavailable' };
  }
  // No count pointer at all is the one situation that genuinely proves absence.
  if (countStr === null) return { status: 'absent' };

  const count = Number(countStr);
  if (!/^[0-9]{1,6}$/.test(countStr) || !Number.isInteger(count) || count < 0) {
    return { status: 'unavailable' };
  }
  if (count === 0) return { status: 'value', value: '' };

  try {
    const result = await readChunksBounded(count, (i) =>
      secureStorage.getRawItemStrict(`${prefix}_chunk_${i}`, 'durableChunkReadStrict'),
    );
    // A torn set or an implausible count is present-but-unrecoverable, never
    // absence — a chunk key existed, we just could not read the whole value.
    if (!result.ok) return { status: 'unavailable' };
    return { status: 'value', value: result.parts.join('') };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function deleteChunkedValue(prefix: string): Promise<void> {
  const countStr = await secureStorage.getRawItem(`${prefix}_count`, 'durableChunkCountRead');
  const count = countStr ? parseInt(countStr, 10) : 0;
  const max = Number.isFinite(count) ? count : 0;
  for (let i = 0; i < Math.max(max, MAX_STALE_SWEEP); i++) {
    await secureStorage.deleteRawItem(`${prefix}_chunk_${i}`, 'durableChunkDelete');
  }
  await secureStorage.deleteRawItem(`${prefix}_count`, 'durableChunkDelete');
}

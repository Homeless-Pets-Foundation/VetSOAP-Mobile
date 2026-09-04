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
import { readChunksBounded } from '../chunkedRead';

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
  const ok = await secureStorage.setRawItem(`${prefix}_count`, String(chunks.length), 'durableChunkCount');
  if (!ok) return false;
  // Sweep stale higher-index chunks left by a prior longer value.
  const prev = opts?.prevChunkCount;
  const sweepEnd =
    typeof prev === 'number' && Number.isInteger(prev) && prev >= 0
      ? prev
      : chunks.length + MAX_STALE_SWEEP;
  for (let i = chunks.length; i < sweepEnd; i++) {
    await secureStorage.deleteRawItem(`${prefix}_chunk_${i}`, 'durableChunkSweep');
  }
  return true;
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
  if (!result.ok) return { value: null, chunkCount: count }; // torn / not-credible read -> treat as absent
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

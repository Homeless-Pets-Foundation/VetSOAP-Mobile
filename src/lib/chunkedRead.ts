/**
 * Bounded parallel reader for the chunked SecureStore layouts
 * (`draftStorage`, `stashStorage`, `durableAudio/chunkedStore`).
 *
 * Android's EncryptedSharedPreferences has a ~2KB practical per-value limit, so
 * every large value is split across `${prefix}${i}` keys with a separate count
 * pointer. Reading those serially is what made `local_draft_list` take 11.7s on
 * a clinic tablet — each read is a JNI hop plus an AES-GCM decrypt.
 *
 * Reading them ALL at once is not the answer either. The count is itself
 * persisted data and can be corrupt: `parseStrictChunkCount` accepts values up
 * to 999,999, and the lenient draft path had no ceiling at all. An eager
 * `Array.from({ length: count })` would allocate and dispatch every request
 * before discovering the first missing chunk, so one malformed local value
 * could enqueue hundreds of thousands of native bridge calls. The serial loop it
 * replaced stopped at the first absent chunk.
 *
 * So: fixed-size windows. Bounded concurrency, bounded allocation, and the
 * early exit is preserved — a torn set stops after at most one window instead of
 * walking the whole corrupt count.
 */

/**
 * Per-value ceiling on chunk count. At 1900 bytes per chunk this is ~1MB for a
 * single stored value, orders of magnitude above any real draft, stash list or
 * tombstone list, while rejecting a corrupt count outright.
 */
export const MAX_CHUNKS_PER_VALUE = 512;

/** Chunk reads in flight at once for a single value. */
export const CHUNK_READ_WINDOW = 8;

export type ChunkReadResult =
  | { ok: true; parts: string[] }
  /** `count` exceeded MAX_CHUNKS_PER_VALUE — the pointer itself is not credible. */
  | { ok: false; reason: 'count_too_large' }
  /** A referenced chunk key was absent — a torn write. */
  | { ok: false; reason: 'torn' };

/**
 * Read `count` chunks through `readChunk`, in windows of `CHUNK_READ_WINDOW`.
 *
 * Parts come back in index order. A rejection from `readChunk` propagates — the
 * FIRST one by index, so the surfaced error is deterministic and matches what
 * the serial loop would have produced. Rejections inside a window are collected
 * with `allSettled` rather than `all`, so a second concurrent rejection is still
 * observed; an unobserved rejection is a Hermes release-build crash (rule 4).
 *
 * Callers map the failure reasons onto their own contract — the lenient readers
 * return `null`, the strict readers throw `StrictReadUnavailableError`.
 */
export async function readChunksBounded(
  count: number,
  readChunk: (index: number) => Promise<string | null>,
  options?: { maxChunks?: number; windowSize?: number },
): Promise<ChunkReadResult> {
  const maxChunks = options?.maxChunks ?? MAX_CHUNKS_PER_VALUE;
  const windowSize = Math.max(1, options?.windowSize ?? CHUNK_READ_WINDOW);

  if (!Number.isInteger(count) || count < 0 || count > maxChunks) {
    return { ok: false, reason: 'count_too_large' };
  }
  if (count === 0) return { ok: true, parts: [] };

  const parts: string[] = [];
  for (let start = 0; start < count; start += windowSize) {
    const end = Math.min(start + windowSize, count);
    const settled = await Promise.allSettled(
      Array.from({ length: end - start }, (_, offset) => readChunk(start + offset)),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw outcome.reason;
      // Stop at the first absent chunk, exactly as the serial loop did.
      if (outcome.value === null) return { ok: false, reason: 'torn' };
      parts.push(outcome.value);
    }
  }
  return { ok: true, parts };
}

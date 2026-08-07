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

const CHUNK_SIZE = 1900;
const MAX_STALE_SWEEP = 16;

export async function writeChunkedValue(prefix: string, value: string): Promise<boolean> {
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
  for (let i = chunks.length; i < chunks.length + MAX_STALE_SWEEP; i++) {
    await secureStorage.deleteRawItem(`${prefix}_chunk_${i}`, 'durableChunkSweep');
  }
  return true;
}

export async function readChunkedValue(prefix: string): Promise<string | null> {
  const countStr = await secureStorage.getRawItem(`${prefix}_count`, 'durableChunkCountRead');
  if (!countStr) return null;
  const count = parseInt(countStr, 10);
  if (!Number.isFinite(count) || count < 0) return null;
  // Key names are known once the count is read. `durableTombstone.has()` calls
  // this per draft during the orphan/eviction sweeps and the list can reach
  // ~7 chunks at MAX_TOMBSTONES, so the serial version cost ~8 Keystore round
  // trips per probe. Index order is preserved; a torn set is still "absent".
  const chunks = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      secureStorage.getRawItem(`${prefix}_chunk_${i}`, 'durableChunkRead'),
    ),
  );
  if (chunks.some((chunk) => chunk === null)) return null; // torn read -> treat as absent
  return chunks.join('');
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

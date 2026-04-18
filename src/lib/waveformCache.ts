import { Paths, File as ExpoFile, Directory } from 'expo-file-system';
import { safeDeleteDirectory } from './fileOps';

const CACHE_DIR = `${Paths.cache.uri}waveform-peaks/`;
const MAX_CACHE_ENTRIES = 100;

/**
 * In-memory LRU access tracking. Map iteration order follows insertion order
 * (ES2015+), so `delete + set` on hit re-inserts the key at the tail,
 * leaving the oldest-accessed keys at the head for eviction.
 *
 * This is a session-local signal: on cold start the map is empty and
 * eviction falls back to file mtime. Within a session, frequently-viewed
 * recordings survive even if they haven't been re-written recently.
 */
const accessOrder = new Map<string, number>();

function touchAccess(filename: string): void {
  accessOrder.delete(filename);
  accessOrder.set(filename, Date.now());
}

/**
 * Build a deterministic cache filename from a file URI and its size.
 * When a file is trimmed, the URI changes — so the old cache auto-invalidates.
 *
 * Hashes the full URI (not just the last segment) so two files with the
 * same basename but different parent dirs don't collide — e.g. a trim
 * operation producing an output whose filename matches an unrelated
 * source file of the same byte count.
 */
function cacheKey(fileUri: string, fileSize: number): string {
  // DJB2-style hash, kept identical to main's impl so rebase is conflict-free.
  let hash = 5381;
  for (let i = 0; i < fileUri.length; i++) {
    hash = ((hash << 5) + hash) ^ fileUri.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return `wf_${hash.toString(16)}_${fileSize}.json`;
}

/**
 * Return cached waveform peaks for a file, or null on cache miss/error.
 */
export async function getCachedPeaks(fileUri: string, fileSize: number): Promise<number[] | null> {
  try {
    const name = cacheKey(fileUri, fileSize);
    const file = new ExpoFile(CACHE_DIR + name);
    if (!file.exists) return null;
    const json = await file.text();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    touchAccess(name);
    return parsed as number[];
  } catch {
    return null;
  }
}

/**
 * Write waveform peaks to the cache. Fire-and-forget — failures are silently swallowed.
 *
 * When the cache exceeds MAX_CACHE_ENTRIES, the oldest-accessed entries are
 * evicted (true LRU within a session; mtime fallback across cold-starts).
 */
export function cachePeaks(fileUri: string, fileSize: number, peaks: number[]): void {
  try {
    const dir = new Directory(CACHE_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
    const entries = dir.list();
    if (entries.length >= MAX_CACHE_ENTRIES) {
      const files = entries
        .filter((e): e is ExpoFile => e instanceof ExpoFile)
        .map((f) => {
          // Prefer in-memory access time. Fall back to file mtime for entries
          // we haven't observed yet this session.
          const recorded = accessOrder.get(f.name);
          const mtime = f.modificationTime ?? 0;
          return { file: f, score: recorded ?? mtime };
        })
        .sort((a, b) => a.score - b.score);
      const deleteCount = Math.ceil(files.length / 2);
      for (let i = 0; i < deleteCount; i++) {
        const name = files[i].file.name;
        try { files[i].file.delete(); } catch { /* best-effort */ }
        accessOrder.delete(name);
      }
    }
    const name = cacheKey(fileUri, fileSize);
    new ExpoFile(CACHE_DIR + name).write(JSON.stringify(peaks));
    touchAccess(name);
  } catch {
    // Best-effort — waveform will just be re-extracted next time
  }
}

/**
 * Delete the entire waveform peak cache directory.
 * Called during sign-out to prevent stale data lingering across user sessions.
 */
export function clearPeakCache(): void {
  safeDeleteDirectory(CACHE_DIR);
  accessOrder.clear();
}

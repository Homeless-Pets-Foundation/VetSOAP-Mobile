import { Paths, File as ExpoFile } from 'expo-file-system';
import { ensureDirectory, safeDeleteDirectory } from './fileOps';

const CACHE_DIR = `${Paths.cache.uri}waveform-peaks/`;

/**
 * Build a deterministic cache filename from a file URI and its size.
 * When a file is trimmed, the URI changes — so the old cache auto-invalidates.
 */
function cacheKey(fileUri: string, fileSize: number): string {
  // Hash the full URI so two files with the same filename but different paths
  // don't collide (e.g. after trim operations produce same-size outputs).
  let hash = 5381;
  for (let i = 0; i < fileUri.length; i++) {
    hash = ((hash << 5) + hash) ^ fileUri.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return `wf_${hash.toString(16)}_${fileSize}.json`;
}

/**
 * Return cached waveform peaks for a file, or null on cache miss/error.
 * Cache is keyed by file URI (last segment) + file size in bytes.
 */
export async function getCachedPeaks(fileUri: string, fileSize: number): Promise<number[] | null> {
  try {
    const path = CACHE_DIR + cacheKey(fileUri, fileSize);
    const file = new ExpoFile(path);
    if (!file.exists) return null;
    const json = await file.text();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

/**
 * Write waveform peaks to the cache. Fire-and-forget — failures are silently swallowed.
 */
export function cachePeaks(fileUri: string, fileSize: number, peaks: number[]): void {
  try {
    ensureDirectory(CACHE_DIR);
    const path = CACHE_DIR + cacheKey(fileUri, fileSize);
    new ExpoFile(path).write(JSON.stringify(peaks));
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
}

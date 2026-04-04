import { Paths } from 'expo-file-system';
import { File as ExpoFile, Directory } from 'expo-file-system';

const CACHE_DIR = `${Paths.cache.uri}waveform-peaks/`;

/**
 * Build a deterministic cache filename from a file URI and its size.
 * When a file is trimmed, the URI changes — so the old cache auto-invalidates.
 */
function cacheKey(fileUri: string, fileSize: number): string {
  // Use the last path segment + size as the key. Replace non-alphanumeric chars
  // to produce a safe filename. Truncate to avoid hitting filesystem path limits.
  const base = fileUri.split('/').pop() ?? 'audio';
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `${safe}_${fileSize}.json`;
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
    const dir = new Directory(CACHE_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
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
  try {
    const dir = new Directory(CACHE_DIR);
    if (dir.exists) dir.delete();
  } catch {
    // Best-effort
  }
}

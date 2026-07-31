import { isStaleDurableUploadSnapshotBasename } from './durableUploadSnapshot';

export interface AudioCacheEntry {
  name: string;
  uri: string;
  isFile: boolean;
}

export function shouldDeleteAudioCacheFile(name: string): boolean {
  // Preserve the established best-effort cleanup of legacy expo-audio cache
  // recordings. AAC deletion stays in the strict durable-snapshot namespace.
  return (
    name.endsWith('.m4a') ||
    isStaleDurableUploadSnapshotBasename(name)
  );
}

export function cleanupAudioCacheEntries(
  entries: readonly AudioCacheEntry[],
  deleteFile: (uri: string) => void,
): void {
  for (const entry of entries) {
    if (!entry.isFile || !shouldDeleteAudioCacheFile(entry.name)) continue;
    try {
      deleteFile(entry.uri);
    } catch {
      // One failed orphan deletion must not block cleanup of later entries.
    }
  }
}

export function scheduleAudioCacheCleanup(
  cleanup: () => void,
  delayMs = 5_000,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    try {
      cleanup();
    } catch {
      // Deferred cleanup is independent and must never affect auth startup.
    }
  }, delayMs);
}

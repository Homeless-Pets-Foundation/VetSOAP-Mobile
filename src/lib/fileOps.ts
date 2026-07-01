import { File, Directory } from 'expo-file-system';

/**
 * Delete a file if it exists. Silently succeeds if the file is missing or
 * deletion fails (matches the old `deleteAsync(uri, { idempotent: true })`
 * behaviour). Synchronous — no `.catch()` needed.
 */
export function safeDeleteFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Best-effort — file may have been removed between exists check and delete
  }
}

/**
 * Delete a directory recursively if it exists. Silently succeeds if the
 * directory is missing or deletion fails.
 */
export function safeDeleteDirectory(uri: string): void {
  try {
    const d = new Directory(uri);
    if (d.exists) d.delete();
  } catch {
    // Best-effort
  }
}

/** Returns `true` if a file exists at `uri`. Never throws. */
export function fileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** Returns `true` if a directory exists at `uri`. Never throws. */
export function directoryExists(uri: string): boolean {
  try {
    return new Directory(uri).exists;
  } catch {
    return false;
  }
}

/**
 * Create a directory (and intermediates) if it doesn't already exist. Never throws.
 * Returns true if the directory exists after the call, false if creation failed.
 * Callers that care about the outcome (e.g. draft persistence) should check the
 * return value; legacy callers that fired-and-forgot still work because the
 * return is ignored.
 */
export function ensureDirectory(uri: string): boolean {
  try {
    const d = new Directory(uri);
    if (!d.exists) d.create({ intermediates: true });
    return d.exists;
  } catch {
    return false;
  }
}

/**
 * Copy a file using the current expo-file-system File API. The underlying copy
 * call is synchronous, so this wrapper yields before and after the native call
 * to keep multi-file recovery flows from monopolizing one JS turn.
 */
export async function safeCopyFile(sourceUri: string, destUri: string): Promise<boolean> {
  if (!fileExists(sourceUri)) return false;
  safeDeleteFile(destUri);
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    new File(sourceUri).copy(new File(destUri));
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return fileExists(destUri);
}

/**
 * Copy only the first `byteCount` bytes of `sourceUri` into `destUri`,
 * overwriting any existing dest. Streams via a FileHandle in bounded chunks so a
 * large recording never loads whole into JS memory.
 *
 * Used by the durable-AAC upload path: a crash can leave a torn partial ADTS
 * frame past the manifest's `completeFrameBytes` anchor, so we upload only the
 * complete-frame prefix rather than the raw (possibly malformed-tailed) file.
 * Returns true only when exactly `byteCount` bytes were written; false on any
 * open/read/write failure or short read (caller falls back to the full file).
 */
export function writeFilePrefix(sourceUri: string, destUri: string, byteCount: number): boolean {
  if (!Number.isFinite(byteCount) || byteCount <= 0) return false;
  let src: ReturnType<File['open']> | null = null;
  let dst: ReturnType<File['open']> | null = null;
  try {
    const source = new File(sourceUri);
    if (!source.exists) return false;
    const dest = new File(destUri);
    if (dest.exists) dest.delete();
    dest.create();
    src = source.open();
    dst = dest.open();
    const CHUNK = 1024 * 1024; // 1 MiB
    let remaining = Math.floor(byteCount);
    while (remaining > 0) {
      const toRead = Math.min(CHUNK, remaining);
      const bytes = src.readBytes(toRead);
      if (!bytes || bytes.length === 0) break; // EOF before byteCount
      dst.writeBytes(bytes);
      remaining -= bytes.length;
      if (bytes.length < toRead) break; // short read: source shorter than byteCount
    }
    return remaining <= 0;
  } catch {
    return false;
  } finally {
    try { src?.close(); } catch { /* best-effort */ }
    try { dst?.close(); } catch { /* best-effort */ }
  }
}

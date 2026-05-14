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

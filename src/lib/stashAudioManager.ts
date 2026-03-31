import {
  documentDirectory,
  getInfoAsync,
  copyAsync,
  deleteAsync,
  makeDirectoryAsync,
  readDirectoryAsync,
  writeAsStringAsync,
  readAsStringAsync,
} from 'expo-file-system/legacy';
import type { PatientSlot } from '../types/multiPatient';
import type { StashedSlot, StashedSession } from '../types/stash';

const BASE_STASH_DIR = `${documentDirectory}stashed-audio/`;

/** Current user ID — set by AuthProvider to scope audio files per-user. */
let currentUserId: string | null = null;

function userStashDir(): string {
  if (!currentUserId) throw new Error('Stash audio manager: no user ID set');
  return `${BASE_STASH_DIR}${currentUserId}/`;
}

/** Validate sessionId to prevent path traversal attacks. */
function validateSessionId(sessionId: string): void {
  if (!sessionId || /[\/\\.]/.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
}

function sessionDir(sessionId: string): string {
  validateSessionId(sessionId);
  return `${userStashDir()}${sessionId}/`;
}

export const stashAudioManager = {
  /** Set the current user ID. Must be called before any stash operations. */
  setUserId(userId: string | null): void {
    currentUserId = userId;
  },

  /**
   * Move audio segment files from cacheDirectory to persistent stash directory.
   * Uses copy-then-delete for safety — if copy fails, original is untouched.
   * Returns StashedSlot[] with updated URIs pointing to documentDirectory.
   */
  async moveSegmentsToStashDir(
    sessionId: string,
    slots: PatientSlot[]
  ): Promise<StashedSlot[]> {
    const dir = sessionDir(sessionId);
    try {
      await makeDirectoryAsync(dir, { intermediates: true });

      const stashedSlots: StashedSlot[] = [];
      let segmentIndex = 0;

      for (const slot of slots) {
        const stashedSegments: { uri: string; duration: number }[] = [];

        for (const segment of slot.segments) {
          const info = await getInfoAsync(segment.uri);
          if (!info.exists) continue;

          const destUri = `${dir}segment-${segmentIndex}.m4a`;
          await copyAsync({ from: segment.uri, to: destUri });

          // Verify copy succeeded before deleting original
          const destInfo = await getInfoAsync(destUri);
          if (destInfo.exists) {
            await deleteAsync(segment.uri, { idempotent: true }).catch(() => {});
            stashedSegments.push({ uri: destUri, duration: segment.duration });
          }
          // If copy failed, skip this segment entirely. The original is in
          // cacheDirectory which gets cleaned up — keeping that URI would
          // create a stash that silently loses audio on restore.
          segmentIndex++;
        }

        stashedSlots.push({
          id: slot.id,
          formData: { ...slot.formData },
          segments: stashedSegments,
          audioDuration: stashedSegments.reduce((sum, s) => sum + s.duration, 0),
        });
      }

      return stashedSlots;
    } catch (error) {
      // Clean up partially-copied files on failure
      await deleteAsync(dir, { idempotent: true }).catch(() => {});
      throw error;
    }
  },

  /**
   * Validate that all audio files in a stashed session still exist.
   * Returns slots with only valid segments. Removes slots with zero valid segments.
   */
  async validateStashedAudio(
    slots: StashedSlot[]
  ): Promise<{ validSlots: StashedSlot[]; allValid: boolean; missingCount: number }> {
    let missingCount = 0;
    const validSlots: StashedSlot[] = [];

    for (const slot of slots) {
      const validSegments: { uri: string; duration: number }[] = [];
      for (const segment of slot.segments) {
        const info = await getInfoAsync(segment.uri);
        if (info.exists) {
          validSegments.push(segment);
        } else {
          missingCount++;
        }
      }

      // Keep slots even if they have no segments (they still have form data)
      validSlots.push({
        ...slot,
        segments: validSegments,
        audioDuration: validSegments.reduce((sum, s) => sum + s.duration, 0),
      });
    }

    return {
      validSlots,
      allValid: missingCount === 0,
      missingCount,
    };
  },

  async deleteStashedAudio(sessionId: string): Promise<void> {
    try {
      const dir = sessionDir(sessionId);
      const info = await getInfoAsync(dir);
      if (info.exists) {
        await deleteAsync(dir, { idempotent: true });
      }
    } catch {
      // Best-effort cleanup
    }
  },

  /** Delete all stashed audio for the current user. */
  async deleteAllStashedAudio(): Promise<void> {
    try {
      if (!currentUserId) return;
      const dir = userStashDir();
      const info = await getInfoAsync(dir);
      if (info.exists) {
        await deleteAsync(dir, { idempotent: true });
      }
    } catch {
      // Best-effort cleanup
    }
  },

  /**
   * Delete only legacy (non-user-scoped) stash directories.
   * Entries that look like UUIDs are user-scoped directories and are preserved.
   * Only used during legacy cleanup migration.
   */
  async deleteAllStashedAudioGlobal(): Promise<void> {
    try {
      const info = await getInfoAsync(BASE_STASH_DIR);
      if (!info.exists) return;
      const entries = await readDirectoryAsync(BASE_STASH_DIR);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      await Promise.all(
        entries
          .filter((e) => !uuidPattern.test(e)) // Skip user-scoped dirs (UUIDs)
          .map((e) => deleteAsync(`${BASE_STASH_DIR}${e}`, { idempotent: true }).catch(() => {}))
      );
    } catch {
      // Best-effort cleanup
    }
  },

  /**
   * Write a recovery manifest alongside the audio files.
   * If the app crashes before SecureStore is written, this manifest
   * allows the stash to be recovered on next launch.
   */
  async writeRecoveryManifest(sessionId: string, session: StashedSession): Promise<void> {
    try {
      const path = `${sessionDir(sessionId)}recovery.json`;
      await writeAsStringAsync(path, JSON.stringify(session));
    } catch {
      // Best-effort — stash still works if manifest write fails
    }
  },

  /** Delete the recovery manifest after SecureStore write succeeds. */
  async deleteRecoveryManifest(sessionId: string): Promise<void> {
    try {
      const path = `${sessionDir(sessionId)}recovery.json`;
      await deleteAsync(path, { idempotent: true });
    } catch {
      // Best-effort cleanup
    }
  },

  /** Read a recovery manifest from a stash directory. Returns null if missing or corrupt. */
  async readRecoveryManifest(sessionId: string): Promise<StashedSession | null> {
    try {
      const path = `${sessionDir(sessionId)}recovery.json`;
      const info = await getInfoAsync(path);
      if (!info.exists) return null;
      const raw = await readAsStringAsync(path);
      const parsed = JSON.parse(raw) as StashedSession;
      if (!parsed.id || !parsed.slots) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  // Prevents concurrent cleanup from racing with stash/resume operations
  _cleanupInProgress: false,

  /**
   * Scan for orphaned stash directories (not in SecureStore) and recover them
   * if they have a recovery manifest. Directories without a manifest are deleted.
   * Returns any recovered sessions so the caller can add them to SecureStore.
   */
  async recoverOrCleanupOrphans(validSessionIds: string[]): Promise<StashedSession[]> {
    if (this._cleanupInProgress) return [];
    this._cleanupInProgress = true;
    try {
      if (!currentUserId) return [];
      const dir = userStashDir();
      const info = await getInfoAsync(dir);
      if (!info.exists) return [];

      const dirs = await readDirectoryAsync(dir);
      const validSet = new Set(validSessionIds);
      const orphanDirs = dirs.filter((d) => !validSet.has(d));
      const recovered: StashedSession[] = [];

      for (const orphanId of orphanDirs) {
        const manifest = await this.readRecoveryManifest(orphanId);
        if (manifest) {
          // Validate that audio files still exist before recovering
          const { validSlots } = await this.validateStashedAudio(manifest.slots);
          const hasAudio = validSlots.some((s) => s.segments.length > 0);
          if (hasAudio) {
            recovered.push({ ...manifest, slots: validSlots });
            continue;
          }
        }
        // No manifest or no valid audio — delete the orphaned directory
        await deleteAsync(`${dir}${orphanId}`, { idempotent: true }).catch(() => {});
      }

      return recovered;
    } catch {
      return [];
    } finally {
      this._cleanupInProgress = false;
    }
  },
};

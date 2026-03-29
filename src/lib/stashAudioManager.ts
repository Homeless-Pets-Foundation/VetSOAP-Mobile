import {
  documentDirectory,
  getInfoAsync,
  copyAsync,
  deleteAsync,
  makeDirectoryAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy';
import type { PatientSlot } from '../types/multiPatient';
import type { StashedSlot } from '../types/stash';

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
          } else {
            // Copy failed — keep original, skip this segment from stash
            stashedSegments.push({ uri: segment.uri, duration: segment.duration });
          }
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
   * Delete the entire stash base directory (all users).
   * Only used during legacy cleanup migration.
   */
  async deleteAllStashedAudioGlobal(): Promise<void> {
    try {
      const info = await getInfoAsync(BASE_STASH_DIR);
      if (info.exists) {
        await deleteAsync(BASE_STASH_DIR, { idempotent: true });
      }
    } catch {
      // Best-effort cleanup
    }
  },

  // Prevents concurrent cleanup from racing with stash/resume operations
  _cleanupInProgress: false,

  async cleanupOrphanedStashDirs(validSessionIds: string[]): Promise<void> {
    if (this._cleanupInProgress) return;
    this._cleanupInProgress = true;
    try {
      if (!currentUserId) return;
      const dir = userStashDir();
      const info = await getInfoAsync(dir);
      if (!info.exists) return;

      const dirs = await readDirectoryAsync(dir);
      const validSet = new Set(validSessionIds);

      await Promise.all(
        dirs
          .filter((d) => !validSet.has(d))
          .map((d) =>
            deleteAsync(`${dir}${d}`, { idempotent: true }).catch(() => {})
          )
      );
    } catch {
      // Best-effort cleanup
    } finally {
      this._cleanupInProgress = false;
    }
  },
};

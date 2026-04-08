import { File as ExpoFile, Directory, Paths } from 'expo-file-system';
import {
  fileExists,
  directoryExists,
  safeDeleteFile,
  safeDeleteDirectory,
  ensureDirectory,
} from './fileOps';
import type { PatientSlot } from '../types/multiPatient';
import type { StashedSlot, StashedSession } from '../types/stash';

const BASE_STASH_DIR = `${Paths.document.uri}stashed-audio/`;

/** Current user ID — set by AuthProvider to scope audio files per-user. */
let currentUserId: string | null = null;

function userStashDirForUser(userId: string): string {
  return `${BASE_STASH_DIR}${userId}/`;
}

/** Validate sessionId to prevent path traversal attacks. */
function validateSessionId(sessionId: string): void {
  if (!sessionId || /[\/\\.]/.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
}

function sessionDirForUser(userId: string, sessionId: string): string {
  validateSessionId(sessionId);
  return `${userStashDirForUser(userId)}${sessionId}/`;
}

export const stashAudioManager = {
  /** Set the current user ID. Must be called before any stash operations. */
  setUserId(userId: string | null): void {
    currentUserId = userId;
  },

  /** Read the currently scoped user ID. Used to guard async recovery flows. */
  getUserId(): string | null {
    return currentUserId;
  },

  /**
   * Move audio segment files from cacheDirectory to persistent stash directory.
   * Uses copy-only semantics until stash metadata is durably committed.
   * Callers delete the originals only after SecureStore persistence succeeds.
   * Returns StashedSlot[] with updated URIs pointing to documentDirectory.
   */
  async moveSegmentsToStashDir(
    sessionId: string,
    slots: PatientSlot[]
  ): Promise<StashedSlot[]> {
    const userId = currentUserId;
    if (!userId) throw new Error('Stash audio manager: no user ID set');

    const dir = sessionDirForUser(userId, sessionId);
    try {
      ensureDirectory(dir);

      const stashedSlots: StashedSlot[] = [];
      let segmentIndex = 0;

      for (const slot of slots) {
        const stashedSegments: { uri: string; duration: number }[] = [];

        for (const segment of slot.segments) {
          if (!fileExists(segment.uri)) continue;

          const destUri = `${dir}segment-${segmentIndex}.m4a`;
          try {
            new ExpoFile(segment.uri).copy(new ExpoFile(destUri));
          } catch {
            segmentIndex++;
            continue;
          }

          // Verify copy succeeded before exposing the new URI.
          if (fileExists(destUri)) {
            stashedSegments.push({ uri: destUri, duration: segment.duration });
          }
          // If copy failed, skip this segment entirely. The caller still has the
          // original cache URI available in the active session until commit.
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
      safeDeleteDirectory(dir);
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
        if (fileExists(segment.uri)) {
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
    const userId = currentUserId;
    if (!userId) return;

    try {
      const dir = sessionDirForUser(userId, sessionId);
      safeDeleteDirectory(dir);
    } catch {
      // Best-effort cleanup
    }
  },

  /** Delete all stashed audio for the current user. */
  async deleteAllStashedAudio(): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      const dir = userStashDirForUser(userId);
      safeDeleteDirectory(dir);
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
      if (!directoryExists(BASE_STASH_DIR)) return;
      const entries = new Directory(BASE_STASH_DIR).list();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const entry of entries) {
        if (!uuidPattern.test(entry.name)) {
          safeDeleteDirectory(entry.uri);
        }
      }
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
    const userId = currentUserId;
    if (!userId) return;

    try {
      const path = `${sessionDirForUser(userId, sessionId)}recovery.json`;
      new ExpoFile(path).write(JSON.stringify(session));
    } catch {
      // Best-effort — stash still works if manifest write fails
    }
  },

  /** Delete the recovery manifest after SecureStore write succeeds. */
  async deleteRecoveryManifest(sessionId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      const path = `${sessionDirForUser(userId, sessionId)}recovery.json`;
      safeDeleteFile(path);
    } catch {
      // Best-effort cleanup
    }
  },

  /** Read a recovery manifest from a stash directory. Returns null if missing or corrupt. */
  async readRecoveryManifest(sessionId: string, scopedUserId?: string): Promise<StashedSession | null> {
    const userId = scopedUserId ?? currentUserId;
    if (!userId) return null;

    try {
      const path = `${sessionDirForUser(userId, sessionId)}recovery.json`;
      if (!fileExists(path)) return null;
      const raw = await new ExpoFile(path).text();
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
    const userId = currentUserId;
    try {
      if (!userId) return [];
      const dir = userStashDirForUser(userId);
      if (!directoryExists(dir)) return [];

      const dirEntries = new Directory(dir).list();
      const validSet = new Set(validSessionIds);
      const orphanDirs = dirEntries.filter((d) => !validSet.has(d.name));
      const recovered: StashedSession[] = [];

      for (const orphan of orphanDirs) {
        const manifest = await this.readRecoveryManifest(orphan.name, userId);
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
        safeDeleteDirectory(orphan.uri);
      }

      return recovered;
    } catch {
      return [];
    } finally {
      this._cleanupInProgress = false;
    }
  },
};

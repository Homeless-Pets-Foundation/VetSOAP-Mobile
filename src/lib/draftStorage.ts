import * as SecureStore from 'expo-secure-store';
import { File as ExpoFile, Paths } from 'expo-file-system';
import {
  fileExists,
  safeDeleteDirectory,
  ensureDirectory,
} from './fileOps';
import type { PatientSlot } from '../types/multiPatient';
import type { CreateRecording } from '../types/index';

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const BASE_DRAFTS_DIR = `${Paths.document.uri}drafts/`;

interface DraftMetadata {
  slotId: string;
  savedAt: string;
  formData: CreateRecording;
  segments: { uri: string; duration: number }[];
  audioDuration: number;
  serverDraftId: string | null;
  pendingSync: boolean;
}

/** Current user ID — set by AuthProvider to scope draft data per-user. */
let currentUserId: string | null = null;

function draftIndexKeyForUser(userId: string): string {
  return `captivet_drafts_index_${userId}`;
}

function draftMetadataKeyForUser(userId: string, slotId: string): string {
  return `captivet_draft_${userId}_${slotId}`;
}

function userDraftDirForUser(userId: string): string {
  return `${BASE_DRAFTS_DIR}${userId}/`;
}

function slotDraftDirForUser(userId: string, slotId: string): string {
  validateSlotId(slotId);
  return `${userDraftDirForUser(userId)}${slotId}/`;
}

/** Validate slotId to prevent path traversal attacks. */
function validateSlotId(slotId: string): void {
  if (!slotId || /[\/\\.]/.test(slotId)) {
    throw new Error('Invalid slot ID');
  }
}

/** Read the draft index for the current user. */
async function readDraftIndex(): Promise<string[]> {
  const userId = currentUserId;
  if (!userId) return [];

  try {
    const raw = await SecureStore.getItemAsync(draftIndexKeyForUser(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write the draft index for the current user. */
async function writeDraftIndex(slotIds: string[]): Promise<void> {
  const userId = currentUserId;
  if (!userId) return;

  try {
    await SecureStore.setItemAsync(
      draftIndexKeyForUser(userId),
      JSON.stringify(slotIds),
      STORE_OPTIONS
    );
  } catch {
    // Best-effort
  }
}

/**
 * Draft storage module for persisting audio drafts locally.
 *
 * Uses SecureStore for metadata (per-slot) and documentDirectory for audio files.
 * All data is scoped by user ID to prevent cross-user leakage on shared tablets.
 */
export const draftStorage = {
  /** Set the current user ID. Must be called before any draft operations. */
  setUserId(userId: string | null): void {
    currentUserId = userId;
  },

  /** Read the currently scoped user ID. */
  getUserId(): string | null {
    return currentUserId;
  },

  /**
   * Save a draft from a patient slot.
   * Copies all audio segments to documentDirectory and stores metadata in SecureStore.
   * Returns the slotId for reference.
   */
  async saveDraft(slot: PatientSlot): Promise<string> {
    const userId = currentUserId;
    if (!userId) throw new Error('Draft storage: no user ID set');

    validateSlotId(slot.id);

    const dir = slotDraftDirForUser(userId, slot.id);
    try {
      ensureDirectory(dir);

      // Copy all segments to draft directory
      const draftSegments: { uri: string; duration: number }[] = [];
      for (let i = 0; i < slot.segments.length; i++) {
        const segment = slot.segments[i];
        if (!fileExists(segment.uri)) continue;

        const destUri = `${dir}seg_${i}.m4a`;
        try {
          new ExpoFile(segment.uri).copy(new ExpoFile(destUri));
          if (fileExists(destUri)) {
            draftSegments.push({ uri: destUri, duration: segment.duration });
          }
        } catch {
          // Skip segments that fail to copy
          continue;
        }
      }

      // Build and store metadata
      const metadata: DraftMetadata = {
        slotId: slot.id,
        savedAt: new Date().toISOString(),
        formData: slot.formData,
        segments: draftSegments,
        audioDuration: draftSegments.reduce((sum, s) => sum + s.duration, 0),
        serverDraftId: null,
        pendingSync: true,
      };

      const metadataKey = draftMetadataKeyForUser(userId, slot.id);
      await SecureStore.setItemAsync(
        metadataKey,
        JSON.stringify(metadata),
        STORE_OPTIONS
      );

      // Update index
      const index = await readDraftIndex();
      if (!index.includes(slot.id)) {
        index.push(slot.id);
        await writeDraftIndex(index);
      }

      return slot.id;
    } catch (error) {
      // Clean up partially-copied files on failure
      safeDeleteDirectory(dir);
      throw error;
    }
  },

  /**
   * Update the server draft ID for an existing draft.
   * Also marks the draft as synced (pendingSync = false).
   */
  async updateServerDraftId(slotId: string, serverId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      const metadataKey = draftMetadataKeyForUser(userId, slotId);
      const raw = await SecureStore.getItemAsync(metadataKey);
      if (!raw) return;

      const metadata: DraftMetadata = JSON.parse(raw);
      metadata.serverDraftId = serverId;
      metadata.pendingSync = false;

      await SecureStore.setItemAsync(metadataKey, JSON.stringify(metadata), STORE_OPTIONS);
    } catch {
      // Best-effort
    }
  },

  /**
   * Retrieve draft metadata for a specific slot.
   * Returns null if the draft doesn't exist.
   */
  async getDraft(slotId: string): Promise<DraftMetadata | null> {
    const userId = currentUserId;
    if (!userId) return null;

    try {
      const raw = await SecureStore.getItemAsync(draftMetadataKeyForUser(userId, slotId));
      if (!raw) return null;
      return JSON.parse(raw) as DraftMetadata;
    } catch {
      return null;
    }
  },

  /**
   * List all drafts for the current user.
   * Reads the draft index and retrieves metadata for each draft.
   */
  async listDrafts(): Promise<DraftMetadata[]> {
    const userId = currentUserId;
    if (!userId) return [];

    try {
      const slotIds = await readDraftIndex();
      const drafts: DraftMetadata[] = [];

      for (const slotId of slotIds) {
        const draft = await this.getDraft(slotId);
        if (draft) {
          drafts.push(draft);
        }
      }

      return drafts;
    } catch {
      return [];
    }
  },

  /**
   * Delete a draft by slot ID.
   * Deletes the audio directory and metadata from SecureStore.
   */
  async deleteDraft(slotId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      // Delete audio directory
      const dir = slotDraftDirForUser(userId, slotId);
      safeDeleteDirectory(dir);

      // Delete metadata
      const metadataKey = draftMetadataKeyForUser(userId, slotId);
      try {
        await SecureStore.deleteItemAsync(metadataKey);
      } catch {
        // Ignore deletion errors
      }

      // Remove from index
      const index = await readDraftIndex();
      const filtered = index.filter((id) => id !== slotId);
      await writeDraftIndex(filtered);
    } catch {
      // Best-effort cleanup
    }
  },

  /**
   * Delete all drafts for the current user.
   */
  async clearAll(): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      const drafts = await this.listDrafts();

      // Delete each draft
      for (const draft of drafts) {
        await this.deleteDraft(draft.slotId);
      }

      // Delete index
      try {
        await SecureStore.deleteItemAsync(draftIndexKeyForUser(userId));
      } catch {
        // Ignore
      }
    } catch {
      // Best-effort cleanup
    }
  },

  /**
   * Sync all pending drafts to the server.
   * For each draft with pendingSync=true, calls createFn to create a server Recording.
   * Then updates the draft with the server ID and marks as synced.
   */
  async syncPending(
    userId: string,
    createFn: (formData: CreateRecording) => Promise<{ id: string }>
  ): Promise<void> {
    const previousUserId = currentUserId;
    try {
      currentUserId = userId;

      const drafts = await this.listDrafts();

      for (const draft of drafts) {
        if (!draft.pendingSync) continue;

        try {
          const result = await createFn(draft.formData);
          await this.updateServerDraftId(draft.slotId, result.id);
        } catch {
          // Best-effort — skip drafts that fail to sync
          continue;
        }
      }
    } finally {
      currentUserId = previousUserId;
    }
  },
};

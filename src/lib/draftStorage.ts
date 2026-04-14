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

// SecureStore uses EncryptedSharedPreferences on Android which has a ~2KB
// practical per-value limit. Long multi-segment drafts exceed this easily
// (~150 bytes per segment URI + duration), so we chunk the metadata JSON
// across multiple keys. Matches the chunk size used by stashStorage.
const DRAFT_CHUNK_SIZE = 1900;

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

function draftChunkPrefixForUser(userId: string, slotId: string): string {
  validateSlotId(slotId);
  return `captivet_draft_${userId}_${slotId}_chunk_`;
}

function draftMetaKeyForUser(userId: string, slotId: string): string {
  validateSlotId(slotId);
  return `captivet_draft_${userId}_${slotId}_meta`;
}

/**
 * Legacy single-key location for draft metadata (pre-chunking). Only ever
 * read so existing drafts on disk remain accessible after the upgrade;
 * writes always use the chunked layout.
 */
function legacyDraftMetadataKeyForUser(userId: string, slotId: string): string {
  validateSlotId(slotId);
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

/**
 * Write draft metadata as chunked SecureStore entries. Writes all chunks
 * first, then the meta key last — a crash mid-write leaves the meta key
 * either absent (read falls back to legacy) or pointing at the complete new
 * set of chunks. The legacy single-key entry is deleted after a successful
 * chunked write so getDraft doesn't return stale data.
 */
async function writeDraftChunks(
  userId: string,
  slotId: string,
  raw: string,
): Promise<void> {
  const prefix = draftChunkPrefixForUser(userId, slotId);
  const chunkCount = Math.max(1, Math.ceil(raw.length / DRAFT_CHUNK_SIZE));

  for (let i = 0; i < chunkCount; i++) {
    const chunk = raw.slice(i * DRAFT_CHUNK_SIZE, (i + 1) * DRAFT_CHUNK_SIZE);
    await SecureStore.setItemAsync(`${prefix}${i}`, chunk, STORE_OPTIONS);
  }
  await SecureStore.setItemAsync(
    draftMetaKeyForUser(userId, slotId),
    JSON.stringify({ chunks: chunkCount, version: 1 }),
    STORE_OPTIONS,
  );

  try {
    await SecureStore.deleteItemAsync(legacyDraftMetadataKeyForUser(userId, slotId));
  } catch {
    // Legacy cleanup is best-effort
  }
}

/**
 * Read draft metadata, trying the chunked layout first and falling back to
 * the legacy single-key layout for drafts written before chunking existed.
 * Returns null if either the meta key is missing a referenced chunk (torn
 * write) or the parsed JSON is not a valid DraftMetadata shape.
 */
async function readDraftChunks(
  userId: string,
  slotId: string,
): Promise<DraftMetadata | null> {
  try {
    const metaRaw = await SecureStore.getItemAsync(draftMetaKeyForUser(userId, slotId));
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as { chunks?: number };
      const count = meta.chunks;
      if (!Number.isInteger(count) || !count || count <= 0) return null;
      const prefix = draftChunkPrefixForUser(userId, slotId);
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const chunk = await SecureStore.getItemAsync(`${prefix}${i}`);
        if (chunk === null) return null;
        parts.push(chunk);
      }
      return JSON.parse(parts.join('')) as DraftMetadata;
    }
  } catch {
    return null;
  }

  try {
    const legacyRaw = await SecureStore.getItemAsync(
      legacyDraftMetadataKeyForUser(userId, slotId),
    );
    if (!legacyRaw) return null;
    return JSON.parse(legacyRaw) as DraftMetadata;
  } catch {
    return null;
  }
}

/**
 * Delete every SecureStore entry associated with a draft — chunked layout,
 * the meta key, and the legacy single-key entry. Best-effort on each op.
 */
async function deleteDraftChunks(userId: string, slotId: string): Promise<void> {
  try {
    const metaRaw = await SecureStore.getItemAsync(draftMetaKeyForUser(userId, slotId));
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as { chunks?: number };
      const count = meta.chunks;
      if (Number.isInteger(count) && count && count > 0) {
        const prefix = draftChunkPrefixForUser(userId, slotId);
        for (let i = 0; i < count; i++) {
          await SecureStore.deleteItemAsync(`${prefix}${i}`).catch(() => {});
        }
      }
    }
  } catch {
    // Best-effort cleanup
  }
  await SecureStore.deleteItemAsync(draftMetaKeyForUser(userId, slotId)).catch(() => {});
  await SecureStore.deleteItemAsync(
    legacyDraftMetadataKeyForUser(userId, slotId),
  ).catch(() => {});
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

      await writeDraftChunks(userId, slot.id, JSON.stringify(metadata));

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
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata) return;

      metadata.serverDraftId = serverId;
      metadata.pendingSync = false;

      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
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
      return await readDraftChunks(userId, slotId);
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

      // Delete metadata (chunked layout + legacy single key + meta key)
      await deleteDraftChunks(userId, slotId);

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
   * Sweep orphaned drafts whose local audio files have been deleted (e.g. by
   * an older client that stashed a session before stash preserved
   * serverDraftId, or by filesystem pressure). For each such draft we best-
   * effort delete the server row and the local metadata.
   *
   * Returns the number of drafts cleaned.
   */
  async cleanupOrphaned(
    deleteServerDraft: (serverDraftId: string) => Promise<void>
  ): Promise<number> {
    const userId = currentUserId;
    if (!userId) return 0;

    let cleaned = 0;
    try {
      const drafts = await this.listDrafts();
      for (const draft of drafts) {
        if (draft.segments.length === 0) continue;
        const anyMissing = draft.segments.some((s) => !fileExists(s.uri));
        if (!anyMissing) continue;

        if (draft.serverDraftId) {
          try {
            await deleteServerDraft(draft.serverDraftId);
          } catch {
            // Best-effort — server may already be gone, or offline. We still
            // clean up local metadata so the card disappears from the UI;
            // any still-existing server row becomes a server-side TTL problem.
          }
        }
        await this.deleteDraft(draft.slotId);
        cleaned++;
      }
    } catch {
      // Best-effort
    }
    return cleaned;
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

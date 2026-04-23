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

export interface DraftSegmentMetadata {
  uri: string;
  duration: number;
  peakMetering?: number;
}

export interface DraftMetadata {
  slotId: string;
  savedAt: string;
  formData: CreateRecording;
  segments: DraftSegmentMetadata[];
  audioDuration: number;
  serverDraftId: string | null;
  pendingSync: boolean;
}

export type ServerDraftPresence = 'present' | 'missing' | 'unknown';

/** Current user ID — set by AuthProvider to scope draft data per-user. */
let currentUserId: string | null = null;

/**
 * Classify a draft-storage failure into a bounded reason. Lazy-loaded to
 * avoid a static import cycle and to stay safe if analytics isn't wired.
 */
function classifyDraftFailure(error: unknown): 'secure_store' | 'fs' | 'quota' | 'other' {
  const s = String(error ?? '').toLowerCase();
  if (s.includes('securestore') || s.includes('keystore') || s.includes('keychain')) return 'secure_store';
  if (s.includes('enospc') || s.includes('no space') || s.includes('quota')) return 'quota';
  if (s.includes('enoent') || s.includes('file') || s.includes('directory')) return 'fs';
  return 'other';
}

function emitDraftFailure(name: 'draft_save_failed' | 'stash_write_failed', error: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    trackEvent({ name, props: { reason: classifyDraftFailure(error) } });
  } catch {
    // swallow
  }
}

function emitDraftSyncRetryFailed(attemptNumber: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    trackEvent({ name: 'draft_sync_retry_failed', props: { attempt_number: attemptNumber } });
  } catch {
    // swallow
  }
}

function emitDraftOrphanSweep(found: number, deleted: number): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    trackEvent({ name: 'draft_orphan_sweep', props: { found, deleted } });
  } catch {
    // swallow
  }
}

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
      return normalizeDraftMetadata(JSON.parse(parts.join('')));
    }
  } catch {
    return null;
  }

  try {
    const legacyRaw = await SecureStore.getItemAsync(
      legacyDraftMetadataKeyForUser(userId, slotId),
    );
    if (!legacyRaw) return null;
    return normalizeDraftMetadata(JSON.parse(legacyRaw));
  } catch {
    return null;
  }
}

function normalizeDraftMetadata(raw: unknown): DraftMetadata | null {
  if (!raw || typeof raw !== 'object') return null;

  const parsed = raw as Partial<DraftMetadata> & { segments?: unknown };
  if (
    typeof parsed.slotId !== 'string' ||
    typeof parsed.savedAt !== 'string' ||
    !parsed.formData ||
    typeof parsed.formData !== 'object' ||
    !Array.isArray(parsed.segments) ||
    (typeof parsed.serverDraftId !== 'string' && parsed.serverDraftId !== null) ||
    typeof parsed.pendingSync !== 'boolean'
  ) {
    return null;
  }

  const segments: DraftSegmentMetadata[] = [];
  for (const segment of parsed.segments) {
    if (!segment || typeof segment !== 'object') continue;
    const parsedSegment = segment as Partial<DraftSegmentMetadata>;
    if (typeof parsedSegment.uri !== 'string' || typeof parsedSegment.duration !== 'number') {
      continue;
    }
    segments.push({
      uri: parsedSegment.uri,
      duration: parsedSegment.duration,
      peakMetering:
        typeof parsedSegment.peakMetering === 'number'
          ? parsedSegment.peakMetering
          : undefined,
    });
  }

  return {
    slotId: parsed.slotId,
    savedAt: parsed.savedAt,
    formData: parsed.formData as CreateRecording,
    segments,
    audioDuration:
      typeof parsed.audioDuration === 'number'
        ? parsed.audioDuration
        : segments.reduce((sum, segment) => sum + segment.duration, 0),
    serverDraftId: parsed.serverDraftId,
    pendingSync: parsed.pendingSync,
  };
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
      const draftSegments: DraftSegmentMetadata[] = [];
      for (let i = 0; i < slot.segments.length; i++) {
        const segment = slot.segments[i];
        if (!fileExists(segment.uri)) continue;

        const destUri = `${dir}seg_${i}.m4a`;
        try {
          new ExpoFile(segment.uri).copy(new ExpoFile(destUri));
          if (fileExists(destUri)) {
            draftSegments.push({
              uri: destUri,
              duration: segment.duration,
              peakMetering:
                typeof segment.peakMetering === 'number'
                  ? segment.peakMetering
                  : undefined,
            });
          }
        } catch {
          // Skip segments that fail to copy
          continue;
        }
      }

      // Preserve any existing serverDraftId + pendingSync state so re-saves
      // on the same slot (Finish → Continue → Finish, or a second autoSaveDraft
      // during a stop/continue cycle) do not zero out a server row that a
      // concurrent `syncPending()` would then fresh-create as a duplicate
      // draft. `updateServerDraftId` remains the authoritative writer for the
      // post-sync promotion to `pendingSync: false`.
      const existing = await readDraftChunks(userId, slot.id);

      const metadata: DraftMetadata = {
        slotId: slot.id,
        savedAt: new Date().toISOString(),
        formData: slot.formData,
        segments: draftSegments,
        audioDuration: draftSegments.reduce((sum, s) => sum + s.duration, 0),
        serverDraftId: existing?.serverDraftId ?? null,
        pendingSync: existing?.serverDraftId
          ? existing.pendingSync
          : true,
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
      emitDraftFailure('draft_save_failed', error);
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
   * Detach a local draft from a server draft row that no longer exists.
   * Keeps the local audio + metadata, but makes the draft local-only so it
   * won't silently resurrect on the server after a remote delete.
   */
  async clearServerDraftId(slotId: string): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata || !metadata.serverDraftId) return;

      metadata.serverDraftId = null;
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
    let found = 0;
    try {
      const drafts = await this.listDrafts();
      for (const draft of drafts) {
        if (draft.segments.length === 0) continue;
        const anyMissing = draft.segments.some((s) => !fileExists(s.uri));
        if (!anyMissing) continue;
        found++;

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
    if (found > 0 || cleaned > 0) {
      emitDraftOrphanSweep(found, cleaned);
    }
    return cleaned;
  },

  /**
   * Reconcile local drafts whose linked server draft row has been deleted on
   * another device. Missing rows are downgraded to local-only drafts so the
   * audio remains resumable on this device without auto-recreating a server
   * row behind the user's back.
   */
  async reconcileMissingServerDrafts(
    getServerDraftPresence: (serverDraftId: string) => Promise<ServerDraftPresence>
  ): Promise<number> {
    const userId = currentUserId;
    if (!userId) return 0;

    let reconciled = 0;
    try {
      const drafts = await this.listDrafts();
      for (const draft of drafts) {
        if (!draft.serverDraftId || draft.pendingSync) continue;

        let presence: ServerDraftPresence = 'unknown';
        try {
          presence = await getServerDraftPresence(draft.serverDraftId);
        } catch {
          presence = 'unknown';
        }

        if (presence !== 'missing') continue;

        await this.clearServerDraftId(draft.slotId);
        reconciled++;
      }
    } catch {
      // Best-effort
    }

    return reconciled;
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

      let attempt = 0;
      for (const draft of drafts) {
        if (!draft.pendingSync) continue;
        attempt++;

        try {
          const result = await createFn(draft.formData);
          await this.updateServerDraftId(draft.slotId, result.id);
        } catch {
          // Best-effort — skip drafts that fail to sync, but emit a
          // telemetry event so we can see spikes in offline-to-server
          // reconciliation failures.
          emitDraftSyncRetryFailed(attempt);
          continue;
        }
      }
    } finally {
      // Only restore if no external setUserId() (e.g. sign-out) happened
      // while we were awaiting — otherwise we'd clobber the new binding and
      // leave this module scoped to the departed user (rules 10 + 17).
      if (currentUserId === userId) currentUserId = previousUserId;
    }
  },
};

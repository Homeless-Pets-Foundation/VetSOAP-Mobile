import * as SecureStore from 'expo-secure-store';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { copyAsync as legacyCopyAsync, moveAsync as legacyMoveAsync } from 'expo-file-system/legacy';
import {
  fileExists,
  safeDeleteFile,
  safeDeleteDirectory,
  ensureDirectory,
} from './fileOps';
import type { PatientSlot, AudioSegment, DurableSlotRef, PendingConfirm } from '../types/multiPatient';
import type { CreateRecording } from '../types/index';
import { isValidDurableId } from './durableAudio/paths';
import { durableTombstone } from './durableAudio/tombstone';
import { clonePendingConfirm } from './pendingConfirm';
import {
  effectiveUploadIdempotencyKey,
  isAudioChangeUploadIdempotencyKey,
  normalizeSupersededUploadKey,
  normalizeUploadIntentId,
  normalizeUploadKeyOverride,
} from './uploadIntent';
import { isPimsPatientIdExplicitlyCleared } from './pimsPatientIdIntent';

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

// SecureStore uses EncryptedSharedPreferences on Android which has a ~2KB
// practical per-value limit. Long multi-segment drafts exceed this easily
// (~150 bytes per segment URI + duration), so we chunk the metadata JSON
// across multiple keys. Matches the chunk size used by stashStorage.
const DRAFT_CHUNK_SIZE = 1900;

const BASE_DRAFTS_DIR = `${Paths.document.uri}drafts/`;
const DRAFT_NULLABLE_FORM_FIELDS = [
  'pimsPatientId',
  'clientName',
  'species',
  'breed',
  'appointmentType',
  'templateId',
] as const satisfies readonly (keyof CreateRecording)[];

export interface DraftSegmentMetadata {
  uri: string;
  duration: number;
  peakMetering?: number;
}

export interface DraftUploadRestartPending {
  expectedOldKey: string;
  replacementKey: string;
  previousPendingSync: boolean;
}

export interface DraftMetadata {
  slotId: string;
  uploadIntentId: string;
  uploadKeyOverride: string | null;
  supersededUploadKey: string | null;
  // Two-phase marker for durable restart. While present, ordinary background
  // draft creation is blocked. The native manifest is the durable commit point
  // and this marker lets a later load finish or roll back the SecureStore side.
  uploadRestartPending: DraftUploadRestartPending | null;
  savedAt: string;
  formData: CreateRecording;
  pimsPatientIdExplicitlyCleared: boolean;
  segments: DraftSegmentMetadata[];
  audioDuration: number;
  serverDraftId: string | null;
  pendingSync: boolean;
  // Persisted fail-closed bit: if formData was edited after serverDraftId was
  // assigned and draft metadata sync could not prove success, submit must send
  // metadata with confirm-upload even after app restart.
  draftMetadataDirty: boolean;
  pendingConfirm: PendingConfirm | null;
  // Durable AAC pointer for a finished durable draft. When set, the draft's
  // audio lives in audio.aac under the durable root (NOT copied into
  // drafts/{userId}/{slotId}/), so `segments` is empty. cleanupOrphaned /
  // draftHasLocalAudio / the "Not Submitted" loader must treat a valid
  // non-purged durable manifest as local audio even though segments is empty.
  durable?: DurableSlotRef | null;
}

export type ServerDraftPresence = 'present' | 'missing' | 'unknown';

/**
 * Only 'no_local_meta' means the just-created server row has no local anchor
 * and should be cleaned up by the caller. 'persist_failed' and 'no_user' must
 * NOT trigger deletion: the local draft may still exist, and durable drafts
 * re-promote the same server row via the deterministic `durable-${recordingId}`
 * idempotency key — deleting would orphan the local side instead.
 */
export type UpdateServerDraftIdResult =
  | 'updated'
  | 'no_local_meta'
  | 'restart_key_mismatch'
  | 'persist_failed'
  | 'no_user';

export interface DraftSyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /**
   * Server rows created by this sync whose local metadata vanished before the
   * anchor could persist ('no_local_meta'). draftStorage cannot call the API —
   * the caller (usePendingDraftSync) deletes these best-effort with reason
   * 'orphan_draft_cleanup'.
   */
  orphanedServerIds: string[];
}

export interface DraftSaveOptions {
  /**
   * Controlled upload restart must preserve one complete snapshot. Versioned
   * destination files keep the previous draft untouched until every source
   * segment has copied and the replacement metadata is ready to commit.
   */
  requireCompleteAudio?: boolean;
}

/** Current user ID — set by AuthProvider to scope draft data per-user. */
let currentUserId: string | null = null;
let userScopeVersion = 0;
const userIdListeners = new Set<(userId: string | null) => void>();
// Same-process coordination between background creation and an explicit
// controlled restart. Durable persistence handles process death; this set
// closes the in-memory race before either operation reaches the network/native
// commit point.
const pendingDraftSyncSlotIds = new Set<string>();

// In-memory cache for the chunked SecureStore sweep behind listDrafts —
// Home + Recordings re-list on every tab focus, and each list is 1 index
// read + (meta + N chunk) reads per draft. Single entry, keyed by userId:
// keying by user (rather than relying on setUserId invalidation alone) makes
// a wrong-user hit structurally impossible even while syncPending temporarily
// rebinds currentUserId without going through setUserId. Invalidated on every
// write; the version counter stops a slow in-flight read from caching
// pre-write data after a concurrent write already invalidated.
let draftsListCache: { userId: string; drafts: DraftMetadata[] } | null = null;
let draftsCacheVersion = 0;

function invalidateDraftsCache(): void {
  draftsListCache = null;
  draftsCacheVersion++;
}

// Clone on cache read/write so callers can never mutate cached entries.
function cloneDraftMetadata(d: DraftMetadata): DraftMetadata {
  return {
    ...d,
    formData: { ...d.formData },
    segments: d.segments.map((s) => ({ ...s })),
    pendingConfirm: clonePendingConfirm(d.pendingConfirm),
    uploadRestartPending: d.uploadRestartPending
      ? { ...d.uploadRestartPending }
      : null,
  };
}

function normalizeUploadRestartPending(raw: unknown): DraftUploadRestartPending | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<DraftUploadRestartPending>;
  const expectedOldKey = normalizeSupersededUploadKey(value.expectedOldKey);
  const replacementKey = normalizeUploadKeyOverride(value.replacementKey);
  if (
    !expectedOldKey ||
    !replacementKey ||
    expectedOldKey === replacementKey ||
    typeof value.previousPendingSync !== 'boolean'
  ) {
    return null;
  }
  return {
    expectedOldKey,
    replacementKey,
    previousPendingSync: value.previousPendingSync,
  };
}

function normalizeDraftFormDataForStorage(
  formData: CreateRecording,
  opts: { preserveClearedNullableFields: boolean },
): CreateRecording {
  if (!opts.preserveClearedNullableFields) return formData;

  const normalized = { ...formData } as CreateRecording & Record<string, unknown>;
  for (const key of DRAFT_NULLABLE_FORM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(formData, key) && formData[key] === undefined) {
      (normalized as Record<string, unknown>)[key] = null;
    }
  }
  return normalized;
}

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

// Sentry adapters. Lazy-loaded to mirror analytics: avoids static import cycle
// and stays safe when monitoring hasn't initialised yet (e.g. tests, early
// startup before `initMonitoring()` ran).
function draftBreadcrumb(
  message: string,
  data?: Record<string, string | number | boolean | null | undefined>,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { breadcrumb } = require('./monitoring') as typeof import('./monitoring');
    breadcrumb('draft', message, data);
  } catch {
    // swallow
  }
}

function draftCaptureWarning(
  message: string,
  extra?: Record<string, unknown>,
  level: 'warning' | 'info' = 'warning',
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureMessage } = require('./monitoring') as typeof import('./monitoring');
    captureMessage(message, level, {
      tags: { component: 'draft_storage' },
      extra,
    });
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

function emitDraftSegmentCopyFailed(
  expected: number,
  saved: number,
  ensureDirFailed: boolean,
  reasons: string[],
  priorValidSave: boolean,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('./analytics') as typeof import('./analytics');
    // Tally by reason so the payload stays bounded for high-segment-count
    // slots and groups cleanly in PostHog: "source_missing:2,copy_threw:1".
    const tally: Record<string, number> = {};
    for (const r of reasons) {
      tally[r] = (tally[r] ?? 0) + 1;
    }
    const tallyString = Object.entries(tally)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    trackEvent({
      name: 'draft_save_segment_copy_failed',
      props: {
        expected,
        saved,
        ensure_dir_failed: ensureDirFailed,
        reasons: tallyString,
        // True if the slot already had a complete-on-disk draft before this
        // save attempt — surfaces the data-loss risk where saveDraft's catch
        // wipes the previously valid dir on a fresh failure. If this fires
        // with prior_valid_save=true in PostHog, that's the signal to invest
        // in the temp-file/atomic-rename approach.
        prior_valid_save: priorValidSave,
      },
    });
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

function normalizeFileUriForCompare(uri: string): string {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

function sameFileUri(a: string, b: string): boolean {
  return a === b || normalizeFileUriForCompare(a) === normalizeFileUriForCompare(b);
}

function isConfinedFlatDraftFile(uri: string, draftDir: string): boolean {
  const normalizedUri = normalizeFileUriForCompare(uri);
  const normalizedDir = normalizeFileUriForCompare(draftDir);
  if (!normalizedUri.startsWith(normalizedDir)) return false;
  const relative = normalizedUri.slice(normalizedDir.length);
  return (
    relative.length > 0 &&
    !relative.includes('/') &&
    !relative.includes('\\') &&
    !relative.includes('..')
  );
}

function conciseCopyError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? 'unknown'))
    .replace(/file:\/\/\S+/g, '<path>')
    .slice(0, 120);
}

async function copyFileReplacing(sourceUri: string, destUri: string): Promise<boolean> {
  const tempUri = `${destUri}.tmp-${Date.now()}`;
  safeDeleteFile(tempUri);

  try {
    try {
      new ExpoFile(sourceUri).copy(new ExpoFile(tempUri));
    } catch (primaryCopyError) {
      try {
        await legacyCopyAsync({ from: sourceUri, to: tempUri });
      } catch (legacyCopyError) {
        throw new Error(
          `copy_failed:new_api=${conciseCopyError(primaryCopyError)};legacy=${conciseCopyError(legacyCopyError)}`
        );
      }
    }

    if (!fileExists(tempUri)) return false;
    safeDeleteFile(destUri);

    try {
      new ExpoFile(tempUri).move(new ExpoFile(destUri));
    } catch (primaryMoveError) {
      try {
        await legacyMoveAsync({ from: tempUri, to: destUri });
      } catch (legacyMoveError) {
        throw new Error(
          `move_failed:new_api=${conciseCopyError(primaryMoveError)};legacy=${conciseCopyError(legacyMoveError)}`
        );
      }
    }

    return fileExists(destUri);
  } finally {
    safeDeleteFile(tempUri);
  }
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

/**
 * Prove the draft's meta keys are genuinely absent — as opposed to present
 * but unreadable (Keystore/Direct Boot/low-storage failures, chunk loss,
 * JSON corruption). Only proven absence may classify as 'no_local_meta',
 * because callers delete the server row on that result; anything less
 * certain must take the non-deleting path.
 */
async function draftMetaKeysAbsent(userId: string, slotId: string): Promise<boolean> {
  try {
    const metaRaw = await SecureStore.getItemAsync(draftMetaKeyForUser(userId, slotId));
    if (metaRaw !== null) return false;
    const legacyRaw = await SecureStore.getItemAsync(
      legacyDraftMetadataKeyForUser(userId, slotId),
    );
    return legacyRaw === null;
  } catch {
    // Read failure — absence cannot be proven.
    return false;
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

  // Carry the durable pointer through the read path. Without this, a durable
  // draft loses its `durable.recordingId` on every round-trip — orphaning
  // audio.aac on Resume, double-surfacing it in recovery, and misclassifying it
  // in cleanupOrphaned/evictExpired/the vault. Validate the recordingId (Rule 15).
  const rawDurable = parsed.durable;
  let durable: DurableSlotRef | null | undefined;
  if (rawDurable === null) {
    durable = null;
  } else if (
    rawDurable &&
    typeof rawDurable === 'object' &&
    isValidDurableId((rawDurable as { recordingId?: unknown }).recordingId)
  ) {
    durable = rawDurable as DurableSlotRef;
  } else {
    durable = undefined;
  }

  return {
    slotId: parsed.slotId,
    uploadIntentId: normalizeUploadIntentId(parsed.uploadIntentId, parsed.slotId),
    uploadKeyOverride: normalizeUploadKeyOverride(parsed.uploadKeyOverride),
    supersededUploadKey: normalizeSupersededUploadKey(parsed.supersededUploadKey),
    uploadRestartPending: normalizeUploadRestartPending(parsed.uploadRestartPending),
    savedAt: parsed.savedAt,
    formData: parsed.formData as CreateRecording,
    pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
      (parsed.formData as CreateRecording).pimsPatientId,
      parsed.pimsPatientIdExplicitlyCleared,
    ),
    segments,
    audioDuration:
      typeof parsed.audioDuration === 'number'
        ? parsed.audioDuration
        : segments.reduce((sum, segment) => sum + segment.duration, 0),
    serverDraftId: parsed.serverDraftId,
    pendingSync: parsed.pendingSync,
    draftMetadataDirty: parsed.draftMetadataDirty === true,
    pendingConfirm: clonePendingConfirm(parsed.pendingConfirm),
    durable,
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

/** Read the draft index for a specific user without mutating module scope. */
async function readDraftIndexForUser(userId: string): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(draftIndexKeyForUser(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Read the draft index for the current user. */
async function readDraftIndex(): Promise<string[]> {
  const userId = currentUserId;
  if (!userId) return [];
  return readDraftIndexForUser(userId);
}

/** Write the draft index for an explicit user without consulting mutable scope. */
async function writeDraftIndexForUser(userId: string, slotIds: string[]): Promise<void> {
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

/** Write the draft index for the current user. */
async function writeDraftIndex(slotIds: string[]): Promise<void> {
  const userId = currentUserId;
  if (!userId) return;
  return writeDraftIndexForUser(userId, slotIds);
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
    const changed = currentUserId !== userId;
    currentUserId = userId;
    invalidateDraftsCache();
    if (changed) {
      userScopeVersion++;
      for (const listener of userIdListeners) {
        try {
          listener(userId);
        } catch {
          // A background observer must never break the auth scope update.
        }
      }
    }
  },

  /** Read the currently scoped user ID. */
  getUserId(): string | null {
    return currentUserId;
  },

  /** Monotonic token invalidating same-user cache reuse across re-auth. */
  getUserScopeVersion(): number {
    return userScopeVersion;
  },

  /** Observe auth-scope changes so in-flight background reads can abort. */
  subscribeUserIdChanges(listener: (userId: string | null) => void): () => void {
    userIdListeners.add(listener);
    return () => userIdListeners.delete(listener);
  },

  /**
   * Save a draft from a patient slot.
   * Copies all audio segments to documentDirectory and stores metadata in
   * SecureStore. Returns the slotId plus the promoted segment array — the
   * caller MUST dispatch PROMOTE_SEGMENTS_TO_DRAFT with these URIs so session
   * state stops pointing at recorder-temp paths that the OS can reap. See
   * docs/2026-05-17-promote-segments-to-draft.md (Sentry REACT-NATIVE-8).
   */
  async saveDraft(
    slot: PatientSlot,
    options: DraftSaveOptions = {},
  ): Promise<{ draftSlotId: string; promotedSegments: AudioSegment[] }> {
    const userId = currentUserId;
    if (!userId) throw new Error('Draft storage: no user ID set');

    validateSlotId(slot.id);

    // Durable AAC draft: the audio lives in audio.aac under the durable root, so
    // we DO NOT copy segment files into drafts/{userId}/{slotId}/ (that would
    // double-store the recording). We persist metadata-only with an empty
    // `segments` and the durable pointer. draftHasLocalAudio / cleanupOrphaned
    // treat a valid non-purged durable manifest as local audio so this is not
    // mistaken for an orphan. (This is the FINISHED-draft path; active durable
    // recordings use durableActiveStore, never saveDraft.)
    if (slot.durable) {
      const existingDurable = await readDraftChunks(userId, slot.id);
      const durableUploadIntentId = normalizeUploadIntentId(
        slot.uploadIntentId ?? existingDurable?.uploadIntentId,
        slot.id,
      );
      const durableIntentRotated =
        !!existingDurable &&
        (durableUploadIntentId !== normalizeUploadIntentId(existingDurable.uploadIntentId, slot.id) ||
          normalizeUploadKeyOverride(slot.uploadKeyOverride) !== existingDurable.uploadKeyOverride);
      // Preserve the server draft/recording anchor across this save. On crash
      // recovery a manifest can carry a serverRecordingId (set pre-death) with NO
      // prior local draft, so `existingDurable` is null — fall back to the slot's
      // serverDraftId so the death-surviving anchor is not dropped (otherwise the
      // next Submit fresh-creates a duplicate server recording instead of
      // promoting the already-created draft). Prefer an existing local anchor.
      // A changed upload intent means audio changed after R2 accepted the old
      // bytes. A null slot anchor must clear, not resurrect, the stale disk ID.
      const resolvedServerDraftId = durableIntentRotated
        ? (slot.serverDraftId ?? null)
        : (existingDurable?.serverDraftId ?? slot.serverDraftId ?? null);
      const durableDraftMetadataDirty =
        !!resolvedServerDraftId &&
        (slot.draftMetadataDirty ||
          (!durableIntentRotated &&
            existingDurable?.serverDraftId === resolvedServerDraftId &&
            existingDurable.draftMetadataDirty));
      const uploadKeyOverride = normalizeUploadKeyOverride(slot.uploadKeyOverride);
      const supersededUploadKey = normalizeSupersededUploadKey(slot.supersededUploadKey);
      const uploadRestartPending = supersededUploadKey
        ? null
        : (existingDurable?.uploadRestartPending ?? null);
      const durableMetadata: DraftMetadata = {
        slotId: slot.id,
        uploadIntentId: durableUploadIntentId,
        uploadKeyOverride,
        supersededUploadKey,
        uploadRestartPending,
        savedAt: new Date().toISOString(),
        formData: normalizeDraftFormDataForStorage(slot.formData, {
          preserveClearedNullableFields: durableDraftMetadataDirty,
        }),
        pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
          slot.formData.pimsPatientId,
          slot.pimsPatientIdExplicitlyCleared,
        ),
        segments: [],
        durable: slot.durable,
        audioDuration: slot.durable.durationMs / 1000,
        serverDraftId: resolvedServerDraftId,
        draftMetadataDirty: durableDraftMetadataDirty,
        // Null is an intentional invalidation after continue/edit. Never
        // resurrect an older on-disk hint whose manifest no longer matches.
        pendingConfirm: clonePendingConfirm(slot.pendingConfirm),
        // An existing local draft keeps its own pendingSync. A recovery-supplied
        // anchor means the server row already exists (no create needed) → synced;
        // no anchor at all means we still owe a server-draft create → pending.
        pendingSync: supersededUploadKey || uploadRestartPending
          ? false
          : !durableIntentRotated && existingDurable?.serverDraftId
            ? existingDurable.pendingSync
            : !resolvedServerDraftId,
      };
      await writeDraftChunks(userId, slot.id, JSON.stringify(durableMetadata));
      const index = await readDraftIndex();
      if (!index.includes(slot.id)) {
        index.push(slot.id);
        await writeDraftIndex(index);
      }
      invalidateDraftsCache();
      draftBreadcrumb('saved', {
        slot_id: slot.id,
        segment_count: 0,
        expected_segments: 0,
        has_server_draft: !!durableMetadata.serverDraftId,
        pending_sync: durableMetadata.pendingSync,
      });
      // No segment files to promote — the durable recordingId is the pointer.
      return { draftSlotId: slot.id, promotedSegments: [] };
    }

    const dir = slotDraftDirForUser(userId, slot.id);
    const requireCompleteAudio = options.requireCompleteAudio === true;
    const completeSaveVersion = requireCompleteAudio
      ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      : null;
    const completeSaveFiles: string[] = [];
    let completeSaveMetadataCommitted = false;

    // Read existing metadata up front so we can (a) preserve serverDraftId
    // through this re-save and (b) tag copy-failure telemetry with whether
    // the slot already had valid audio on disk that this catch path could
    // potentially wipe. The fileExists check must run BEFORE any copy
    // attempt — once copies start, dest paths may get partially overwritten.
    const existing = await readDraftChunks(userId, slot.id);
    const pendingConfirm = clonePendingConfirm(slot.pendingConfirm);
    const priorValidSave =
      !!existing &&
      existing.segments.length > 0 &&
      existing.segments.every((s) => fileExists(s.uri));

    try {
      // ensureDirectory now returns whether the dir actually exists post-call.
      // If creation failed (low storage, EACCES, expo-file-system race), the
      // copy loop below would all fail silently and we'd write empty-segments
      // metadata — exactly the orphan-draft bug we are guarding against. Fail
      // loudly so autoSaveDraft can skip the server-sync phase.
      const dirReady = ensureDirectory(dir);
      if (!dirReady) {
        emitDraftSegmentCopyFailed(slot.segments.length, 0, true, [], priorValidSave);
        if (!pendingConfirm) {
          throw new Error(`Draft storage: failed to create draft directory (${slot.segments.length} segments)`);
        }
      }

      // Capture free disk once so it lands in the eventual all-failed throw's
      // message. Low storage is one of the candidate triggers for `copy_threw`
      // (REACT-NATIVE-8); having freeDiskMb in the Sentry payload lets us
      // distinguish ENOSPC from "source URI stale" without a device repro.
      let freeDiskMb: number | null;
      try {
        freeDiskMb = Math.round(Paths.availableDiskSpace / (1024 * 1024));
      } catch {
        freeDiskMb = null;
      }

      // Copy all segments to draft directory. We capture per-segment outcomes
      // so partial / total copy failures surface in PostHog instead of being
      // silently absorbed into an empty draft entry.
      const draftSegments: DraftSegmentMetadata[] = [];
      const failureReasons: string[] = [];
      if (dirReady) {
        for (let i = 0; i < slot.segments.length; i++) {
          const segment = slot.segments[i];
          if (!fileExists(segment.uri)) {
            failureReasons.push('source_missing');
            continue;
          }

          const destUri = completeSaveVersion
            ? `${dir}restart_${completeSaveVersion}_${i}.m4a`
            : `${dir}seg_${i}.m4a`;
          try {
            if (sameFileUri(segment.uri, destUri)) {
              draftSegments.push({
                uri: destUri,
                duration: segment.duration,
                peakMetering:
                  typeof segment.peakMetering === 'number'
                    ? segment.peakMetering
                    : undefined,
              });
              continue;
            }
            if (!(await copyFileReplacing(segment.uri, destUri))) {
              failureReasons.push('dest_missing_after_copy');
              continue;
            }
          } catch (err) {
            // Pin the underlying error into the reason tag so the next RN-8
            // event tells us which errno (ENOSPC / EPERM / …) is firing.
            // Scrub `file://` paths defensively — same pattern as
            // src/api/telemetry.ts:reportClientError.
            const raw = err instanceof Error ? err.message : String(err);
            const short = raw.replace(/file:\/\/\S+/g, '<path>').slice(0, 80);
            failureReasons.push(`copy_threw:${short}`);
            continue;
          }

          if (!fileExists(destUri)) {
            failureReasons.push('dest_missing_after_copy');
            continue;
          }

          if (requireCompleteAudio) completeSaveFiles.push(destUri);
          draftSegments.push({
            uri: destUri,
            duration: segment.duration,
            peakMetering:
              typeof segment.peakMetering === 'number'
                ? segment.peakMetering
                : undefined,
          });
        }
      }

      // Emit telemetry whenever any segment failed to copy — even on partial
      // success — so the rate of silent copy failures is visible.
      if (failureReasons.length > 0) {
        emitDraftSegmentCopyFailed(
          slot.segments.length,
          draftSegments.length,
          false,
          failureReasons,
          priorValidSave,
        );
      }

      // A controlled restart must never publish a partial replacement. Its
      // versioned files do not overwrite the previous draft, so removing the
      // incomplete version here leaves the last complete metadata+audio
      // snapshot recoverable after process death.
      if (
        requireCompleteAudio &&
        draftSegments.length !== slot.segments.length
      ) {
        completeSaveFiles.forEach((uri) => safeDeleteFile(uri));
        throw new Error(
          `Draft storage: complete save copied ${draftSegments.length} of ${slot.segments.length} segments`,
        );
      }

      // Refuse to persist a metadata row with zero usable segments when the
      // input had segments. The autoSaveDraft caller catches this and skips
      // the Phase 2 server-sync, preventing the "Not on this device" orphan.
      if (slot.segments.length > 0 && draftSegments.length === 0 && !pendingConfirm) {
        throw new Error(
          `Draft storage: all ${slot.segments.length} segment copies failed (${failureReasons.join(',')}) freeDiskMb=${freeDiskMb}`,
        );
      }

      // Preserve any existing serverDraftId + pendingSync state so re-saves
      // on the same slot (Finish → Continue → Finish, or a second autoSaveDraft
      // during a stop/continue cycle) do not zero out a server row that a
      // concurrent `syncPending()` would then fresh-create as a duplicate
      // draft. `existing` is read at the top of saveDraft so we don't make
      // a second SecureStore round-trip here. `updateServerDraftId` remains
      // the authoritative writer for the post-sync promotion to
      // `pendingSync: false`.
      const uploadIntentId = normalizeUploadIntentId(
        slot.uploadIntentId ?? existing?.uploadIntentId,
        slot.id,
      );
      const uploadIntentRotated =
        !!existing &&
        (uploadIntentId !== normalizeUploadIntentId(existing.uploadIntentId, slot.id) ||
          normalizeUploadKeyOverride(slot.uploadKeyOverride) !== existing.uploadKeyOverride);
      const resolvedServerDraftId = uploadIntentRotated
        ? (slot.serverDraftId ?? null)
        : (existing?.serverDraftId ?? slot.serverDraftId ?? null);
      const draftMetadataDirty =
        !!resolvedServerDraftId &&
        (slot.draftMetadataDirty || (!uploadIntentRotated && (existing?.draftMetadataDirty ?? false)));
      const uploadKeyOverride = normalizeUploadKeyOverride(slot.uploadKeyOverride);
      const supersededUploadKey = normalizeSupersededUploadKey(slot.supersededUploadKey);
      const uploadRestartPending = supersededUploadKey
        ? null
        : (existing?.uploadRestartPending ?? null);
      const metadata: DraftMetadata = {
        slotId: slot.id,
        uploadIntentId,
        uploadKeyOverride,
        supersededUploadKey,
        uploadRestartPending,
        savedAt: new Date().toISOString(),
        formData: normalizeDraftFormDataForStorage(slot.formData, {
          preserveClearedNullableFields: draftMetadataDirty,
        }),
        pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
          slot.formData.pimsPatientId,
          slot.pimsPatientIdExplicitlyCleared,
        ),
        segments: draftSegments,
        audioDuration: draftSegments.length > 0
          ? draftSegments.reduce((sum, s) => sum + s.duration, 0)
          : slot.audioDuration,
        serverDraftId: resolvedServerDraftId,
        draftMetadataDirty,
        pendingConfirm,
        pendingSync: supersededUploadKey || uploadRestartPending
          ? false
          : resolvedServerDraftId
            ? (uploadIntentRotated ? false : (existing?.pendingSync ?? false))
            : true,
      };

      await writeDraftChunks(userId, slot.id, JSON.stringify(metadata));
      completeSaveMetadataCommitted = true;

      // Metadata is now the commit point. Remove only files from the previous
      // authoritative snapshot that are proven to be flat children of this
      // user/slot directory; the new snapshot remains recoverable even if the
      // later best-effort index write fails.
      if (requireCompleteAudio && existing) {
        for (const prior of existing.segments) {
          if (
            !draftSegments.some((segment) => sameFileUri(segment.uri, prior.uri)) &&
            isConfinedFlatDraftFile(prior.uri, dir)
          ) {
            safeDeleteFile(prior.uri);
          }
        }
      }

      // Update index
      const index = await readDraftIndex();
      if (!index.includes(slot.id)) {
        index.push(slot.id);
        await writeDraftIndex(index);
      }

      // Invalidate AFTER the last write — invalidating earlier would let a
      // concurrent listDrafts repopulate the cache from pre-index-write state.
      invalidateDraftsCache();

      draftBreadcrumb('saved', {
        slot_id: slot.id,
        segment_count: draftSegments.length,
        expected_segments: slot.segments.length,
        has_server_draft: !!metadata.serverDraftId,
        pending_sync: metadata.pendingSync,
      });

      const promotedSegments: AudioSegment[] = draftSegments.map((s) => ({
        uri: s.uri,
        duration: s.duration,
        peakMetering: s.peakMetering,
      }));

      return { draftSlotId: slot.id, promotedSegments };
    } catch (error) {
      if (requireCompleteAudio && !completeSaveMetadataCommitted) {
        completeSaveFiles.forEach((uri) => safeDeleteFile(uri));
      }
      // Preserve audio from any pre-existing complete-on-disk draft. The catch
      // used to wipe `dir` unconditionally, which destroyed prior successful
      // saves when a re-save failed — typical when slot.segments[i].uri points
      // at recorder temp files that Android cache cleanup, an OS update, or an
      // FFmpeg-split sweep has since purged. `priorValidSave` is computed at
      // line 378 for exactly this guard; the previous code only used it for
      // telemetry (`prior_valid_save` PostHog property).
      if (!priorValidSave) {
        draftBreadcrumb('wiping_dir_on_save_fail', {
          slot_id: slot.id,
          segments_in: slot.segments.length,
        });
        safeDeleteDirectory(dir);
      }
      invalidateDraftsCache();
      emitDraftFailure('draft_save_failed', error);
      throw error;
    }
  },

  /**
   * Phase 1 of a durable upload restart. Preserve the old server proof but
   * disable background sync before mutating the native manifest.
   */
  async beginUploadAttemptReset(
    slotId: string,
    expectedOldKey: string,
    replacementKey: string,
  ): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const normalizedReplacement = normalizeUploadKeyOverride(replacementKey);
    const normalizedOld = normalizeSupersededUploadKey(expectedOldKey);
    if (!normalizedReplacement || !normalizedOld || normalizedReplacement === normalizedOld) {
      return false;
    }

    const metadata = await readDraftChunks(userId, slotId);
    if (!metadata) return false;
    if (pendingDraftSyncSlotIds.has(slotId)) return false;
    if (metadata.uploadRestartPending) {
      return metadata.uploadRestartPending.expectedOldKey === normalizedOld &&
        metadata.uploadRestartPending.replacementKey === normalizedReplacement;
    }
    const currentKey = effectiveUploadIdempotencyKey({
      uploadKeyOverride: metadata.uploadKeyOverride,
      supersededUploadKey: metadata.supersededUploadKey,
      durableRecordingId: metadata.durable?.recordingId,
      uploadIntentId: metadata.uploadIntentId,
      slotId,
    });
    if (currentKey !== normalizedOld) return false;

    metadata.uploadRestartPending = {
      expectedOldKey: normalizedOld,
      replacementKey: normalizedReplacement,
      previousPendingSync: metadata.pendingSync,
    };
    metadata.pendingSync = false;
    await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
    invalidateDraftsCache();
    return true;
  },

  /**
   * Phase 2 of a durable upload restart, after the native manifest commits the
   * replacement. Failure leaves the phase-1 marker blocking background sync.
   */
  async commitUploadAttemptReset(
    slotId: string,
    expectedOldKey: string,
    replacementKey: string,
  ): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const normalizedReplacement = normalizeUploadKeyOverride(replacementKey);
    const normalizedOld = normalizeSupersededUploadKey(expectedOldKey);
    if (!normalizedReplacement || !normalizedOld) return false;

    const metadata = await readDraftChunks(userId, slotId);
    const pending = metadata?.uploadRestartPending;
    if (
      !metadata ||
      !pending ||
      pending.expectedOldKey !== normalizedOld ||
      pending.replacementKey !== normalizedReplacement
    ) {
      return false;
    }

    metadata.uploadKeyOverride = normalizedReplacement;
    metadata.supersededUploadKey = isAudioChangeUploadIdempotencyKey(normalizedReplacement)
      ? null
      : normalizedOld;
    metadata.uploadRestartPending = null;
    metadata.serverDraftId = null;
    metadata.pendingConfirm = null;
    metadata.pendingSync = false;
    metadata.draftMetadataDirty = false;
    await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
    invalidateDraftsCache();
    return true;
  },

  /** Roll back phase 1 when the native compare-and-set did not commit. */
  async cancelUploadAttemptReset(
    slotId: string,
    expectedOldKey: string,
    replacementKey: string,
  ): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;
    const normalizedReplacement = normalizeUploadKeyOverride(replacementKey);
    const normalizedOld = normalizeSupersededUploadKey(expectedOldKey);
    if (!normalizedReplacement || !normalizedOld) return;

    const metadata = await readDraftChunks(userId, slotId);
    const pending = metadata?.uploadRestartPending;
    if (
      !metadata ||
      !pending ||
      pending.expectedOldKey !== normalizedOld ||
      pending.replacementKey !== normalizedReplacement
    ) {
      return;
    }
    metadata.uploadRestartPending = null;
    metadata.pendingSync = pending.previousPendingSync;
    await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
    invalidateDraftsCache();
  },

  /**
   * Repair a crash between the native manifest CAS and SecureStore phase 2.
   * The native manifest is authoritative for durable audio; any third state
   * remains blocked so the app cannot guess at a server identity.
   */
  async reconcileUploadAttemptReset(
    slotId: string,
    nativeUploadKeyOverride: unknown,
    nativeSupersededUploadKey: unknown,
  ): Promise<'none' | 'committed' | 'cancelled' | 'blocked'> {
    const userId = currentUserId;
    if (!userId) return 'blocked';
    const metadata = await readDraftChunks(userId, slotId);
    if (!metadata?.uploadRestartPending) return 'none';

    const pending = metadata.uploadRestartPending;
    const nativeOverride = normalizeUploadKeyOverride(nativeUploadKeyOverride);
    const nativeSuperseded = normalizeSupersededUploadKey(nativeSupersededUploadKey);
    const nativeCurrentKey = effectiveUploadIdempotencyKey({
      uploadKeyOverride: nativeOverride,
      supersededUploadKey: nativeSuperseded,
      durableRecordingId: metadata.durable?.recordingId,
      uploadIntentId: metadata.uploadIntentId,
      slotId,
    });

    const expectedNativeSuperseded = isAudioChangeUploadIdempotencyKey(
      pending.replacementKey,
    )
      ? null
      : pending.expectedOldKey;
    if (
      nativeCurrentKey === pending.replacementKey &&
      nativeSuperseded === expectedNativeSuperseded
    ) {
      metadata.uploadKeyOverride = pending.replacementKey;
      metadata.supersededUploadKey = expectedNativeSuperseded;
      metadata.uploadRestartPending = null;
      metadata.serverDraftId = null;
      metadata.pendingConfirm = null;
      metadata.pendingSync = false;
      metadata.draftMetadataDirty = false;
      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
      return 'committed';
    }

    if (nativeCurrentKey === pending.expectedOldKey) {
      metadata.uploadRestartPending = null;
      metadata.pendingSync = pending.previousPendingSync;
      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
      return 'cancelled';
    }

    return 'blocked';
  },

  /**
   * Atomically detach local metadata from a conflicted server intent while
   * preserving every local audio pointer. A false result means another writer
   * changed the intent and the caller must inspect again instead of submitting.
   */
  async resetUploadAttempt(
    slotId: string,
    expectedOldKey: string,
    replacementKey: string,
  ): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;
    const normalizedReplacement = normalizeUploadKeyOverride(replacementKey);
    const normalizedOld = normalizeSupersededUploadKey(expectedOldKey);
    if (!normalizedReplacement || !normalizedOld || normalizedReplacement === normalizedOld) {
      return false;
    }

    const metadata = await readDraftChunks(userId, slotId);
    if (!metadata || metadata.uploadRestartPending || pendingDraftSyncSlotIds.has(slotId)) {
      return false;
    }
    const currentKey = effectiveUploadIdempotencyKey({
      uploadKeyOverride: metadata.uploadKeyOverride,
      supersededUploadKey: metadata.supersededUploadKey,
      durableRecordingId: metadata.durable?.recordingId,
      uploadIntentId: metadata.uploadIntentId,
      slotId,
    });
    if (currentKey !== normalizedOld) return false;

    metadata.uploadKeyOverride = normalizedReplacement;
    metadata.supersededUploadKey = isAudioChangeUploadIdempotencyKey(normalizedReplacement)
      ? null
      : normalizedOld;
    metadata.uploadRestartPending = null;
    metadata.serverDraftId = null;
    metadata.pendingConfirm = null;
    metadata.pendingSync = false;
    metadata.draftMetadataDirty = false;
    await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
    invalidateDraftsCache();
    return true;
  },

  /**
   * Update the server draft ID for an existing draft.
   * Also marks the draft as synced (pendingSync = false).
   */
  async updateServerDraftId(
    slotId: string,
    serverId: string,
    expectedUploadKey?: string,
  ): Promise<UpdateServerDraftIdResult> {
    const userId = currentUserId;
    if (!userId) return 'no_user';

    try {
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata) {
        // readDraftChunks conflates "absent" with "unreadable/corrupt" —
        // Keystore or chunk-read failures also yield null while the draft
        // still exists. Callers delete the server row on 'no_local_meta',
        // so only PROVEN absence may return it; anything unreadable takes
        // the non-deleting 'persist_failed' path and retries later.
        if (!(await draftMetaKeysAbsent(userId, slotId))) {
          draftCaptureWarning('draft_update_server_id_meta_unreadable', {
            slot_id: slotId,
          });
          return 'persist_failed';
        }
        // Server row exists (caller just created it) but local meta is gone —
        // the rule-24 duplicate-on-submit risk. Callers observe the returned
        // 'no_local_meta' and delete the orphan server row, so this is an
        // observed-and-handled event now: info breadcrumb, not an open issue.
        draftCaptureWarning(
          'draft_update_server_id_no_local_meta',
          { slot_id: slotId },
          'info',
        );
        return 'no_local_meta';
      }

      if (metadata.uploadRestartPending) {
        const normalizedExpected = normalizeUploadKeyOverride(expectedUploadKey);
        if (normalizedExpected !== metadata.uploadRestartPending.replacementKey) {
          draftCaptureWarning('draft_update_server_id_restart_key_mismatch', {
            slot_id: slotId,
          });
          return 'restart_key_mismatch';
        }
        metadata.uploadKeyOverride = metadata.uploadRestartPending.replacementKey;
        metadata.supersededUploadKey = isAudioChangeUploadIdempotencyKey(
          metadata.uploadRestartPending.replacementKey,
        )
          ? null
          : metadata.uploadRestartPending.expectedOldKey;
        metadata.uploadRestartPending = null;
        metadata.pendingConfirm = null;
      }
      metadata.serverDraftId = serverId;
      metadata.pendingSync = false;
      metadata.draftMetadataDirty = false;

      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
      return 'updated';
    } catch (error) {
      // Failure here = local meta keeps `serverDraftId=null` while the server
      // has a draft row → next Submit creates a duplicate (rule 24). Surface
      // the silent SecureStore failure mode so it's visible in Sentry.
      draftCaptureWarning('draft_update_server_id_failed', {
        slot_id: slotId,
        reason: classifyDraftFailure(error),
      });
      return 'persist_failed';
    }
  },

  /** Persist a complete post-PUT confirmation hint before confirmation. */
  async updatePendingConfirm(
    slotId: string,
    pendingConfirm: PendingConfirm | null,
    serverDraftId?: string,
    expectedUploadKey?: string,
  ): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;
    try {
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata) return;
      const normalized = clonePendingConfirm(pendingConfirm);
      if (pendingConfirm && !normalized) return;
      if (serverDraftId && metadata.uploadRestartPending) {
        const normalizedExpected = normalizeUploadKeyOverride(expectedUploadKey);
        if (normalizedExpected !== metadata.uploadRestartPending.replacementKey) {
          draftCaptureWarning('draft_pending_confirm_restart_key_mismatch', {
            slot_id: slotId,
          });
          return;
        }
        metadata.uploadKeyOverride = metadata.uploadRestartPending.replacementKey;
        metadata.supersededUploadKey = isAudioChangeUploadIdempotencyKey(
          metadata.uploadRestartPending.replacementKey,
        )
          ? null
          : metadata.uploadRestartPending.expectedOldKey;
        metadata.uploadRestartPending = null;
      }
      metadata.pendingConfirm = normalized;
      if (serverDraftId) {
        metadata.serverDraftId = serverDraftId;
        metadata.pendingSync = false;
      }
      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
    } catch (error) {
      draftCaptureWarning('draft_pending_confirm_write_failed', {
        slot_id: slotId,
        reason: classifyDraftFailure(error),
      });
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

    return this.clearServerDraftIdForUser(userId, slotId);
  },

  /**
   * Detach a server draft for an explicit user without relying on the mutable
   * global draft scope. Background reconciliation can outlive an auth change,
   * so delayed network responses must remain bound to the user that launched
   * the work rather than whichever user is active when the response arrives.
   */
  async clearServerDraftIdForUser(
    userId: string,
    slotId: string,
    expectedServerDraftId?: string,
  ): Promise<void> {
    if (!userId) return;

    try {
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata || !metadata.serverDraftId) return;
      if (expectedServerDraftId && metadata.serverDraftId !== expectedServerDraftId) return;

      metadata.serverDraftId = null;
      metadata.pendingSync = false;
      metadata.draftMetadataDirty = false;

      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
    } catch {
      // Best-effort
    }
  },

  /**
   * Persist the fail-closed metadata dirty bit for an existing server draft.
   * Used when background PATCH cannot prove success before submit/restart.
   */
  async markDraftMetadataDirty(slotId: string): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;

    try {
      const metadata = await readDraftChunks(userId, slotId);
      if (!metadata || !metadata.serverDraftId) return false;

      metadata.draftMetadataDirty = true;
      await writeDraftChunks(userId, slotId, JSON.stringify(metadata));
      invalidateDraftsCache();
      return true;
    } catch (error) {
      draftCaptureWarning('draft_mark_metadata_dirty_failed', {
        slot_id: slotId,
        reason: classifyDraftFailure(error),
      });
      return false;
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

    return this.listDraftsForUser(userId);
  },

  /**
   * List drafts for a specific user without rebinding the global draft scope.
   * Used by device recovery scanners so they cannot clobber the active user.
   */
  async listDraftsForUser(userId: string): Promise<DraftMetadata[]> {
    if (!userId) return [];

    if (draftsListCache && draftsListCache.userId === userId) {
      return draftsListCache.drafts.map(cloneDraftMetadata);
    }

    try {
      const versionAtReadStart = draftsCacheVersion;
      const slotIds = await readDraftIndexForUser(userId);
      const drafts: DraftMetadata[] = [];

      for (const slotId of slotIds) {
        const draft = await readDraftChunks(userId, slotId);
        if (draft) {
          drafts.push(draft);
        }
      }

      // Only populate if no write invalidated mid-read — a slow sweep must
      // not resurrect pre-write data as the cache.
      if (draftsCacheVersion === versionAtReadStart) {
        draftsListCache = { userId, drafts: drafts.map(cloneDraftMetadata) };
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
    return this.deleteDraftForUser(userId, slotId);
  },

  /**
   * Delete a draft for an explicit user. Every key and filesystem path remains
   * bound to that user even if authentication changes while SecureStore awaits.
   */
  async deleteDraftForUser(userId: string, slotId: string): Promise<void> {
    if (!userId) return;
    try {
      // A support-staff-recovery-restored durable draft references its audio via
      // durable.recoveredAudioUri — a loose .aac OUTSIDE the draft dir that the
      // directory delete below won't remove. Delete it so "Delete Draft" / "Delete
      // & Start Over" doesn't leave orphaned clinical audio on disk. Do NOT purge
      // the NATIVE durable audio.aac here: a stash can share it (stashSession
      // deletes the draft while keeping that audio), so purging would corrupt it.
      try {
        const meta = await readDraftChunks(userId, slotId);
        const recoveredAudioUri = meta?.durable?.recoveredAudioUri;
        if (recoveredAudioUri) safeDeleteFile(recoveredAudioUri);
      } catch {
        /* best-effort — proceed with the rest of the delete */
      }

      // Delete audio directory
      const dir = slotDraftDirForUser(userId, slotId);
      safeDeleteDirectory(dir);

      // Delete metadata (chunked layout + legacy single key + meta key)
      await deleteDraftChunks(userId, slotId);

      // Remove from index
      const index = await readDraftIndexForUser(userId);
      const filtered = index.filter((id) => id !== slotId);
      await writeDraftIndexForUser(userId, filtered);
    } catch {
      // Best-effort cleanup
    } finally {
      // After the last write (and on partial failure) so neither the old
      // entry nor mid-delete state survives in the cache.
      invalidateDraftsCache();
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
      invalidateDraftsCache();
    } catch {
      // Best-effort cleanup
    }
  },

  /** True if this draft still has at least one segment audio file on disk. */
  async draftHasLocalAudio(meta: DraftMetadata): Promise<boolean> {
    // The caller uses this as a recoverability predicate for sign-out warnings.
    // Once R2 accepted the bytes, valid confirmation proof is enough even if
    // no local audio remains.
    if (clonePendingConfirm(meta.pendingConfirm)) return true;
    // A durable draft has empty segments but its audio lives in audio.aac under
    // the durable root. Treat a valid, non-purged durable pointer as local audio
    // so the orphan sweep / "Not Submitted" loader don't mistake it for a
    // missing-audio orphan. A tombstoned (confirmed-uploaded + purged) durable
    // recording has no local audio left.
    if (meta.durable && isValidDurableId(meta.durable.recordingId)) {
      const purged = await durableTombstone.has(meta.durable.recordingId);
      return !purged;
    }
    if (!meta.segments || meta.segments.length === 0) return false;
    return meta.segments.some((s) => fileExists(s.uri));
  },

  /**
   * Status-aware, age-based eviction of local drafts. Bounds disk growth on
   * shared tablets WITHOUT silently destroying clinical data.
   *
   * Policy per draft older than `warnAgeDays`:
   *  - Server-confirmed uploaded (serverDraftId set AND server status not in
   *    {draft, failed, error}): the local copy is redundant. At >= maxAgeDays
   *    the local audio + metadata are deleted silently — the real recording
   *    lives on the server; the server row is left untouched.
   *  - Un-sent (no serverDraftId, server still draft/failed/error, or status
   *    unverifiable): NEVER deleted here. Returned to the caller so the UI can
   *    warn first — `expiring` (>= warnAgeDays, < maxAgeDays) drives a heads-up
   *    indicator; `expired` (>= maxAgeDays) drives a Submit-now / Delete prompt.
   *
   * Offline (isOnline === false): the uploaded-confirm branch is skipped for
   * drafts carrying a serverDraftId (status unverifiable -> defer, never
   * delete). Drafts with no serverDraftId still classify with no network.
   */
  async evictExpired(
    opts: {
      maxAgeDays?: number;
      warnAgeDays?: number;
      isOnline?: boolean;
      userId?: string;
      isScopeValid?: () => boolean;
    },
    getStatus?: (serverDraftId: string) => Promise<string | null>
  ): Promise<{ expired: DraftMetadata[]; expiring: DraftMetadata[] }> {
    const expired: DraftMetadata[] = [];
    const expiring: DraftMetadata[] = [];
    const userId = opts.userId ?? currentUserId;
    if (!userId) return { expired, expiring };
    const isScopeValid = opts.isScopeValid ?? (() => currentUserId === userId);
    if (!isScopeValid()) return { expired, expiring };

    const maxAgeDays = opts.maxAgeDays ?? 30;
    const warnAgeDays = opts.warnAgeDays ?? 23;
    const isOnline = opts.isOnline ?? true;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    try {
      const drafts = await this.listDraftsForUser(userId);
      if (!isScopeValid()) return { expired: [], expiring: [] };
      for (const draft of drafts) {
        if (!isScopeValid()) return { expired: [], expiring: [] };
        const savedMs = new Date(draft.savedAt).getTime();
        if (isNaN(savedMs)) continue; // unparseable timestamp — never evict blind
        const ageDays = (now - savedMs) / dayMs;
        if (ageDays < warnAgeDays) continue;

        let uploadedConfirmed = false;
        if (draft.serverDraftId && isOnline && getStatus) {
          try {
            const status = await getStatus(draft.serverDraftId);
            if (!isScopeValid()) return { expired: [], expiring: [] };
            // null/unknown => unverifiable => treat as un-sent (defer).
            uploadedConfirmed =
              status != null &&
              status !== 'missing' &&
              status !== 'draft' &&
              status !== 'failed' &&
              status !== 'error';
          } catch {
            uploadedConfirmed = false; // unverifiable -> defer
          }
          if (!isScopeValid()) return { expired: [], expiring: [] };
        }

        if (uploadedConfirmed) {
          // Never silently delete a non-purged durable recording: its audio.aac
          // is the only local copy until purgeAfterUpload runs. Defer to the
          // launch self-heal, which purges only after confirmed upload.
          if (draft.durable && isValidDurableId(draft.durable.recordingId)) {
            const purged = await durableTombstone.has(draft.durable.recordingId);
            if (!isScopeValid()) return { expired: [], expiring: [] };
            if (!purged) continue;
          }
          // Redundant local copy. Delete silently only once truly old.
          if (ageDays >= maxAgeDays) {
            if (!isScopeValid()) return { expired: [], expiring: [] };
            await this.deleteDraftForUser(userId, draft.slotId);
          }
          continue;
        }

        // Un-sent (or unverifiable): warn-first, never auto-delete here.
        if (ageDays >= maxAgeDays) {
          expired.push(draft);
        } else {
          expiring.push(draft);
        }
      }
    } catch {
      // Best-effort
    }

    return { expired, expiring };
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
    deleteServerDraft: (serverDraftId: string) => Promise<void>,
    opts?: {
      // Server status probe for the empty-server-linked reconcile. Returns the
      // recording status string or null when unverifiable.
      getStatus?: (serverDraftId: string) => Promise<string | null>;
      isOnline?: boolean;
      userId?: string;
      isScopeValid?: () => boolean;
    }
  ): Promise<number> {
    const userId = opts?.userId ?? currentUserId;
    if (!userId) return 0;

    const getStatus = opts?.getStatus;
    const isOnline = opts?.isOnline ?? true;
    const isScopeValid = opts?.isScopeValid ?? (() => currentUserId === userId);
    if (!isScopeValid()) return 0;

    let cleaned = 0;
    let found = 0;
    try {
      const drafts = await this.listDraftsForUser(userId);
      if (!isScopeValid()) return cleaned;
      for (const draft of drafts) {
        if (!isScopeValid()) return cleaned;
        // Missing local audio is not an orphan after R2 has accepted the bytes.
        // Keep the proof so loadDraft can finish the server commit.
        if (clonePendingConfirm(draft.pendingConfirm)) continue;

        const durableId =
          draft.durable && isValidDurableId(draft.durable.recordingId)
            ? draft.durable.recordingId
            : null;

        // Durable-backed draft: audio lives in audio.aac. It is NOT an orphan
        // unless its recording was confirmed-uploaded AND purged (tombstoned) —
        // in which case the empty local draft is a stale leftover. Delete LOCAL
        // metadata only; NEVER delete the server row (it IS the uploaded
        // recording). Without this, the emptyButServerLinked branch below would
        // destroy durable drafts on the next Record-tab mount.
        if (durableId) {
          const purged = await durableTombstone.has(durableId);
          if (!isScopeValid()) return cleaned;
          if (!purged) continue; // valid durable draft, not an orphan
          found++;
          draftBreadcrumb('orphan_sweep_delete', {
            slot_id: draft.slotId,
            shape: 'durable_purged',
            segment_count: 0,
            has_server_draft: !!draft.serverDraftId,
          });
          await this.deleteDraftForUser(userId, draft.slotId);
          cleaned++;
          continue;
        }

        // Legacy orphan shapes:
        //   (a) Non-empty segments but at least one file missing on disk.
        //   (b) Zero segments AND a serverDraftId — produced by an older
        //       build of saveDraft that silently swallowed all-segments-copy
        //       failures and still created a server row.
        const anyMissing =
          draft.segments.length > 0 &&
          draft.segments.some((s) => !fileExists(s.uri));
        const emptyButServerLinked =
          draft.segments.length === 0 && !!draft.serverDraftId;
        if (!anyMissing && !emptyButServerLinked) continue;
        found++;

        draftBreadcrumb('orphan_sweep_delete', {
          slot_id: draft.slotId,
          shape: anyMissing ? 'audio_missing' : 'empty_with_server',
          segment_count: draft.segments.length,
          has_server_draft: !!draft.serverDraftId,
        });

        if (anyMissing && !draft.serverDraftId) {
          // There is no server anchor to protect and the local audio set is
          // irrecoverably incomplete.
          if (!isScopeValid()) return cleaned;
          await this.deleteDraftForUser(userId, draft.slotId);
          cleaned++;
          continue;
        }

        // Every server-linked orphan shape must reconcile through the shared
        // validated batch snapshot before deleting a row or local metadata.
        // FAIL CLOSED: a partial/unknown response preserves everything.
        if (!getStatus || !isOnline || !draft.serverDraftId) {
          continue;
        }
        let status: string | null = null;
        try {
          status = await getStatus(draft.serverDraftId);
        } catch {
          status = null;
        }
        if (!isScopeValid()) return cleaned;
        if (status === null) continue;
        if (status === 'missing') {
          // The row is proven absent in this tenant. There is nothing to
          // delete remotely; remove only the unusable local metadata.
          await this.deleteDraftForUser(userId, draft.slotId);
          cleaned++;
          continue;
        }
        if (status === 'draft') {
          // Only a real server draft is eligible for automatic remote
          // deletion. A failed or otherwise non-draft row can still be a
          // retryable recording with durable audio in R2.
          try {
            if (!isScopeValid()) return cleaned;
            await deleteServerDraft(draft.serverDraftId);
          } catch {
            /* best-effort */
          }
          if (!isScopeValid()) return cleaned;
          await this.deleteDraftForUser(userId, draft.slotId);
          cleaned++;
        } else {
          // Failed/uploaded/processed — the row is real. Keep it; drop only
          // unusable stale local metadata so the leftover card disappears.
          if (!isScopeValid()) return cleaned;
          await this.deleteDraftForUser(userId, draft.slotId);
          cleaned++;
        }
      }
    } catch {
      // Best-effort
    }
    if (found > 0 || cleaned > 0) {
      emitDraftOrphanSweep(found, cleaned);
    }
    if (cleaned > 0) {
      draftBreadcrumb('orphan_sweep_deleted', { found, cleaned });
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
   *
   * createFn receives the full DraftMetadata (NOT just formData) so a durable
   * draft can create with a deterministic `durable-${recordingId}` idempotency
   * key. A random key here would strand the created row if the app dies before
   * updateServerDraftId() persists the anchor, and a later Submit (which reuses
   * `durable-${recordingId}`) would then fresh-create a duplicate server row
   * instead of promoting it. See usePendingDraftSync for the durable branch.
   */
  async syncPending(
    userId: string,
    createFn: (draft: DraftMetadata) => Promise<{ id: string }>
  ): Promise<DraftSyncResult> {
    const previousUserId = currentUserId;
    const result: DraftSyncResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      orphanedServerIds: [],
    };
    try {
      currentUserId = userId;

      const drafts = await this.listDrafts();

      for (const draft of drafts) {
        if (!draft.pendingSync) continue;
        // A controlled restart must establish its replacement through the
        // recovery transaction, never the ordinary background draft-create
        // path. Leave it for the explicit user submit.
        if (draft.supersededUploadKey || draft.uploadRestartPending) continue;
        result.attempted++;
        pendingDraftSyncSlotIds.add(draft.slotId);

        try {
          const created = await createFn(draft);
          const anchor = await this.updateServerDraftId(draft.slotId, created.id);
          // Durable drafts keep a death-surviving anchor in the native
          // manifest (createFn persists it) and re-promote this row via the
          // deterministic `durable-${recordingId}` key — not orphaned.
          if (anchor === 'no_local_meta' && !draft.durable?.recordingId) {
            result.orphanedServerIds.push(created.id);
          }
          result.succeeded++;
        } catch {
          // Best-effort — skip drafts that fail to sync, but emit a
          // telemetry event so we can see spikes in offline-to-server
          // reconciliation failures.
          result.failed++;
          emitDraftSyncRetryFailed(result.attempted);
          continue;
        } finally {
          pendingDraftSyncSlotIds.delete(draft.slotId);
        }
      }

      return result;
    } finally {
      // Only restore if no external setUserId() (e.g. sign-out) happened
      // while we were awaiting — otherwise we'd clobber the new binding and
      // leave this module scoped to the departed user (rules 10 + 17).
      if (currentUserId === userId) currentUserId = previousUserId;
    }
  },
};

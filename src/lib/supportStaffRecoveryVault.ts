import { Paths } from 'expo-file-system';
import { draftStorage, type DraftMetadata } from './draftStorage';
import { stashStorage } from './stashStorage';
import {
  ensureDirectory,
  fileExists,
  fileExistsStrict,
  safeCopyFile,
  safeDeleteDirectory,
  safeDeleteFile,
  writeFilePrefix,
} from './fileOps';
import { StrictReadUnavailableError, parseStrictChunkCount, type StrictExistence } from './strictRead';
import { secureStorage } from './secureStorage';
import { captureMessage } from './monitoring';
import type { CreateRecording, User } from '../types';
import type { StashedSession, StashedSlot } from '../types/stash';
import type { PatientSlot, AudioSegment, DurableSlotRef, PendingConfirm } from '../types/multiPatient';
import { isValidDurableId, RECOVERED_DURABLE_DIR_NAME } from './durableAudio/paths';
import { normalizeUploadIntentId } from './uploadIntent';
import { clonePendingConfirm } from './pendingConfirm';
import { isPimsPatientIdExplicitlyCleared } from './pimsPatientIdIntent';

const CHUNK_SIZE = 1900;
const MAX_RECOVERY_ITEMS = 50;
const BASE_RECOVERY_DIR = `${Paths.document.uri}support-staff-recovery/`;
// Stable per-user home for a restored durable recording's audio.aac. The vault
// item's copy lives under recoveryDir(itemId), which restore deletes — a durable
// draft only stores the pointer (saveDraft never copies durable bytes), so the
// bytes must be moved here first or the restored draft points at a deleted file.
const RESTORED_DURABLE_DIR = `${Paths.document.uri}${RECOVERED_DURABLE_DIR_NAME}/`;
const ACTIVE_KEY = 'captivet_support_staff_recovery_active';

type Generation = 'a' | 'b';

export type RecoveryItemKind = 'draft' | 'stash' | 'audio_only';
export type RecoveryItemStatus = 'available' | 'restored';
export type RecoveryPreserveErrorCode =
  | 'none'
  | 'copy_failed'
  | 'storage_failed'
  | 'capacity_exceeded'
  | 'timeout'
  | 'unknown';

export const SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED = 'SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED';

export interface RecoveryPreserveResult {
  ok: boolean;
  recoverableCount: number;
  preservedCount: number;
  failedCount: number;
  errorCode: RecoveryPreserveErrorCode;
}

export interface RecoverySegment {
  uri: string;
  duration: number;
  peakMetering?: number;
}

export interface RecoverySlot {
  id: string;
  uploadIntentId?: string;
  uploadKeyOverride?: string | null;
  supersededUploadKey?: string | null;
  formData: CreateRecording | null;
  pimsPatientIdExplicitlyCleared?: boolean;
  segments: RecoverySegment[];
  audioDuration: number;
  sourceDraftSlotId?: string | null;
  sourceServerDraftId?: string | null;
  // Durable AAC pointer preserved into the vault. A durable item has empty
  // `segments` and references audio.aac via this pointer; itemIsRecoverable + the
  // vault builders must treat a valid non-purged durable manifest as audio.
  durable?: DurableSlotRef | null;
  // Server-confirmation proof is independently recoverable after R2 accepted
  // the bytes, even when the source audio has already disappeared locally.
  pendingConfirm?: PendingConfirm | null;
}

export interface RecoveryItem {
  id: string;
  recoveryKey: string;
  kind: RecoveryItemKind;
  status: RecoveryItemStatus;
  sourceUserId: string;
  sourceOrganizationId: string | null;
  sourceUserEmail: string | null;
  sourceUserName: string | null;
  sourceRole: string | null;
  savedAt: string;
  restoredAt: string | null;
  slots: RecoverySlot[];
}

type RecoverySourceUser = Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'organizationId'>;
type RecoveryUser = Pick<User, 'id' | 'role' | 'organizationId'>;
type RecoverySourceFields = Pick<RecoveryItem, 'sourceUserId' | 'sourceOrganizationId' | 'sourceUserEmail' | 'sourceUserName' | 'sourceRole'>;

const RECOVERY_ROLES = new Set(['owner', 'admin', 'veterinarian']);

function generationPrefix(generation: Generation): string {
  return `captivet_support_staff_recovery_${generation}_chunk_`;
}

function generationCountKey(generation: Generation): string {
  return `captivet_support_staff_recovery_${generation}_count`;
}

function recoveryDir(itemId: string): string {
  validateLocalId(itemId);
  return `${BASE_RECOVERY_DIR}${itemId}/`;
}

function validateLocalId(id: string): void {
  if (!id || /[\/\\.]/.test(id)) {
    throw new Error('Invalid recovery ID');
  }
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseItems(raw: string): RecoveryItem[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is RecoveryItem =>
      item != null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.recoveryKey === 'string' &&
      Array.isArray((item as RecoveryItem).slots)
  );
}

async function readItemsForGeneration(generation: Generation): Promise<RecoveryItem[] | null> {
  const countRaw = await secureStorage.getRawItem(
    generationCountKey(generation),
    'supportStaffRecovery.getGenerationCount'
  );
  if (!countRaw) return null;
  const count = parseInt(countRaw, 10);
  if (Number.isNaN(count) || count < 0) return null;
  if (count === 0) return [];

  const prefix = generationPrefix(generation);
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = await secureStorage.getRawItem(`${prefix}${i}`, 'supportStaffRecovery.getChunk');
    if (chunk === null) return null;
    chunks.push(chunk);
  }

  try {
    return parseItems(chunks.join(''));
  } catch {
    return null;
  }
}

async function deleteGeneration(generation: Generation): Promise<void> {
  const countRaw = await secureStorage.getRawItem(
    generationCountKey(generation),
    'supportStaffRecovery.getDeleteGenerationCount'
  );
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (!Number.isNaN(count) && count > 0) {
    const prefix = generationPrefix(generation);
    for (let i = 0; i < count; i++) {
      await secureStorage.deleteRawItem(`${prefix}${i}`, 'supportStaffRecovery.deleteChunk');
    }
  }
  await secureStorage.deleteRawItem(generationCountKey(generation), 'supportStaffRecovery.deleteGenerationCount');
}

async function readItems(): Promise<RecoveryItem[]> {
  try {
    const active = await secureStorage.getRawItem(ACTIVE_KEY, 'supportStaffRecovery.getActiveGeneration');
    if (active === 'a' || active === 'b') {
      const activeItems = await readItemsForGeneration(active);
      if (activeItems !== null) return activeItems;
    }

    const bItems = await readItemsForGeneration('b');
    if (bItems !== null && bItems.length > 0) return bItems;
    const aItems = await readItemsForGeneration('a');
    if (aItems !== null && aItems.length > 0) return aItems;
    if (bItems !== null) return bItems;
    if (aItems !== null) return aItems;
    return [];
  } catch {
    return [];
  }
}

async function saveItems(items: RecoveryItem[]): Promise<boolean> {
  try {
    const activeRaw = await secureStorage.getRawItem(ACTIVE_KEY, 'supportStaffRecovery.getActiveGenerationForSave');
    const active: Generation = activeRaw === 'b' ? 'b' : 'a';
    const next: Generation = active === 'a' ? 'b' : 'a';
    await deleteGeneration(next);

    if (items.length > MAX_RECOVERY_ITEMS) return false;
    const sorted = items
      .slice()
      .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    const raw = JSON.stringify(sorted);
    const chunkCount = Math.ceil(raw.length / CHUNK_SIZE);
    const prefix = generationPrefix(next);

    for (let i = 0; i < chunkCount; i++) {
      const savedChunk = await secureStorage.setRawItem(
        `${prefix}${i}`,
        raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        'supportStaffRecovery.setChunk'
      );
      if (!savedChunk) return false;
    }
    const savedCount = await secureStorage.setRawItem(
      generationCountKey(next),
      String(chunkCount),
      'supportStaffRecovery.setGenerationCount'
    );
    if (!savedCount) return false;
    const savedActive = await secureStorage.setRawItem(ACTIVE_KEY, next, 'supportStaffRecovery.setActiveGeneration');
    if (!savedActive) return false;
    await deleteGeneration(active);
    return true;
  } catch {
    return false;
  }
}

async function copySegmentToRecovery(
  sourceUri: string,
  destUri: string
): Promise<boolean> {
  return safeCopyFile(sourceUri, destUri);
}

/**
 * Copy a durable slot's audio.aac from the SOURCE user's (user-scoped) native
 * durable root into the neutral vault dir, returning the local copy URI or null
 * if the manifest/file is unavailable or the copy failed. The copy is what makes
 * a durable recording readable by a DIFFERENT restoring user.
 */
async function copyDurableAudioToRecovery(
  sourceUserId: string,
  durable: DurableSlotRef,
  destUri: string
): Promise<string | null> {
  try {
    // Lazy-require the optional native bridge (Rule 19) so the common non-durable
    // preserve path never pulls it in (and old dev clients don't crash on import).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const durableRecorder = require('../../modules/captivet-durable-recorder') as {
      getManifest: (input: {
        userId: string;
        recordingId: string;
      }) => Promise<{ audioFile?: { uri?: string; completeFrameBytes?: number } } | null>;
    };
    const manifest = await durableRecorder.getManifest({
      userId: sourceUserId,
      recordingId: durable.recordingId,
    });
    const srcUri = manifest?.audioFile?.uri;
    if (!srcUri || !fileExists(srcUri)) return null;
    // Preserve ONLY the complete-ADTS-frame prefix. A crash-interrupted source can
    // have a torn final frame past completeFrameBytes; the cross-user submit path
    // treats recoveredAudioUri as ready-to-upload (no later truncation), so a whole
    // -file copy would carry the torn tail into the vault and fail server-side ADTS
    // validation on restore. A clean stop has completeFrameBytes === file size, so
    // the prefix copy is byte-identical to the full file.
    const completeFrameBytes = manifest?.audioFile?.completeFrameBytes;
    if (typeof completeFrameBytes === 'number' && completeFrameBytes > 0) {
      return writeFilePrefix(srcUri, destUri, completeFrameBytes) ? destUri : null;
    }
    return (await safeCopyFile(srcUri, destUri)) ? destUri : null;
  } catch {
    return null;
  }
}

function sourceFromUser(user: RecoverySourceUser): RecoverySourceFields {
  return {
    sourceUserId: user.id,
    sourceOrganizationId: user.organizationId ?? null,
    sourceUserEmail: user.email ?? null,
    sourceUserName: user.fullName ?? null,
    sourceRole: user.role ?? null,
  };
}

async function buildItemFromSlots(
  params: {
    recoveryKey: string;
    kind: RecoveryItemKind;
    source: RecoverySourceFields;
    slots: {
      id: string;
      uploadIntentId?: string;
      uploadKeyOverride?: string | null;
      supersededUploadKey?: string | null;
      formData: CreateRecording | null;
      pimsPatientIdExplicitlyCleared?: boolean;
      segments: { uri: string; duration?: number; peakMetering?: number }[];
      audioDuration?: number;
      sourceDraftSlotId?: string | null;
      sourceServerDraftId?: string | null;
      durable?: DurableSlotRef | null;
      pendingConfirm?: PendingConfirm | null;
    }[];
  }
): Promise<RecoveryItem | null> {
  const itemId = makeId('recovery');
  const dir = recoveryDir(itemId);
  if (!ensureDirectory(dir)) return null;

  const recoveredSlots: RecoverySlot[] = [];
  let segmentIndex = 0;
  let expectedSegments = 0;
  let copiedSegments = 0;
  // Durable slots have no segment files; count them separately so a dropped
  // durable copy fails the whole item (a partial save would let required
  // support-staff sign-out proceed while silently omitting that patient's audio).
  let expectedDurable = 0;
  let copiedDurable = 0;

  for (const slot of params.slots) {
    const pendingConfirmForSlot = clonePendingConfirm(slot.pendingConfirm);
    const recoveredSegments: RecoverySegment[] = [];
    for (const segment of slot.segments) {
      if (!fileExists(segment.uri)) continue;
      expectedSegments++;
      const destUri = `${dir}segment-${segmentIndex}.m4a`;
      segmentIndex++;
      const copied = await copySegmentToRecovery(segment.uri, destUri);
      if (!copied) continue;
      copiedSegments++;
      recoveredSegments.push({
        uri: destUri,
        duration: Math.max(0, Math.round(segment.duration ?? 0)),
        peakMetering: segment.peakMetering,
      });
    }

    // A durable slot has no files under `segments[]` — audio.aac lives in the
    // user-scoped native durable root, which a DIFFERENT restoring user cannot
    // read. Copy the bytes into the neutral vault dir and carry the copy URI on
    // the pointer so cross-user restore + submit can upload it directly.
    const hasDurable = buildSlotHasDurable(slot.durable);
    let durableForSlot: DurableSlotRef | null = null;
    if (hasDurable && slot.durable) {
      expectedDurable++;
      const destUri = `${dir}durable-${segmentIndex}.aac`;
      segmentIndex++;
      const copiedUri = await copyDurableAudioToRecovery(params.source.sourceUserId, slot.durable, destUri);
      if (copiedUri) {
        copiedDurable++;
        durableForSlot = { ...slot.durable, recoveredAudioUri: copiedUri };
      } else {
        // Could not preserve the bytes — do NOT make a false "recoverable"
        // promise. The original stays under the source user's durable root,
        // untouched by preserve (so it is not lost, just not vault-copied).
        captureMessage('support_staff_recovery_durable_copy_failed', 'warning', {
          tags: { phase: 'support_staff_recovery', kind: params.kind },
        });
      }
    }
    if (recoveredSegments.length === 0 && !durableForSlot && !pendingConfirmForSlot) continue;
    recoveredSlots.push({
      id: slot.id,
      uploadIntentId: normalizeUploadIntentId(slot.uploadIntentId, slot.id),
      uploadKeyOverride: slot.uploadKeyOverride ?? null,
      supersededUploadKey: slot.supersededUploadKey ?? null,
      formData: slot.formData ? { ...slot.formData } : null,
      pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
        slot.formData?.pimsPatientId,
        slot.pimsPatientIdExplicitlyCleared,
      ),
      segments: recoveredSegments,
      durable: durableForSlot,
      pendingConfirm: pendingConfirmForSlot,
      audioDuration: durableForSlot
        ? durableForSlot.durationMs / 1000
        : slot.audioDuration ?? recoveredSegments.reduce((sum, s) => sum + s.duration, 0),
      sourceDraftSlotId: slot.sourceDraftSlotId ?? null,
      sourceServerDraftId: slot.sourceServerDraftId ?? null,
    });
  }

  if (
    recoveredSlots.length === 0 ||
    copiedSegments < expectedSegments ||
    copiedDurable < expectedDurable
  ) {
    if (copiedSegments < expectedSegments || copiedDurable < expectedDurable) {
      captureMessage('support_staff_recovery_copy_incomplete', 'warning', {
        tags: {
          phase: 'support_staff_recovery',
          kind: params.kind,
        },
        extra: {
          expected_segments: expectedSegments,
          copied_segments: copiedSegments,
          expected_durable: expectedDurable,
          copied_durable: copiedDurable,
        },
      });
    }
    safeDeleteDirectory(dir);
    return null;
  }

  return {
    id: itemId,
    recoveryKey: params.recoveryKey,
    kind: params.kind,
    status: 'available',
    ...params.source,
    savedAt: new Date().toISOString(),
    restoredAt: null,
    slots: recoveredSlots,
  };
}

/**
 * A vault item's durable slot is only recoverable if its COPIED audio still
 * exists — a valid recordingId alone is not enough (the recovered .aac can be
 * deleted out from under the pointer), or a stale card would survive and restore
 * would fail later instead of pruning here.
 */
function vaultSlotHasDurableAudio(durable: DurableSlotRef | null | undefined): boolean {
  return (
    buildSlotHasDurable(durable) &&
    !!durable?.recoveredAudioUri &&
    fileExists(durable.recoveredAudioUri)
  );
}

function itemIsRecoverable(item: RecoveryItem): boolean {
  return item.slots.some(
    (slot) =>
      slot.segments.some((segment) => fileExists(segment.uri)) ||
      vaultSlotHasDurableAudio(slot.durable) ||
      !!clonePendingConfirm(slot.pendingConfirm),
  );
}

function canUseRecovery(user: RecoveryUser | null | undefined): user is RecoveryUser {
  return !!user?.id && !!user.organizationId && RECOVERY_ROLES.has(user.role);
}

function itemVisibleToUser(item: RecoveryItem, user: RecoveryUser): boolean {
  return (
    item.status === 'available' &&
    item.sourceOrganizationId === user.organizationId
  );
}

function pendingConfirmFileCount(pendingConfirm: PendingConfirm): number {
  return pendingConfirm.segmentKeys?.length ?? pendingConfirm.files?.length ?? 1;
}

/**
 * A veterinarian cannot operate on another user's server upload intent. They
 * may restore by creating their own row only when the vault holds a complete
 * local copy of every uploaded file represented by the proof.
 */
function vaultSlotHasCompleteLocalAudio(slot: RecoverySlot): boolean {
  if (vaultSlotHasDurableAudio(slot.durable)) return true;
  const pendingConfirm = clonePendingConfirm(slot.pendingConfirm);
  if (!pendingConfirm) {
    return slot.segments.length > 0 && slot.segments.every((segment) => fileExists(segment.uri));
  }
  return (
    slot.segments.length === pendingConfirmFileCount(pendingConfirm) &&
    slot.segments.every((segment) => fileExists(segment.uri))
  );
}

function itemRestorableByUser(item: RecoveryItem, user: RecoveryUser): boolean {
  if (!itemVisibleToUser(item, user) || !itemIsRecoverable(item)) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;
  return item.slots.every(
    (slot) => !clonePendingConfirm(slot.pendingConfirm) || vaultSlotHasCompleteLocalAudio(slot),
  );
}

async function readValidItemsAndPrune(): Promise<RecoveryItem[]> {
  const items = await readItems();
  const validItems = items.filter(itemIsRecoverable);
  if (validItems.length !== items.length) {
    items
      .filter((item) => !itemIsRecoverable(item))
      .forEach((item) => safeDeleteDirectory(recoveryDir(item.id)));
    await saveItems(validItems).catch(() => false);
  }
  return validItems;
}

/**
 * ── STRICT read path (read-only) ───────────────────────────────────────────
 *
 * `readValidItemsAndPrune()` MUTATES (it deletes unrecoverable items and
 * rewrites the store). A destructive decision — "may I delete this server row?"
 * — and the Home recovery banner must never call it: pruning during a read is
 * both a side effect and a lenient filter. These variants are read-only and
 * distinguish absence from present-but-unrecoverable data.
 */

function parseItemsStrict(raw: string): RecoveryItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StrictReadUnavailableError('vault:payload_parse');
  }
  if (!Array.isArray(parsed)) throw new StrictReadUnavailableError('vault:payload_shape');
  for (const item of parsed) {
    const candidate = item as Record<string, unknown> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      typeof candidate.recoveryKey !== 'string' ||
      !Array.isArray(candidate.slots) ||
      // AUTHORIZATION fields must be valid too. `itemVisibleToUser` reads
      // `status` and `sourceOrganizationId`; a missing or malformed one made the
      // item read as definitively INVISIBLE (filtered out with the snapshot still
      // marked complete) rather than unreadable, so an item that still held local
      // audio could yield a `none` anchor and expose the server delete.
      (candidate.status !== 'available' && candidate.status !== 'restored') ||
      (typeof candidate.sourceOrganizationId !== 'string' &&
        candidate.sourceOrganizationId !== null)
    ) {
      throw new StrictReadUnavailableError('vault:item_shape');
    }
    // Validating only the wrapper let a slot carry a malformed segment uri
    // through; `fileExistsStrict` then read it as `missing`, so the snapshot
    // could be certified COMPLETE and the anchor answer `none` while the item's
    // audio directory still existed.
    for (const slot of candidate.slots) {
      if (!slot || typeof slot !== 'object') throw new StrictReadUnavailableError('vault:slot_shape');
      const slotRecord = slot as Record<string, unknown>;
      if (!Array.isArray(slotRecord.segments)) {
        throw new StrictReadUnavailableError('vault:slot_shape');
      }
      for (const segment of slotRecord.segments) {
        if (!segment || typeof segment !== 'object') {
          throw new StrictReadUnavailableError('vault:segment_shape');
        }
        const uri = (segment as Record<string, unknown>).uri;
        if (typeof uri !== 'string' || uri.length === 0) {
          throw new StrictReadUnavailableError('vault:segment_shape');
        }
      }
      // The RECOVERY ANCHOR id must be usable: `findVaultAnchor` normalizes it,
      // so a malformed value reads as "no match" while the slot's audio exists.
      const sourceServerDraftId = slotRecord.sourceServerDraftId;
      if (
        sourceServerDraftId !== undefined &&
        sourceServerDraftId !== null &&
        typeof sourceServerDraftId !== 'string'
      ) {
        throw new StrictReadUnavailableError('vault:slot_anchor_shape');
      }
      // The other audio-bearing claims count too: the strict recoverability
      // helpers normalize a present-but-corrupt `durable`/`pendingConfirm` to
      // absent, which would filter the item while leaving the snapshot
      // `recoverabilityComplete` — and let the anchor answer `none` for its
      // `sourceServerDraftId`. `null`/absent stay legitimate.
      const slotDurable = slotRecord.durable;
      if (slotDurable !== undefined && slotDurable !== null) {
        if (typeof slotDurable !== 'object' || Array.isArray(slotDurable)) {
          throw new StrictReadUnavailableError('vault:slot_durable_shape');
        }
        const durableRecord = slotDurable as Record<string, unknown>;
        if (!isValidDurableId(durableRecord.recordingId)) {
          throw new StrictReadUnavailableError('vault:slot_durable_shape');
        }
        // A valid id is NOT enough here. Unlike a draft — which can point at the
        // user's own native durable dir — vault durable audio IS the cross-user
        // copy at `recoveredAudioUri`, and `vaultSlotHasDurableAudioStrict`
        // converts a missing/unusable URI to `missing`. An otherwise empty
        // matching slot would then be filtered while `recoverabilityComplete`
        // stayed true, so the anchor could answer `none` even though the copied
        // AAC may still sit in the vault directory.
        if (
          typeof durableRecord.recoveredAudioUri !== 'string' ||
          durableRecord.recoveredAudioUri.length === 0
        ) {
          throw new StrictReadUnavailableError('vault:slot_durable_uri');
        }
      }
      const slotPendingConfirm = slotRecord.pendingConfirm;
      if (slotPendingConfirm !== undefined && slotPendingConfirm !== null) {
        if (typeof slotPendingConfirm !== 'object' || Array.isArray(slotPendingConfirm)) {
          throw new StrictReadUnavailableError('vault:slot_pending_confirm_shape');
        }
        if (!clonePendingConfirm(slotPendingConfirm as never)) {
          throw new StrictReadUnavailableError('vault:slot_pending_confirm_shape');
        }
      }
    }
  }
  return parsed as RecoveryItem[];
}

async function readItemsForGenerationStrict(
  generation: Generation
): Promise<RecoveryItem[] | null> {
  const countRaw = await secureStorage.getRawItemStrict(
    generationCountKey(generation),
    'supportStaffRecovery.getGenerationCountStrict'
  );
  if (countRaw === null) return null;
  const count = parseStrictChunkCount(countRaw, 'vault:count');
  if (count === 0) return [];

  const prefix = generationPrefix(generation);
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = await secureStorage.getRawItemStrict(
      `${prefix}${i}`,
      'supportStaffRecovery.getChunkStrict'
    );
    if (chunk === null) throw new StrictReadUnavailableError('vault:torn_chunk');
    chunks.push(chunk);
  }
  return parseItemsStrict(chunks.join(''));
}

async function readItemsStrict(): Promise<RecoveryItem[]> {
  const active = await secureStorage.getRawItemStrict(
    ACTIVE_KEY,
    'supportStaffRecovery.getActiveGenerationStrict'
  );
  // A valid active pointer names the ONLY authoritative generation. If that
  // generation is present-but-unreadable, the answer is unknown — the inactive
  // generation is the previous snapshot and may omit newly preserved
  // support-staff recordings, so certifying it as complete would let Home hide
  // real recovery work and let the unavailable-recording guard conclude there is
  // no vault anchor, exposing a destructive server delete. An older generation
  // can establish a positive match, never absence or a complete count.
  // A PRESENT but malformed pointer is corruption, not a pre-migration absence
  // (see the matching guard in stashStorage): falling through could certify a
  // generation that predates newly preserved recordings.
  if (active !== null && active !== 'a' && active !== 'b') {
    throw new StrictReadUnavailableError('vault:invalid_active_pointer');
  }

  if (active === 'a' || active === 'b') {
    const activeItems = await readItemsForGenerationStrict(active);
    if (activeItems === null) {
      // Dangling pointer, not a pre-migration absence: `saveItems` writes the
      // chunks and the count and only THEN flips this pointer, so a valid
      // pointer asserts its generation was committed. Falling back to the
      // inactive generation here could omit newly preserved recordings.
      throw new StrictReadUnavailableError('vault:dangling_active_pointer');
    }
    return activeItems;
  }

  // Only an ABSENT/invalid pointer may consult the generations directly.
  const order: Generation[] = ['b', 'a'];

  // Same rule as the stash: with no pointer naming the authoritative generation,
  // read BOTH before answering. Returning the first readable one let a stale
  // generation win over a newer one that still holds preserved recordings.
  let sawUnrecoverable = false;
  const readable: RecoveryItem[][] = [];
  for (const generation of order) {
    try {
      const items = await readItemsForGenerationStrict(generation);
      if (items !== null) readable.push(items);
    } catch {
      sawUnrecoverable = true;
    }
  }
  // Same rule as the stash: a readable layout cannot prove what a damaged one
  // does not contain, so any unreadable present layout keeps the answer unknown.
  if (sawUnrecoverable) throw new StrictReadUnavailableError('vault:no_recoverable_generation');
  if (readable.length > 0) {
    const nonEmpty = readable.filter((items) => items.length > 0);
    if (nonEmpty.length === 1) return nonEmpty[0];
    if (nonEmpty.length === 0) return [];
    throw new StrictReadUnavailableError('vault:ambiguous_generations');
  }
  return [];
}

function vaultSlotHasDurableAudioStrict(
  durable: DurableSlotRef | null | undefined
): StrictExistence {
  if (!buildSlotHasDurable(durable) || !durable?.recoveredAudioUri) return 'missing';
  return fileExistsStrict(durable.recoveredAudioUri);
}

/**
 * Whether ONE vault slot still has something recoverable.
 *
 * Exported because a destructive decision must be proved on the slot that
 * actually matches the server recording: an item-level answer only says *some*
 * slot is recoverable, so a multi-slot item could hide deletion for a target
 * slot whose own audio is gone (Codex round 2).
 */
export function vaultSlotIsRecoverableStrict(
  slot: RecoverySlot,
  /**
   * Pass the VIEWER to get the same answer the authorization-filtered listing
   * would give. Omit it for the role-agnostic item-level question.
   */
  user?: Pick<RecoveryUser, 'role'> | null
): StrictExistence {
  const pendingConfirm = clonePendingConfirm(slot.pendingConfirm);
  if (pendingConfirm) {
    // A confirmation token alone is enough for owner/admin, but a veterinarian
    // cannot reuse another user's upload without COMPLETE local audio — the same
    // extra condition `itemRestorableByUserStrict` applies. Without this, a
    // caller could certify a slot the listing then filters out, promising a
    // recovery route that leads nowhere (Codex round 4).
    if (!user || user.role === 'owner' || user.role === 'admin') return 'present';
    return vaultSlotHasCompleteLocalAudioStrict(slot);
  }
  let sawUnknown = false;
  const durable = vaultSlotHasDurableAudioStrict(slot.durable);
  if (durable === 'present') return 'present';
  if (durable === 'unknown') sawUnknown = true;
  for (const segment of slot.segments ?? []) {
    const existence = fileExistsStrict(segment.uri);
    if (existence === 'present') return 'present';
    if (existence === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'missing';
}

function itemIsRecoverableStrict(item: RecoveryItem): StrictExistence {
  let sawUnknown = false;
  for (const slot of item.slots) {
    const slotExistence = vaultSlotIsRecoverableStrict(slot);
    if (slotExistence === 'present') return 'present';
    if (slotExistence === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'missing';
}

function vaultSlotHasCompleteLocalAudioStrict(slot: RecoverySlot): StrictExistence {
  const durable = vaultSlotHasDurableAudioStrict(slot.durable);
  if (durable !== 'missing') return durable;

  const pendingConfirm = clonePendingConfirm(slot.pendingConfirm);
  const requiredCount = pendingConfirm ? pendingConfirmFileCount(pendingConfirm) : null;
  if (requiredCount !== null && slot.segments.length !== requiredCount) return 'missing';
  if (requiredCount === null && slot.segments.length === 0) return 'missing';

  let sawUnknown = false;
  for (const segment of slot.segments) {
    const existence = fileExistsStrict(segment.uri);
    if (existence === 'missing') return 'missing';
    if (existence === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'present';
}

function itemRestorableByUserStrict(item: RecoveryItem, user: RecoveryUser): StrictExistence {
  if (!itemVisibleToUser(item, user)) return 'missing';
  const recoverable = itemIsRecoverableStrict(item);
  if (recoverable !== 'present') return recoverable;
  if (user.role === 'owner' || user.role === 'admin') return 'present';

  let sawUnknown = false;
  for (const slot of item.slots) {
    if (!clonePendingConfirm(slot.pendingConfirm)) continue;
    const complete = vaultSlotHasCompleteLocalAudioStrict(slot);
    if (complete === 'missing') return 'missing';
    if (complete === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'present';
}

/**
 * Read-only, authorization-filtered snapshot of the recovery vault.
 * `recoverabilityComplete === false` means at least one visible item's
 * recoverability could not be decided — the caller must render an explicit
 * "could not check" state rather than a count, and a destructive decision must
 * fail closed. Items whose recoverability is UNKNOWN are retained on purpose:
 * keeping one can only block a delete, never enable it.
 */
export interface StrictVaultSnapshot {
  items: RecoveryItem[];
  recoverabilityComplete: boolean;
}

interface AddItemsResult {
  addedCount: number;
  existingCount: number;
  ok: boolean;
  errorCode: RecoveryPreserveErrorCode;
}

async function addItems(itemsToAdd: RecoveryItem[]): Promise<AddItemsResult> {
  if (itemsToAdd.length === 0) {
    return { addedCount: 0, existingCount: 0, ok: true, errorCode: 'none' };
  }
  const existing = await readValidItemsAndPrune();
  const existingKeys = new Set(existing.map((item) => item.recoveryKey));
  const deduped = itemsToAdd.filter((item) => !existingKeys.has(item.recoveryKey));
  const duplicateItems = itemsToAdd.filter((item) => existingKeys.has(item.recoveryKey));
  duplicateItems.forEach((item) => safeDeleteDirectory(recoveryDir(item.id)));
  if (deduped.length === 0) {
    return { addedCount: 0, existingCount: duplicateItems.length, ok: true, errorCode: 'none' };
  }
  if (existing.length + deduped.length > MAX_RECOVERY_ITEMS) {
    deduped.forEach((item) => safeDeleteDirectory(recoveryDir(item.id)));
    return {
      addedCount: 0,
      existingCount: duplicateItems.length,
      ok: false,
      errorCode: 'capacity_exceeded',
    };
  }
  const saved = await saveItems([...deduped, ...existing]);
  if (!saved) {
    deduped.forEach((item) => safeDeleteDirectory(recoveryDir(item.id)));
    return {
      addedCount: 0,
      existingCount: duplicateItems.length,
      ok: false,
      errorCode: 'storage_failed',
    };
  }
  return {
    addedCount: deduped.length,
    existingCount: duplicateItems.length,
    ok: true,
    errorCode: 'none',
  };
}

function draftToBuildSlot(draft: DraftMetadata) {
  return {
    id: draft.slotId,
    uploadIntentId: draft.uploadIntentId,
    uploadKeyOverride: draft.uploadKeyOverride,
    supersededUploadKey: draft.supersededUploadKey,
    formData: draft.formData,
    pimsPatientIdExplicitlyCleared: draft.pimsPatientIdExplicitlyCleared,
    segments: draft.segments,
    audioDuration: draft.audioDuration,
    sourceDraftSlotId: draft.slotId,
    sourceServerDraftId: draft.serverDraftId,
    durable: draft.durable ?? null,
    pendingConfirm: clonePendingConfirm(draft.pendingConfirm),
  };
}

function stashedSlotToBuildSlot(slot: StashedSlot) {
  return {
    id: slot.id,
    uploadIntentId: slot.uploadIntentId,
    uploadKeyOverride: slot.uploadKeyOverride,
    supersededUploadKey: slot.supersededUploadKey,
    formData: slot.formData,
    pimsPatientIdExplicitlyCleared: slot.pimsPatientIdExplicitlyCleared,
    segments: slot.segments,
    audioDuration: slot.audioDuration,
    sourceDraftSlotId: slot.draftSlotId ?? null,
    sourceServerDraftId: slot.serverDraftId ?? null,
    durable: slot.durable ?? null,
    pendingConfirm: clonePendingConfirm(slot.pendingConfirm),
  };
}

/** A build slot carries recoverable audio if it has segment files OR a durable pointer. */
function buildSlotHasDurable(durable: DurableSlotRef | null | undefined): boolean {
  return !!durable && isValidDurableId(durable.recordingId);
}

async function buildDraftItemsForSource(
  source: RecoverySourceFields,
  drafts: DraftMetadata[]
): Promise<{ items: RecoveryItem[]; recoverableCount: number; failedCount: number }> {
  const items: RecoveryItem[] = [];
  let recoverableCount = 0;
  let failedCount = 0;

  for (const draft of drafts) {
    if (
      !draft.segments.some((segment) => fileExists(segment.uri)) &&
      !buildSlotHasDurable(draft.durable) &&
      !clonePendingConfirm(draft.pendingConfirm)
    )
      continue;
    recoverableCount++;
    const item = await buildItemFromSlots({
      recoveryKey: `draft:${source.sourceUserId}:${draft.slotId}`,
      kind: 'draft',
      source,
      slots: [draftToBuildSlot(draft)],
    });
    if (item) {
      items.push(item);
    } else {
      failedCount++;
    }
  }

  return { items, recoverableCount, failedCount };
}

async function buildStashItemsForSource(
  source: RecoverySourceFields,
  stashes: StashedSession[]
): Promise<{ items: RecoveryItem[]; recoverableCount: number; failedCount: number }> {
  const items: RecoveryItem[] = [];
  let recoverableCount = 0;
  let failedCount = 0;

  for (const stash of stashes) {
    const slots = stash.slots.filter(
      (slot) =>
        slot.segments.some((segment) => fileExists(segment.uri)) ||
        buildSlotHasDurable(slot.durable) ||
        !!clonePendingConfirm(slot.pendingConfirm)
    );
    if (slots.length === 0) continue;
    recoverableCount++;
    const item = await buildItemFromSlots({
      recoveryKey: `stash:${source.sourceUserId}:${stash.id}`,
      kind: 'stash',
      source,
      slots: slots.map(stashedSlotToBuildSlot),
    });
    if (item) {
      items.push(item);
    } else {
      failedCount++;
    }
  }

  return { items, recoverableCount, failedCount };
}

function makeRestoredSlot(
  slot: RecoverySlot,
  formData: CreateRecording,
  index: number,
  reuseSourceUpload: boolean,
): PatientSlot {
  const segments: AudioSegment[] = slot.segments.map((segment) => ({
    uri: segment.uri,
    duration: segment.duration,
    peakMetering: segment.peakMetering,
  }));
  const slotId = makeId(`recovered-${index + 1}`);
  const durable = slot.durable ?? null;
  // Owner/admin server routes may finish an organization member's upload.
  // Veterinarians must re-upload the complete vault copy under their own row.
  const pendingConfirm = reuseSourceUpload ? clonePendingConfirm(slot.pendingConfirm) : null;
  return {
    id: slotId,
    uploadIntentId: normalizeUploadIntentId(slot.uploadIntentId, slot.id),
    uploadKeyOverride: reuseSourceUpload ? (slot.uploadKeyOverride ?? null) : null,
    supersededUploadKey: reuseSourceUpload ? (slot.supersededUploadKey ?? null) : null,
    uploadRecovery: null,
    metadataDivergence: null,
    formData,
    pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
      formData.pimsPatientId,
      slot.pimsPatientIdExplicitlyCleared,
    ),
    audioState: 'stopped',
    segments,
    durable,
    audioUri: segments.at(-1)?.uri ?? null,
    audioDuration: durable ? durable.durationMs / 1000 : slot.audioDuration || segments.reduce((sum, segment) => sum + segment.duration, 0),
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    serverRecordingId: null,
    draftSlotId: null,
    // Proof identifies the exact server row whose R2 object must be confirmed.
    // Keep it as the draft anchor so background sync cannot create a duplicate
    // row before the restored user taps Submit.
    serverDraftId: pendingConfirm?.recordingId ?? null,
    draftMetadataDirty: false,
    pendingConfirm,
  };
}

export const supportStaffRecoveryVault = {
  async listItemsForUser(user: RecoveryUser | null | undefined): Promise<RecoveryItem[]> {
    if (!canUseRecovery(user)) return [];
    const items = await readValidItemsAndPrune();
    return items.filter((item) => itemRestorableByUser(item, user));
  },

  async countItemsForUser(user: RecoveryUser | null | undefined): Promise<number> {
    return (await this.listItemsForUser(user)).length;
  },

  /**
   * STRICT, READ-ONLY, authorization-filtered snapshot. Throws
   * StrictReadUnavailableError when the vault store itself is present but
   * unrecoverable. Never prunes, never writes, never rebinds scope — unlike
   * `listItemsForUser`, which prunes as a side effect of reading.
   */
  async listItemsForUserStrict(
    user: RecoveryUser | null | undefined
  ): Promise<StrictVaultSnapshot> {
    if (!canUseRecovery(user)) return { items: [], recoverabilityComplete: true };
    const all = await readItemsStrict();
    const items: RecoveryItem[] = [];
    let recoverabilityComplete = true;
    for (const item of all) {
      const restorable = itemRestorableByUserStrict(item, user);
      if (restorable === 'missing') continue;
      if (restorable === 'unknown') recoverabilityComplete = false;
      items.push(item);
    }
    return { items, recoverabilityComplete };
  },

  async countScopedUserRecoverableRecordings(): Promise<number> {
    try {
      const drafts = await draftStorage.listDrafts();
      const stashes = await stashStorage.getStashedSessions();
      const draftCount = drafts.filter(
        (draft) =>
          draft.segments.some((segment) => fileExists(segment.uri)) ||
          buildSlotHasDurable(draft.durable) ||
          !!clonePendingConfirm(draft.pendingConfirm)
      ).length;
      const stashCount = stashes.filter((stash) =>
        stash.slots.some(
          (slot) =>
            slot.segments.some((segment) => fileExists(segment.uri)) ||
            buildSlotHasDurable(slot.durable) ||
            !!clonePendingConfirm(slot.pendingConfirm)
        )
      ).length;
      return draftCount + stashCount;
    } catch {
      return 0;
    }
  },

  async preserveScopedUserRecordings(sourceUser: RecoverySourceUser | null | undefined): Promise<RecoveryPreserveResult> {
    if (!sourceUser?.id || sourceUser.role !== 'support_staff') {
      return { ok: true, recoverableCount: 0, preservedCount: 0, failedCount: 0, errorCode: 'none' };
    }

    try {
      const source = sourceFromUser(sourceUser);
      const [drafts, stashes] = await Promise.all([
        draftStorage.listDrafts(),
        stashStorage.getStashedSessions(),
      ]);
      const [draftResult, stashResult] = await Promise.all([
        buildDraftItemsForSource(source, drafts),
        buildStashItemsForSource(source, stashes),
      ]);
      const items = [...draftResult.items, ...stashResult.items];
      const addResult = await addItems(items);
      const recoverableCount = draftResult.recoverableCount + stashResult.recoverableCount;
      const preservedCount = addResult.addedCount + addResult.existingCount;
      const failedCount = Math.max(0, recoverableCount - preservedCount);

      return {
        ok: addResult.ok && failedCount === 0,
        recoverableCount,
        preservedCount,
        failedCount,
        errorCode:
          failedCount === 0
            ? 'none'
            : addResult.errorCode !== 'none'
              ? addResult.errorCode
              : 'copy_failed',
      };
    } catch {
      return {
        ok: false,
        recoverableCount: 0,
        preservedCount: 0,
        failedCount: 1,
        errorCode: 'storage_failed',
      };
    }
  },

  async scanForLeftoverRecordingsForUser(user: RecoveryUser | null | undefined): Promise<number> {
    if (!canUseRecovery(user)) return 0;
    // Older draft/stash directories do not carry organization metadata, so
    // this path only prunes verified recovery copies. Copying raw leftovers
    // would either expose cross-org PHI or create unrecoverable duplicate files.
    await readValidItemsAndPrune();
    return 0;
  },

  async restoreItemToCurrentUserDrafts(
    user: RecoveryUser | null | undefined,
    itemId: string,
    formDataBySlotId: Record<string, CreateRecording> = {}
  ): Promise<string[]> {
    if (!canUseRecovery(user)) return [];

    const items = await readValidItemsAndPrune();
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || !itemRestorableByUser(item, user)) return [];
    const reuseSourceUpload = user.role === 'owner' || user.role === 'admin';

    const slotsToRestore = item.slots.map((slot) => {
      const formData = slot.formData ?? formDataBySlotId[slot.id];
      return formData ? { slot, formData } : null;
    });
    if (slotsToRestore.some((entry) => entry === null)) return [];

    const restoredSlotIds: string[] = [];
    // Durable .aac copies made into the stable dir this run. If a later saveDraft
    // throws, the copy for the FAILED slot is not owned by any draft, so track +
    // remove them in the catch — else each retry orphans another .aac.
    const copiedDurableUris: string[] = [];
    try {
      for (let i = 0; i < slotsToRestore.length; i++) {
        const entry = slotsToRestore[i];
        if (!entry) continue;
        let restoredSlot = makeRestoredSlot(entry.slot, entry.formData, i, reuseSourceUpload);
        // Durable restore: the recovered audio.aac lives under the vault item dir,
        // which deleteItem() (below) removes — and saveDraft does NOT copy durable
        // bytes (metadata-only). Move the bytes into a stable current-user home and
        // repoint recoveredAudioUri BEFORE saving, so the restored draft's submit
        // can still read the audio after the vault item is deleted.
        const recoveredAudioUri = restoredSlot.durable?.recoveredAudioUri;
        if (restoredSlot.durable && recoveredAudioUri) {
          const stableDir = `${RESTORED_DURABLE_DIR}${user.id}/`;
          if (!ensureDirectory(stableDir)) {
            throw new Error('recovered durable dir unavailable');
          }
          const stableUri = `${stableDir}${restoredSlot.id}.aac`;
          if (!(await safeCopyFile(recoveredAudioUri, stableUri))) {
            throw new Error('recovered durable audio copy failed');
          }
          copiedDurableUris.push(stableUri);
          restoredSlot = {
            ...restoredSlot,
            durable: { ...restoredSlot.durable, recoveredAudioUri: stableUri },
          };
        }
        const { draftSlotId } = await draftStorage.saveDraft(restoredSlot);
        restoredSlotIds.push(draftSlotId);
      }
    } catch (error) {
      await Promise.all(restoredSlotIds.map((slotId) => draftStorage.deleteDraft(slotId).catch(() => {})));
      // Remove durable .aac copies for slots whose saveDraft did not commit. Copies
      // for slots that DID save are owned by their draft (deleteDraft above removes
      // recoveredAudioUri); safeDeleteFile is idempotent so deleting all is safe.
      for (const uri of copiedDurableUris) safeDeleteFile(uri);
      throw error;
    }

    if (restoredSlotIds.length > 0) {
      await this.deleteItem(user, item.id);
    }

    return restoredSlotIds;
  },

  async deleteItem(user: RecoveryUser | null | undefined, itemId: string): Promise<boolean> {
    if (!canUseRecovery(user)) return false;
    const items = await readItems();
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item || !itemVisibleToUser(item, user)) return false;
    const filtered = items.filter((item) => item.id !== itemId);
    const saved = await saveItems(filtered);
    if (!saved) return false;
    safeDeleteDirectory(recoveryDir(itemId));
    return true;
  },
};

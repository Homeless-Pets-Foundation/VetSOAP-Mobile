import { Paths } from 'expo-file-system';
import { draftStorage, type DraftMetadata } from './draftStorage';
import { stashStorage } from './stashStorage';
import {
  ensureDirectory,
  fileExists,
  safeCopyFile,
  safeDeleteDirectory,
  writeFilePrefix,
} from './fileOps';
import { secureStorage } from './secureStorage';
import { captureMessage } from './monitoring';
import type { CreateRecording, User } from '../types';
import type { StashedSession, StashedSlot } from '../types/stash';
import type { PatientSlot, AudioSegment, DurableSlotRef } from '../types/multiPatient';
import { isValidDurableId } from './durableAudio/paths';

const CHUNK_SIZE = 1900;
const MAX_RECOVERY_ITEMS = 50;
const BASE_RECOVERY_DIR = `${Paths.document.uri}support-staff-recovery/`;
// Stable per-user home for a restored durable recording's audio.aac. The vault
// item's copy lives under recoveryDir(itemId), which restore deletes — a durable
// draft only stores the pointer (saveDraft never copies durable bytes), so the
// bytes must be moved here first or the restored draft points at a deleted file.
const RESTORED_DURABLE_DIR = `${Paths.document.uri}recovered-durable/`;
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
  formData: CreateRecording | null;
  segments: RecoverySegment[];
  audioDuration: number;
  sourceDraftSlotId?: string | null;
  sourceServerDraftId?: string | null;
  // Durable AAC pointer preserved into the vault. A durable item has empty
  // `segments` and references audio.aac via this pointer; itemHasAudio + the
  // vault builders must treat a valid non-purged durable manifest as audio.
  durable?: DurableSlotRef | null;
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
      formData: CreateRecording | null;
      segments: { uri: string; duration?: number; peakMetering?: number }[];
      audioDuration?: number;
      sourceDraftSlotId?: string | null;
      sourceServerDraftId?: string | null;
      durable?: DurableSlotRef | null;
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

  for (const slot of params.slots) {
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
      const destUri = `${dir}durable-${segmentIndex}.aac`;
      segmentIndex++;
      const copiedUri = await copyDurableAudioToRecovery(params.source.sourceUserId, slot.durable, destUri);
      if (copiedUri) {
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
    if (recoveredSegments.length === 0 && !durableForSlot) continue;
    recoveredSlots.push({
      id: slot.id,
      formData: slot.formData ? { ...slot.formData } : null,
      segments: recoveredSegments,
      durable: durableForSlot,
      audioDuration: durableForSlot
        ? durableForSlot.durationMs / 1000
        : slot.audioDuration ?? recoveredSegments.reduce((sum, s) => sum + s.duration, 0),
      sourceDraftSlotId: slot.sourceDraftSlotId ?? null,
      sourceServerDraftId: slot.sourceServerDraftId ?? null,
    });
  }

  if (recoveredSlots.length === 0 || copiedSegments < expectedSegments) {
    if (copiedSegments < expectedSegments) {
      captureMessage('support_staff_recovery_copy_incomplete', 'warning', {
        tags: {
          phase: 'support_staff_recovery',
          kind: params.kind,
        },
        extra: {
          expected_segments: expectedSegments,
          copied_segments: copiedSegments,
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

function itemHasAudio(item: RecoveryItem): boolean {
  return item.slots.some(
    (slot) =>
      slot.segments.some((segment) => fileExists(segment.uri)) || buildSlotHasDurable(slot.durable),
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

async function readValidItemsAndPrune(): Promise<RecoveryItem[]> {
  const items = await readItems();
  const validItems = items.filter(itemHasAudio);
  if (validItems.length !== items.length) {
    items
      .filter((item) => !itemHasAudio(item))
      .forEach((item) => safeDeleteDirectory(recoveryDir(item.id)));
    await saveItems(validItems).catch(() => false);
  }
  return validItems;
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
    formData: draft.formData,
    segments: draft.segments,
    audioDuration: draft.audioDuration,
    sourceDraftSlotId: draft.slotId,
    sourceServerDraftId: draft.serverDraftId,
    durable: draft.durable ?? null,
  };
}

function stashedSlotToBuildSlot(slot: StashedSlot) {
  return {
    id: slot.id,
    formData: slot.formData,
    segments: slot.segments,
    audioDuration: slot.audioDuration,
    sourceDraftSlotId: slot.draftSlotId ?? null,
    sourceServerDraftId: slot.serverDraftId ?? null,
    durable: slot.durable ?? null,
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
      !buildSlotHasDurable(draft.durable)
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
        slot.segments.some((segment) => fileExists(segment.uri)) || buildSlotHasDurable(slot.durable),
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

function makeRestoredSlot(slot: RecoverySlot, formData: CreateRecording, index: number): PatientSlot {
  const segments: AudioSegment[] = slot.segments.map((segment) => ({
    uri: segment.uri,
    duration: segment.duration,
    peakMetering: segment.peakMetering,
  }));
  const slotId = makeId(`recovered-${index + 1}`);
  const durable = slot.durable ?? null;
  return {
    id: slotId,
    formData,
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
    serverDraftId: null,
    draftMetadataDirty: false,
    pendingConfirm: null,
  };
}

export const supportStaffRecoveryVault = {
  async listItemsForUser(user: RecoveryUser | null | undefined): Promise<RecoveryItem[]> {
    if (!canUseRecovery(user)) return [];
    const items = await readValidItemsAndPrune();
    return items.filter((item) => itemVisibleToUser(item, user));
  },

  async countItemsForUser(user: RecoveryUser | null | undefined): Promise<number> {
    return (await this.listItemsForUser(user)).length;
  },

  async countScopedUserRecoverableRecordings(): Promise<number> {
    try {
      const drafts = await draftStorage.listDrafts();
      const stashes = await stashStorage.getStashedSessions();
      const draftCount = drafts.filter(
        (draft) =>
          draft.segments.some((segment) => fileExists(segment.uri)) || buildSlotHasDurable(draft.durable)
      ).length;
      const stashCount = stashes.filter((stash) =>
        stash.slots.some(
          (slot) => slot.segments.some((segment) => fileExists(segment.uri)) || buildSlotHasDurable(slot.durable)
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
    if (!item || !itemVisibleToUser(item, user)) return [];

    const slotsToRestore = item.slots.map((slot) => {
      const formData = slot.formData ?? formDataBySlotId[slot.id];
      return formData ? { slot, formData } : null;
    });
    if (slotsToRestore.some((entry) => entry === null)) return [];

    const restoredSlotIds: string[] = [];
    try {
      for (let i = 0; i < slotsToRestore.length; i++) {
        const entry = slotsToRestore[i];
        if (!entry) continue;
        let restoredSlot = makeRestoredSlot(entry.slot, entry.formData, i);
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

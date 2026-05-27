import * as SecureStore from 'expo-secure-store';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { copyAsync as legacyCopyAsync } from 'expo-file-system/legacy';
import { draftStorage, type DraftMetadata } from './draftStorage';
import { stashStorage } from './stashStorage';
import {
  ensureDirectory,
  fileExists,
  safeDeleteDirectory,
  safeDeleteFile,
} from './fileOps';
import type { CreateRecording, User } from '../types';
import type { StashedSession, StashedSlot } from '../types/stash';
import type { PatientSlot, AudioSegment } from '../types/multiPatient';

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const CHUNK_SIZE = 1900;
const MAX_RECOVERY_ITEMS = 50;
const BASE_RECOVERY_DIR = `${Paths.document.uri}support-staff-recovery/`;
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
  const countRaw = await SecureStore.getItemAsync(generationCountKey(generation));
  if (!countRaw) return null;
  const count = parseInt(countRaw, 10);
  if (Number.isNaN(count) || count < 0) return null;
  if (count === 0) return [];

  const prefix = generationPrefix(generation);
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = await SecureStore.getItemAsync(`${prefix}${i}`);
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
  const countRaw = await SecureStore.getItemAsync(generationCountKey(generation));
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  if (!Number.isNaN(count) && count > 0) {
    const prefix = generationPrefix(generation);
    for (let i = 0; i < count; i++) {
      await SecureStore.deleteItemAsync(`${prefix}${i}`).catch(() => {});
    }
  }
  await SecureStore.deleteItemAsync(generationCountKey(generation)).catch(() => {});
}

async function readItems(): Promise<RecoveryItem[]> {
  try {
    const active = await SecureStore.getItemAsync(ACTIVE_KEY);
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
    const activeRaw = await SecureStore.getItemAsync(ACTIVE_KEY);
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
      await SecureStore.setItemAsync(`${prefix}${i}`, raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), STORE_OPTIONS);
    }
    await SecureStore.setItemAsync(generationCountKey(next), String(chunkCount), STORE_OPTIONS);
    await SecureStore.setItemAsync(ACTIVE_KEY, next, STORE_OPTIONS);
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
  if (!fileExists(sourceUri)) return false;
  safeDeleteFile(destUri);
  try {
    new ExpoFile(sourceUri).copy(new ExpoFile(destUri));
  } catch {
    try {
      await legacyCopyAsync({ from: sourceUri, to: destUri });
    } catch {
      return false;
    }
  }
  return fileExists(destUri);
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

    if (recoveredSegments.length === 0) continue;
    recoveredSlots.push({
      id: slot.id,
      formData: slot.formData ? { ...slot.formData } : null,
      segments: recoveredSegments,
      audioDuration: slot.audioDuration ?? recoveredSegments.reduce((sum, s) => sum + s.duration, 0),
      sourceDraftSlotId: slot.sourceDraftSlotId ?? null,
      sourceServerDraftId: slot.sourceServerDraftId ?? null,
    });
  }

  if (recoveredSlots.length === 0 || copiedSegments < expectedSegments) {
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
  return item.slots.some((slot) => slot.segments.some((segment) => fileExists(segment.uri)));
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
  };
}

async function buildDraftItemsForSource(
  source: RecoverySourceFields,
  drafts: DraftMetadata[]
): Promise<{ items: RecoveryItem[]; recoverableCount: number; failedCount: number }> {
  const items: RecoveryItem[] = [];
  let recoverableCount = 0;
  let failedCount = 0;

  for (const draft of drafts) {
    if (!draft.segments.some((segment) => fileExists(segment.uri))) continue;
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
    const slots = stash.slots.filter((slot) => slot.segments.some((segment) => fileExists(segment.uri)));
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
  return {
    id: slotId,
    formData,
    audioState: 'stopped',
    segments,
    audioUri: segments.at(-1)?.uri ?? null,
    audioDuration: slot.audioDuration || segments.reduce((sum, segment) => sum + segment.duration, 0),
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
      const draftCount = drafts.filter((draft) => draft.segments.some((segment) => fileExists(segment.uri))).length;
      const stashCount = stashes.filter((stash) =>
        stash.slots.some((slot) => slot.segments.some((segment) => fileExists(segment.uri)))
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
        const restoredSlot = makeRestoredSlot(entry.slot, entry.formData, i);
        const { draftSlotId } = await draftStorage.saveDraft(restoredSlot);
        restoredSlotIds.push(draftSlotId);
      }
    } catch (error) {
      await Promise.all(restoredSlotIds.map((slotId) => draftStorage.deleteDraft(slotId).catch(() => {})));
      throw error;
    }

    if (restoredSlotIds.length > 0) {
      await this.deleteItem(item.id);
    }

    return restoredSlotIds;
  },

  async deleteItem(itemId: string): Promise<void> {
    const items = await readItems();
    const filtered = items.filter((item) => item.id !== itemId);
    await saveItems(filtered);
    safeDeleteDirectory(recoveryDir(itemId));
  },
};

/**
 * Launch-time durable-recovery orchestration (plan: Recovery UX).
 *
 * Runs after auth + draft-storage user ID resolve (post-setUserId one-shot). It:
 *   1. enumerates recoverable durable manifests (native, bounded, off-thread),
 *   2. reconciles created-but-unconfirmed recordings against the server,
 *   3. self-heals confirmed-uploaded-but-not-purged manifests (delete linked
 *      draft FIRST, then purge, then tombstone — the load-bearing order),
 *   4. reconciles a stash-mid-crash draft (draft + stash both reference the same
 *      recordingId) by deleting the orphaned draft (stash owns the audio),
 *   5. returns the bounded list of manifests to OFFER as recovery cards
 *      (suppressing any already surfaced via an existing draft/stash card).
 *
 * Never throws — a recovery-path failure must not block app entry. The native
 * enumeration is wrapped by a Rule 24 watchdog at the call site (AuthProvider).
 */
import * as durableRecorder from '../../../modules/captivet-durable-recorder';
import type { DurableRecordingManifest } from './manifest';
import { selectRecoverableSessions, needsServerReconcile } from './recoveryLogic';
import { isValidDurableId } from './paths';
import { durableTombstone } from './tombstone';
import { durableActiveStore } from './activeStore';
import { draftStorage } from '../draftStorage';
import { stashStorage } from '../stashStorage';
import { recoveryIntent } from '../recoveryIntent';
import { recordingsApi } from '../../api/recordings';
import { breadcrumb, captureMessage } from '../monitoring';
import { trackEvent } from '../analytics';
import { durableRecoveryStore } from './recoveryState';

const MAX_OFFERED = 50;
/** Rule 24 watchdog: a hung native scan must never stall app entry. */
const SCAN_WATCHDOG_MS = 12_000;

/** Uploaded/processed = not one of the pre-upload states. null = unverifiable. */
async function serverStatusIsUploaded(serverRecordingId: string): Promise<boolean | null> {
  try {
    const rec = await recordingsApi.get(serverRecordingId);
    // Server may report draft/failed/error which the narrow client union omits.
    const status = rec?.status as string | undefined;
    if (typeof status !== 'string') return null;
    return status !== 'draft' && status !== 'failed' && status !== 'error' && status !== 'uploading';
  } catch {
    return null; // unverifiable (offline / 404 handled by caller as not-uploaded)
  }
}

/** Delete a confirmed-uploaded manifest's local footprint in the load-bearing order. */
async function selfHeal(userId: string, manifest: DurableRecordingManifest): Promise<void> {
  const recordingId = manifest.recordingId;
  // 1. Delete the linked finished draft + its local audio FIRST, so
  //    cleanupOrphaned never sees an orphaned draft with a missing manifest.
  try {
    await draftStorage.deleteDraft(manifest.slotId);
    await recoveryIntent.clearForDraftSlot(manifest.slotId);
  } catch {
    // Draft delete failed — leave the uploaded manifest for the next-launch
    // retry (purge is idempotent) but STILL tombstone so an offline
    // cleanupOrphaned never deletes the just-uploaded server row.
    await durableTombstone.add(recordingId).catch(() => {});
    return;
  }
  // 2. Purge the manifest/audio only after the draft delete succeeded.
  try {
    await durableRecorder.purgeAfterUpload({ userId, recordingId });
  } catch {
    /* idempotent — next launch retries */
  }
  // 3. Tombstone so cleanupOrphaned skips deleting the uploaded server row.
  await durableTombstone.add(recordingId).catch(() => {});
  await durableActiveStore.clearActive(recordingId).catch(() => {});
}

export async function scanDurableRecoveries(userId: string): Promise<DurableRecordingManifest[]> {
  if (!isValidDurableId(userId)) return [];
  durableTombstone.setUserId(userId);
  durableActiveStore.setUserId(userId);

  let manifests: DurableRecordingManifest[];
  try {
    manifests = await durableRecorder.listRecoverableSessions(userId);
  } catch {
    return [];
  }
  if (!manifests || manifests.length === 0) {
    // Even with no recoverable capture, clear the active-recording pointer so a
    // clean prior exit doesn't look like a crash next launch.
    return [];
  }

  // Reconcile created-but-unconfirmed recordings against the server BEFORE
  // selection: if already confirmed-uploaded, mark uploaded so it self-heals and
  // is never re-offered.
  for (const m of manifests) {
    if (!needsServerReconcile(m) || !m.serverRecordingId) continue;
    const uploaded = await serverStatusIsUploaded(m.serverRecordingId);
    if (uploaded === true) {
      await durableRecorder
        .markUploaded({ userId, recordingId: m.recordingId, confirmedUploadAt: new Date().toISOString() })
        .catch(() => {});
      m.state = 'uploaded';
      m.confirmedUploadAt = new Date().toISOString();
    }
  }

  // Reference sets: durable recordingIds already surfaced via a draft or stash.
  const draftRecordingIds = new Set<string>();
  const stashRecordingIds = new Set<string>();
  let drafts: Awaited<ReturnType<typeof draftStorage.listDrafts>> = [];
  try {
    drafts = await draftStorage.listDrafts();
    for (const d of drafts) {
      if (d.durable?.recordingId) draftRecordingIds.add(d.durable.recordingId);
    }
  } catch {
    /* best-effort */
  }
  try {
    const stashes = await stashStorage.getStashedSessions();
    for (const s of stashes) {
      for (const slot of s.slots) {
        if (slot.durable?.recordingId) stashRecordingIds.add(slot.durable.recordingId);
      }
    }
  } catch {
    /* best-effort */
  }

  // Stash-mid-crash reconcile: a draft whose recordingId is also stash-referenced
  // (stash metadata written, draft not yet deleted) must surface once. The stash
  // owns the audio post-commit, so delete the orphaned draft.
  for (const d of drafts) {
    const rid = d.durable?.recordingId;
    if (rid && stashRecordingIds.has(rid)) {
      await draftStorage.deleteDraft(d.slotId).catch(() => {});
      draftRecordingIds.delete(rid);
    }
  }

  const { offer, selfHeal: toHeal } = selectRecoverableSessions({
    manifests,
    draftRecordingIds,
    stashRecordingIds,
  });

  for (const m of toHeal) {
    await selfHeal(userId, m);
  }

  if (toHeal.length > 0 || offer.length > 0) {
    breadcrumb('record', 'durable_recovery_scan', {
      offered: offer.length,
      self_healed: toHeal.length,
    });
  }

  return offer.slice(0, MAX_OFFERED);
}

/**
 * Fire-and-forget launch runner: runs scanDurableRecoveries under a Rule 24
 * watchdog, pushes the offer list to the observable store, and emits the
 * availability event. Never throws; a stall resolves the watchdog and leaves the
 * offer list empty rather than blocking the recovery badge.
 */
// Monotonic scan generation. Each scan captures the generation at launch; a later
// sign-in (which starts a new scan) or a sign-out (invalidateDurableRecoveries)
// bumps it, so an in-flight scan that resolves AFTER a sign-out or fast user switch
// on a shared tablet never writes the previous user's offers into the global store.
let scanGeneration = 0;

/** Invalidate any in-flight recovery scan so it won't publish after sign-out. */
export function invalidateDurableRecoveries(): void {
  scanGeneration++;
}

export async function runDurableRecoveryScan(userId: string): Promise<void> {
  const myGeneration = ++scanGeneration;
  const publish = (offer: DurableRecordingManifest[]): void => {
    // Only the newest scan may write the store; a stale scan (superseded by a
    // sign-out or a newer scan) drops its result.
    if (myGeneration !== scanGeneration) return;
    durableRecoveryStore.set(offer);
  };
  let settled = false;
  const watchdog = new Promise<DurableRecordingManifest[]>((resolve) => {
    setTimeout(() => {
      if (!settled) {
        captureMessage('durable_recovery_scan_watchdog', 'warning', { tags: { phase: 'record' } });
        resolve([]);
      }
    }, SCAN_WATCHDOG_MS);
  });
  try {
    const offer = await Promise.race([scanDurableRecoveries(userId), watchdog]);
    settled = true;
    publish(offer);
    if (offer.length > 0 && myGeneration === scanGeneration) {
      trackEvent({ name: 'durable_recovery_available', props: { count: offer.length } });
    }
  } catch {
    settled = true;
    publish([]);
  }
}


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
import { durableReconcileHold } from './reconcileHold';
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

/**
 * When THIS process started. Any active-capture pointer with an earlier
 * `startedAt` was written by a process that never got to clear it — i.e. the OS
 * killed us. Entries at or after this instant belong to the live process (a
 * sign-in mid-session re-runs the scan) and must never be reported as a kill.
 */
const PROCESS_START_ISO = new Date().toISOString();
/**
 * Users whose kill signal this process has already reported.
 *
 * Per-USER, not per-process: on a shared clinic tablet vet A signs in, their
 * kill is reported, then vet B signs in — a process-global flag would silently
 * suppress B's report for the rest of the session, which is exactly the fleet
 * this detector exists for. Still capped per user so a scan re-run (sign-in
 * mid-session) cannot double-report.
 */
const killSignalReportedUsers = new Set<string>();
/** No manifests could be enumerated — nothing is recoverable from this kill. */
const EMPTY_MANIFEST_IDS: ReadonlySet<string> = new Set<string>();

/**
 * True once this launch has proven a prior process died mid-capture FOR THIS
 * USER. Read by the Record screen so the battery-optimization nudge can state
 * what actually happened instead of speculating.
 *
 * User-scoped for the same reason the report itself is: on a shared clinic
 * tablet a process-wide answer would tell vet B that "Android stopped Captivet
 * during your last recording" when the kill was vet A's. Never resets within a
 * process.
 */
export function priorProcessKillDetected(userId: string | null | undefined): boolean {
  return !!userId && killSignalReportedUsers.has(userId);
}

/**
 * Detect and report "a prior process died while capturing".
 *
 * This is the only signal we have for an OS process kill: an LMK / battery-
 * optimizer / app-sleep kill raises no JS exception and no native signal, so
 * Sentry records nothing at all. A capture pointer that outlived its process is
 * the proof, because every clean stop, discard and purge clears it.
 *
 * Reported entries are cleared afterwards so the same kill is not re-reported on
 * every subsequent launch. Clearing is safe: recovery is driven by native
 * manifests, never by this pointer.
 *
 * Never throws — this runs before the recovery work that actually saves audio.
 */
async function reportPriorProcessKill(
  userId: string,
  manifestIds: ReadonlySet<string>,
  isCancelled: () => boolean,
): Promise<void> {
  if (killSignalReportedUsers.has(userId)) return;
  try {
    const entries = await durableActiveStore.list();
    // Re-verify scope AFTER the await. This read can straddle a sign-out: the
    // store (and the analytics identity) may now belong to a different user, in
    // which case `entries` describes whoever the store is scoped to now, not the
    // user this scan was launched for. Attributing one vet's lost recording to
    // another — and clearing the wrong pointers — is worse than not reporting.
    if (isCancelled() || durableActiveStore.getUserId() !== userId) return;
    const stale = entries.filter((e) => typeof e.startedAt === 'string' && e.startedAt < PROCESS_START_ISO);
    if (stale.length === 0) return;
    killSignalReportedUsers.add(userId);

    let durable = 0;
    let expo = 0;
    // Recoverable = a durable pointer from THIS kill that still has a manifest
    // to rebuild from. The total manifest count is not that number: it also
    // holds finished recordings already surfaced as drafts or stashes, uploaded
    // ones awaiting self-heal, and sessions that will be suppressed from the
    // offer list — so one stale expo pointer could otherwise report "recovered
    // many", making the loss telemetry unusable. Expo pointers never have a
    // manifest, which is the whole reason their loss is unrecoverable.
    let recovered = 0;
    for (const e of stale) {
      if (e.backend === 'expo') {
        expo++;
      } else {
        durable++;
        if (manifestIds.has(e.recordingId)) recovered++;
      }
    }

    trackEvent({
      name: 'process_killed_mid_capture',
      props: { durable_count: durable, expo_count: expo, recovered_count: recovered },
    });
    // Sentry sees no crash for an OS kill, so this message is the only trace.
    // Counts only — no ids, no slot ids, no paths.
    captureMessage('process_killed_mid_capture', 'warning', {
      tags: { phase: 'record' },
      extra: { durable_count: durable, expo_count: expo, recovered_count: recovered },
    });

    for (const e of stale) {
      // Checked every iteration: a sign-out mid-loop must not delete the next
      // user's pointers. clearActive itself binds the scope at call time, so a
      // switch between check and call is still safe.
      if (isCancelled() || durableActiveStore.getUserId() !== userId) return;
      await durableActiveStore.clearActive(e.recordingId).catch(() => {});
    }
  } catch {
    // Never let the kill probe block recovery.
  }
}

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

/**
 * Tombstone a recordingId, retrying once, and report a miss rather than
 * swallowing it.
 *
 * `durableTombstone.add()` fails closed — it returns false when the existing
 * list could not be read or the rewrite was rejected — so ignoring the result
 * would silently drop the guard that stops `cleanupOrphaned` deleting an
 * already-uploaded server row. The post-purge call site is the one that cannot
 * self-heal on the next launch (its manifest is already gone), so the failure
 * has to be visible in Sentry. No id in the payload: the rate-limit channel key
 * must stay coarse, and the stage alone identifies the path.
 */
async function tombstoneOrReport(recordingId: string, stage: 'draft_unverified' | 'post_purge') {
  let ok = await durableTombstone.add(recordingId).catch(() => false);
  if (!ok) ok = await durableTombstone.add(recordingId).catch(() => false);
  if (!ok) {
    breadcrumb('record', 'durable_tombstone_write_failed', { stage });
    captureMessage('durable_tombstone_write_failed', 'warning', {
      tags: { phase: 'record', stage },
    });
  }
  return ok;
}

/** Delete a confirmed-uploaded manifest's local footprint in the load-bearing order. */
async function selfHeal(userId: string, manifest: DurableRecordingManifest): Promise<void> {
  const recordingId = manifest.recordingId;
  // 1. Delete the linked finished draft + its local audio FIRST, so
  //    cleanupOrphaned never sees an orphaned draft with a missing manifest.
  //    draftStorage.deleteDraft() is best-effort and SWALLOWS its own
  //    SecureStore/Keystore failures (resolves without throwing), so a bare
  //    try/catch can't tell whether the metadata was actually removed. VERIFY
  //    via getDraft — mirroring the submit-path confirmDraftGone (record.tsx) —
  //    otherwise a Keystore failure would fall through and purgeAfterUpload()
  //    would delete the only local audio.aac while Home still shows a stale
  //    "Not Submitted" card for the already-confirmed recording.
  const confirmDraftGone = async (): Promise<boolean> => {
    try {
      await draftStorage.deleteDraft(manifest.slotId);
      await recoveryIntent.clearForDraftSlot(manifest.slotId);
    } catch {
      return false;
    }
    const still = await draftStorage.getDraft(manifest.slotId).catch(() => null);
    return still === null;
  };
  // Retry once — most deleteDraft failures are a transient SecureStore/Keystore
  // hiccup. Residual edge: a TOTAL Keystore failure fails the write AND makes
  // getDraft return null (read also swallows to null), so confirmDraftGone can
  // read as `true` and we purge. That is bounded — the manifest is confirmed-
  // uploaded (audio is on the server), step 3 tombstones the row, and
  // cleanupOrphaned + loadDraft's tombstone guard self-heal the stale card on the
  // next healthy launch — so this is acceptable rather than fully preventable
  // (getDraft cannot distinguish "gone" from "unreadable").
  let draftDeleted = await confirmDraftGone();
  if (!draftDeleted) draftDeleted = await confirmDraftGone();
  if (!draftDeleted) {
    // Draft delete unverified — leave the uploaded manifest for the next-launch
    // retry (purge is idempotent) but STILL tombstone so an offline
    // cleanupOrphaned never deletes the just-uploaded server row (loadDraft's
    // tombstone guard also blocks a resume-then-resubmit until the sweep runs).
    await tombstoneOrReport(recordingId, 'draft_unverified');
    return;
  }
  // 2. Purge the manifest/audio only after the draft delete is VERIFIED gone.
  try {
    await durableRecorder.purgeAfterUpload({ userId, recordingId });
  } catch {
    /* idempotent — next launch retries */
  }
  // 3. Tombstone so cleanupOrphaned skips deleting the uploaded server row.
  await tombstoneOrReport(recordingId, 'post_purge');
  await durableActiveStore.clearActive(recordingId).catch(() => {});
}

export async function scanDurableRecoveries(
  userId: string,
  // True once this scan has been superseded by a sign-out / newer scan. The scan
  // sets module-global user scopes (tombstone/activeStore) and calls draftStorage
  // (globally scoped to the CURRENT signed-in user), so a stale scan resuming past
  // the watchdog after a fast user switch could delete/tombstone the NEXT user's
  // data. Bail before every mutating side effect, not just before publishing.
  isCancelled: () => boolean = () => false,
): Promise<DurableRecordingManifest[]> {
  if (!isValidDurableId(userId)) return [];
  durableTombstone.setUserId(userId);
  durableReconcileHold.setUserId(userId);
  durableActiveStore.setUserId(userId);

  let manifests: DurableRecordingManifest[];
  try {
    manifests = await durableRecorder.listRecoverableSessions(userId);
  } catch {
    // Native enumeration failed, but the kill signal lives in SecureStore and is
    // still readable — report it before bailing.
    if (!isCancelled()) await reportPriorProcessKill(userId, EMPTY_MANIFEST_IDS, isCancelled);
    return [];
  }
  if (!manifests || manifests.length === 0) {
    // No recoverable capture does NOT mean a clean prior exit. The expo fallback
    // leaves no manifest at all, so this is exactly the unrecoverable-loss case
    // the kill probe exists to catch. Reporting also clears the stale pointer.
    if (!isCancelled()) await reportPriorProcessKill(userId, EMPTY_MANIFEST_IDS, isCancelled);
    return [];
  }
  // The probe READS AND CLEARS activeStore, so it is a mutating side effect and
  // is bound by this scan's cancellation contract like every other one. A stale
  // scan resuming past the watchdog after a sign-out would otherwise read, report
  // and clear the NEXT user's pointers — labelling the event with this user's
  // manifest count, and (because killSignalReported is process-global) stopping
  // the new user's own scan from ever reporting it.
  if (isCancelled()) return [];
  await reportPriorProcessKill(userId, new Set(manifests.map((m) => m.recordingId)), isCancelled);

  // Reconcile created-but-unconfirmed recordings against the server BEFORE
  // selection: if already confirmed-uploaded, mark uploaded so it self-heals and
  // is never re-offered.
  for (const m of manifests) {
    if (isCancelled()) return [];
    if (!needsServerReconcile(m) || !m.serverRecordingId) continue;
    const uploaded = await serverStatusIsUploaded(m.serverRecordingId);
    if (isCancelled()) return [];
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
      if (isCancelled()) return [];
      await draftStorage.deleteDraft(d.slotId).catch(() => {});
      draftRecordingIds.delete(rid);
    }
  }

  // Tombstoned recordingIds are confirmed-uploaded even if their manifest missed
  // the 'uploaded' marker (markUploaded failed). Collect them so the selector
  // purges rather than offers — a below-marker manifest with a deleted draft has
  // no other suppressor.
  const tombstonedRecordingIds = new Set<string>();
  for (const m of manifests) {
    if (await durableTombstone.has(m.recordingId).catch(() => false)) {
      tombstonedRecordingIds.add(m.recordingId);
    }
  }

  // FAIL CLOSED on an unreadable hold list. Self-heal DELETES a draft and
  // purges audio, and an empty set would say "nothing is held" — so one
  // transient Keystore failure would destroy every retained copy at once. When
  // membership is unknown, skip the destructive half entirely and let a later
  // scan do it; the offers below are unaffected, and nothing is lost by waiting.
  const heldRead = await durableReconcileHold
    .listStrict()
    .catch(() => ({ known: false }) as const);
  const holdsKnown = heldRead.known;
  const heldRecordingIds = new Set(holdsKnown ? heldRead.list : []);

  const { offer, selfHeal: toHeal } = selectRecoverableSessions({
    manifests,
    draftRecordingIds,
    stashRecordingIds,
    tombstonedRecordingIds,
    heldRecordingIds,
  });

  if (holdsKnown) {
    for (const m of toHeal) {
      if (isCancelled()) return [];
      await selfHeal(userId, m);
    }
  } else if (toHeal.length > 0) {
    breadcrumb('record', 'durable_recovery_selfheal_deferred', {
      count: toHeal.length,
      reason: 'reconcile_holds_unreadable',
    });
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
    const offer = await Promise.race([
      scanDurableRecoveries(userId, () => myGeneration !== scanGeneration),
      watchdog,
    ]);
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


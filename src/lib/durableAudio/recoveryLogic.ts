/**
 * Pure decision logic for the launch durable-recovery scan. No expo / RN imports
 * so it is unit-testable. The expo-coupled orchestration (native bridge calls,
 * draft/stash reads, self-heal IO) lives in ./durableRecovery and feeds these
 * pure selectors the raw manifests + reference sets.
 */
import {
  isConfirmedUploaded,
  shouldOfferRecovery,
  type DurableRecordingManifest,
} from './manifest';

export interface RecoverySelectionInput {
  manifests: DurableRecordingManifest[];
  /** Durable recordingIds already referenced by a finished/amber draft card. */
  draftRecordingIds: ReadonlySet<string>;
  /** Durable recordingIds already referenced by a stash (Saved Session). */
  stashRecordingIds: ReadonlySet<string>;
  /**
   * Durable recordingIds recorded as confirmed-uploaded (tombstoned). A manifest
   * whose markUploaded() write failed still reads as un-uploaded on disk, so
   * without this it would be OFFERED as unsent even though its server row is
   * already confirmed. Route these to self-heal (purge), never offer.
   */
  tombstonedRecordingIds?: ReadonlySet<string>;
  /**
   * Durable recordingIds confirmed-uploaded but deliberately RETAINED because
   * the server row's identity metadata diverged and a human has not yet said
   * which visit it belongs to. The confirmed-uploaded branch below runs before
   * draft suppression, so without this the next launch would self-heal exactly
   * the copy the reconciliation card promised to keep — for a vet who merely
   * closed the app before deciding. Suppress instead: neither offered (the
   * draft still owns it) nor purged.
   */
  heldRecordingIds?: ReadonlySet<string>;
}

export interface RecoverySelection {
  /** Surface as standalone recovery cards, sorted by updatedAt desc. */
  offer: DurableRecordingManifest[];
  /** Confirmed-uploaded but still on disk -> self-heal (delete draft, purge). */
  selfHeal: DurableRecordingManifest[];
  /** Recoverable but already shown via an existing draft/stash card. */
  suppressed: DurableRecordingManifest[];
}

/** ISO timestamps sort lexicographically; fall back to 0 for missing values. */
export function compareByUpdatedAtDesc(
  a: DurableRecordingManifest,
  b: DurableRecordingManifest,
): number {
  const av = typeof a.updatedAt === 'string' ? a.updatedAt : '';
  const bv = typeof b.updatedAt === 'string' ? b.updatedAt : '';
  if (av === bv) return 0;
  return av > bv ? -1 : 1;
}

/**
 * A recovered recording that already reached draft-create or an in-flight
 * confirm (has serverRecordingId) but is NOT confirmed-uploaded must reconcile
 * against the server before re-offer/re-submit. Excludes on confirmedUploadAt,
 * never on serverRecordingId alone.
 */
export function needsServerReconcile(manifest: DurableRecordingManifest): boolean {
  if (isConfirmedUploaded(manifest)) return false;
  return typeof manifest.serverRecordingId === 'string' && manifest.serverRecordingId.length > 0;
}

/**
 * Partition manifests into offer / selfHeal / suppressed. Suppression key is the
 * durable recordingId across BOTH drafts and stashes — critical because the
 * stash flow deletes the slot's draft ("stash owns audio"), so the draft alone
 * cannot suppress a stashed durable recording; the stash reference must, or the
 * recording is re-offered and two slots land on the same on-disk file.
 */
export function selectRecoverableSessions(input: RecoverySelectionInput): RecoverySelection {
  const offer: DurableRecordingManifest[] = [];
  const selfHeal: DurableRecordingManifest[] = [];
  const suppressed: DurableRecordingManifest[] = [];

  const tombstoned = input.tombstonedRecordingIds ?? new Set<string>();
  const held = input.heldRecordingIds ?? new Set<string>();
  for (const manifest of input.manifests) {
    // Checked BEFORE both terminal branches: a held recording is uploaded, and
    // may also be tombstoned by a later action, but until the conflict is
    // resolved its local footprint must survive.
    if (held.has(manifest.recordingId)) {
      const ownedLocally =
        input.draftRecordingIds.has(manifest.recordingId) ||
        input.stashRecordingIds.has(manifest.recordingId);
      if (ownedLocally) {
        // A draft or stash owns it, so the reconciliation card is reachable
        // through that. Neither offer it (two surfaces on one file) nor purge.
        suppressed.push(manifest);
      } else if (manifest.adtsFrameCount > 0) {
        // Nothing owns it — the draft save failed, or the process died before
        // background persistence ran. Suppressing here too would leave the
        // audio on disk and permanently unreachable: the hold is surfaced
        // nowhere else. OFFER it instead, which is the vet's only route back to
        // a recording we promised to keep. `shouldOfferRecovery` would refuse
        // (it excludes confirmed-uploaded manifests), and that exclusion is
        // right for every case except this one — a re-submit is safe here
        // anyway, since the deterministic `durable-${recordingId}` key promotes
        // the same server row rather than creating a second.
        offer.push(manifest);
      } else {
        suppressed.push(manifest); // zero frames: nothing to recover
      }
      continue;
    }
    if (isConfirmedUploaded(manifest)) {
      // Still on disk after a confirmed upload -> self-heal (purge), never offer.
      selfHeal.push(manifest);
      continue;
    }
    if (tombstoned.has(manifest.recordingId)) {
      // Tombstoned = already confirmed-uploaded (even if this manifest missed its
      // 'uploaded' marker because markUploaded failed). Purge it, never offer —
      // otherwise a re-submit would target the already-confirmed server row.
      selfHeal.push(manifest);
      continue;
    }
    if (!shouldOfferRecovery(manifest)) continue; // idle / zero-frame -> nothing to recover
    const id = manifest.recordingId;
    if (input.draftRecordingIds.has(id) || input.stashRecordingIds.has(id)) {
      suppressed.push(manifest);
      continue;
    }
    offer.push(manifest);
  }

  offer.sort(compareByUpdatedAtDesc);
  return { offer, selfHeal, suppressed };
}

/** One stale "was capturing at last exit" pointer, as the probe reads it. */
export interface UncleanExitPointer {
  recordingId: string;
  /** Absent means durable — legacy entries predate the field. */
  backend?: string;
}

export interface UncleanExitCounts {
  /** Durable captures from the prior process with no proof they survived. */
  durable: number;
  /** Expo-fallback captures. Never have a manifest, so never recoverable. */
  expo: number;
  /** Subset of `durable` that still has a manifest to rebuild from. */
  recovered: number;
  /** Tombstoned — confirmed uploaded then purged. Not a loss at all. */
  uploaded: number;
}

/**
 * Classify the stale capture pointers found at launch.
 *
 * Extracted from the probe so it can be tested by EXECUTION: the probe itself
 * pulls the native recorder bridge and the recordings API, so every fence on it
 * has to be a source regex, and this counting is exactly the part that was
 * wrong.
 *
 * The bug it fixes: a successful upload PURGES its manifest, so an uploaded
 * recording's id can never be in `manifestIds`. Counting it as `durable` with
 * `recovered` unchanged made a perfect submit indistinguishable from lost audio,
 * and `recovered_count: 0` unusable as a reliability metric. The tombstone is
 * the record of "confirmed uploaded, then purged", so it is consulted first.
 */
export function classifyUncleanExitPointers(input: {
  stale: readonly UncleanExitPointer[];
  manifestIds: ReadonlySet<string>;
  tombstonedRecordingIds: ReadonlySet<string>;
}): UncleanExitCounts {
  const counts: UncleanExitCounts = { durable: 0, expo: 0, recovered: 0, uploaded: 0 };
  for (const entry of input.stale) {
    if (entry.backend === 'expo') {
      counts.expo++;
    } else if (input.tombstonedRecordingIds.has(entry.recordingId)) {
      counts.uploaded++;
    } else {
      counts.durable++;
      if (input.manifestIds.has(entry.recordingId)) counts.recovered++;
    }
  }
  return counts;
}

/**
 * True when the stale pointers are worth reporting as an unclean exit.
 *
 * All-uploaded means every pointer was a leftover from a successful submit:
 * nothing ended uncleanly, so reporting would be a pure false positive and
 * would additionally arm the battery-optimization nudge for an interruption
 * that never happened. Pruning them is still the right thing to do.
 */
export function uncleanExitIsReportable(counts: UncleanExitCounts): boolean {
  return counts.durable > 0 || counts.expo > 0;
}

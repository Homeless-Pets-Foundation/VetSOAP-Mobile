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
      suppressed.push(manifest);
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

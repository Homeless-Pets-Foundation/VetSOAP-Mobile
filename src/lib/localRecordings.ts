import { draftStorage, durableManifestHasCompleteAudio, type DurableManifestSnapshot } from './draftStorage';
import { stashStorage } from './stashStorage';
import { countUnsentStashSessions } from './unsentCount';
import { fileExistsStrict } from './fileOps';
import { clonePendingConfirm } from './pendingConfirm';
import { withPromiseTimeout } from './promiseTimeout';
import type { StrictExistence } from './strictRead';
import type { StashedSlot } from '../types/stash';
import type { DurableRecordingManifest } from './durableAudio/manifest';
import type { User } from '../types';

/**
 * Count un-sent recordings on this device for the current user: local drafts
 * with audio segments, plus stashed sessions. Best-effort: any failure returns
 * the partial count and never blocks sign-out or account-deletion UX. Assumes
 * draft/stash user scoping is already set by AuthProvider.fetchUser().
 *
 * This remains the ACTIVE-SCOPE best-effort sum used by the destructive
 * sign-out / delete-account warnings. Navigation and the attention feed use
 * `getUnsentWorkSummary()` below, which reports each source separately and can
 * say "I could not check", because a swallowed failure would read as all-clear.
 */
export async function countUnsentRecordings(): Promise<number> {
  let drafts = 0;
  try {
    const list = await draftStorage.listDrafts();
    const hasAudio = await Promise.all(list.map((meta) => draftStorage.draftHasLocalAudio(meta)));
    drafts = hasAudio.filter(Boolean).length;
  } catch {
    // best-effort
  }

  let stashes = 0;
  try {
    const sessions = await stashStorage.getStashedSessions();
    // Count resumed stashes too — a resumed-but-unsubmitted session is unsent
    // work that nothing else represents (finding O6). See countUnsentStashSessions.
    stashes = countUnsentStashSessions(sessions);
  } catch {
    // best-effort
  }

  return drafts + stashes;
}

/** One named hard limit per local source (rule 24 — bound every native read). */
export const LOCAL_ATTENTION_READ_TIMEOUT_MS = 8_000;

export interface UnsentWorkSummary {
  draftCount: number;
  stashSessionCount: number;
  /** False when the source could not be READ — never a false zero. */
  draftsKnown: boolean;
  stashesKnown: boolean;
}

const UNKNOWN_SUMMARY: UnsentWorkSummary = {
  draftCount: 0,
  stashSessionCount: 0,
  draftsKnown: false,
  stashesKnown: false,
};

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * One bounded, consistent snapshot of the signed-in user's native durable
 * manifests, indexed by durable recordingId. `null` = the bridge is
 * unavailable/ambiguous, which callers treat as UNKNOWN — never as "no durable
 * audio". Lazy-required (rule 19) so an old dev client without the native
 * module degrades instead of crashing at import.
 */
async function loadDurableManifestSnapshot(userId: string): Promise<DurableManifestSnapshot> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const durableRecorder = require('../../modules/captivet-durable-recorder') as {
      isAvailable?: () => boolean;
      listRecoverableSessions: (userId: string) => Promise<DurableRecordingManifest[]>;
    };
    if (typeof durableRecorder.isAvailable === 'function' && !durableRecorder.isAvailable()) {
      return null;
    }
    const manifests = await durableRecorder.listRecoverableSessions(userId);
    if (!Array.isArray(manifests)) return null;
    const byRecordingId = new Map<string, DurableRecordingManifest>();
    for (const manifest of manifests) {
      if (manifest && typeof manifest.recordingId === 'string') {
        byRecordingId.set(manifest.recordingId, manifest);
      }
    }
    return byRecordingId;
  } catch {
    return null;
  }
}

/** Both user-scoped stores must already be bound to THIS user (rule 13). */
function scopeMatches(userId: string): boolean {
  return draftStorage.getUserId() === userId && stashStorage.getUserId() === userId;
}

async function readStrictDraftCount(userId: string): Promise<number> {
  const manifests = await loadDurableManifestSnapshot(userId);
  const drafts = await draftStorage.listDraftsForUserStrict(userId);
  let count = 0;
  for (const draft of drafts) {
    const proof = await draftStorage.draftHasLocalAudioStrict(draft, manifests);
    // An unclassifiable audio proof makes the WHOLE draft source unknown —
    // reporting a partial count as if it were complete is the false all-clear
    // this summary exists to prevent.
    if (proof === 'unknown') throw new Error('draft_audio_proof_unknown');
    if (proof === 'present') count += 1;
  }
  return count;
}

async function readStrictStashCount(userId: string): Promise<number> {
  const sessions = await stashStorage.getStashedSessionsForUserStrict(userId);
  return countUnsentStashSessions(sessions);
}

/**
 * Per-source un-sent work summary for navigation + the attention feed.
 *
 * The two sources are read CONCURRENTLY and caught INDEPENDENTLY so one failure
 * still yields a partial known result. A scope mismatch (the stores are bound
 * to another user, or auth changed mid-read) is unknown/loading — never zero.
 * Late rejections from a timed-out native read stay observed by
 * `withPromiseTimeout`, so no unhandled rejection can crash Hermes after the
 * deadline already recovered the UI.
 *
 * The counts are SOURCE-QUALIFIED: "drafts" and "saved sessions", never an
 * authoritative number of recordings. A draft carrying a `serverDraftId` can
 * describe the same underlying attempt as a server row; the device may still
 * hold the only resumable audio, so it is not suppressed.
 */
export async function getUnsentWorkSummary(userId: string): Promise<UnsentWorkSummary> {
  if (!userId || !scopeMatches(userId)) return { ...UNKNOWN_SUMMARY };

  const [draftResult, stashResult] = await Promise.allSettled([
    withPromiseTimeout(
      readStrictDraftCount(userId),
      LOCAL_ATTENTION_READ_TIMEOUT_MS,
      'unsent_work_drafts_timeout',
    ),
    withPromiseTimeout(
      readStrictStashCount(userId),
      LOCAL_ATTENTION_READ_TIMEOUT_MS,
      'unsent_work_stashes_timeout',
    ),
  ]);

  // Re-verify scope AFTER the awaits: a sign-out / user switch mid-read must
  // not publish the outgoing user's counts (shared clinic tablets).
  if (!scopeMatches(userId)) return { ...UNKNOWN_SUMMARY };

  return {
    draftCount: draftResult.status === 'fulfilled' ? draftResult.value : 0,
    stashSessionCount: stashResult.status === 'fulfilled' ? stashResult.value : 0,
    draftsKnown: draftResult.status === 'fulfilled',
    stashesKnown: stashResult.status === 'fulfilled',
  };
}

// ─── Destructive-decision anchor lookup ────────────────────────────────────

export type LocalRecoveryAnchorKind =
  | 'draft'
  | 'saved_session'
  | 'durable_recovery'
  | 'support_recovery'
  | 'none'
  | 'unknown';

export interface LocalRecoveryAnchor {
  kind: LocalRecoveryAnchorKind;
  /** Routing ids only — never emitted to analytics. */
  draftSlotId?: string;
  stashSessionId?: string;
  durableRecordingId?: string;
  vaultItemId?: string;
}

export const LOCAL_ANCHOR_LOOKUP_TIMEOUT_MS = 8_000;

type AnchorUser = Pick<User, 'id' | 'role' | 'organizationId'>;

function pendingConfirmMatches(pendingConfirm: unknown, target: string): boolean {
  const proof = clonePendingConfirm(pendingConfirm as never);
  return !!proof && normalizeId(proof.recordingId) === target;
}

function stashSlotProof(slot: StashedSlot, manifests: DurableManifestSnapshot): StrictExistence {
  if (clonePendingConfirm(slot.pendingConfirm)) return 'present';

  const recoveredUri = slot.durable?.recoveredAudioUri;
  if (recoveredUri) {
    const recovered = fileExistsStrict(recoveredUri);
    if (recovered !== 'missing') return recovered;
  }

  let sawUnknown = false;
  for (const segment of slot.segments ?? []) {
    const existence = fileExistsStrict(segment?.uri ?? '');
    if (existence === 'present') return 'present';
    if (existence === 'unknown') sawUnknown = true;
  }

  if (slot.durable?.recordingId) {
    if (!manifests) return 'unknown';
    const manifest = manifests.get(slot.durable.recordingId);
    if (durableManifestHasCompleteAudio(manifest)) return 'present';
  }

  return sawUnknown ? 'unknown' : 'missing';
}

interface AnchorSourceResult {
  match: LocalRecoveryAnchor | null;
  unknown: boolean;
}

async function findDraftAnchor(
  userId: string,
  target: string,
  manifests: DurableManifestSnapshot,
): Promise<AnchorSourceResult> {
  const drafts = await draftStorage.listDraftsForUserStrict(userId);
  let unknown = false;
  for (const draft of drafts) {
    const matches =
      normalizeId(draft.serverDraftId) === target ||
      pendingConfirmMatches(draft.pendingConfirm, target);
    if (!matches) continue;
    const proof = await draftStorage.draftHasLocalAudioStrict(draft, manifests);
    if (proof === 'present') {
      return { match: { kind: 'draft', draftSlotId: draft.slotId }, unknown: false };
    }
    if (proof === 'unknown') unknown = true;
  }
  return { match: null, unknown };
}

async function findStashAnchor(
  userId: string,
  target: string,
  manifests: DurableManifestSnapshot,
): Promise<AnchorSourceResult> {
  const sessions = await stashStorage.getStashedSessionsForUserStrict(userId);
  let unknown = false;
  for (const session of sessions) {
    for (const slot of session.slots ?? []) {
      const matches =
        normalizeId(slot.serverDraftId) === target ||
        pendingConfirmMatches(slot.pendingConfirm, target);
      if (!matches) continue;
      // Stale stash metadata alone must not block deletion, and a DIFFERENT
      // slot's audio in the same multi-patient session proves nothing about
      // this one — require a completion source for THIS slot.
      const proof = stashSlotProof(slot, manifests);
      if (proof === 'present') {
        return { match: { kind: 'saved_session', stashSessionId: session.id }, unknown: false };
      }
      if (proof === 'unknown') unknown = true;
    }
  }
  return { match: null, unknown };
}

function findDurableAnchor(
  target: string,
  manifests: DurableManifestSnapshot,
): AnchorSourceResult {
  if (!manifests) return { match: null, unknown: true };
  for (const manifest of manifests.values()) {
    const matches =
      normalizeId(manifest.serverRecordingId) === target ||
      pendingConfirmMatches(manifest.pendingConfirm, target);
    if (!matches) continue;
    if (durableManifestHasCompleteAudio(manifest)) {
      return {
        match: { kind: 'durable_recovery', durableRecordingId: manifest.recordingId },
        unknown: false,
      };
    }
  }
  return { match: null, unknown: false };
}

async function findVaultAnchor(user: AnchorUser, target: string): Promise<AnchorSourceResult> {
  // Lazy-required so the vault's expo-file-system/native surface is not pulled
  // into every consumer of this module (rule 19 discipline).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supportStaffRecoveryVault } = require('./supportStaffRecoveryVault') as
    typeof import('./supportStaffRecoveryVault');
  const snapshot = await supportStaffRecoveryVault.listItemsForUserStrict(user);
  for (const item of snapshot.items) {
    for (const slot of item.slots ?? []) {
      const matches =
        normalizeId(slot.sourceServerDraftId) === target ||
        pendingConfirmMatches(slot.pendingConfirm, target);
      if (matches) {
        return { match: { kind: 'support_recovery', vaultItemId: item.id }, unknown: false };
      }
    }
  }
  return { match: null, unknown: !snapshot.recoverabilityComplete };
}

/**
 * Read-only lookup behind the detail screen's "Delete unavailable recording"
 * guard. Answers: does THIS device, for the SIGNED-IN account, still hold a
 * recoverable copy anchored to this server recording?
 *
 * Guarantees:
 *  - never rebinds storage scope, never scans another user's private
 *    draft/stash/durable directory, never mutates or prunes recovery data;
 *  - a proven match wins immediately (it fails the destructive check safely)
 *    even when another source is unknown;
 *  - `none` requires EVERY source to complete and prove no match;
 *  - any ambiguous read with no proven match is `unknown` → fail closed.
 *
 * A `none` result is NOT proof that no recoverable copy exists on another
 * device or under another account — the caller's confirmation must say so.
 */
export async function findLocalRecoveryAnchor(
  user: AnchorUser | null | undefined,
  serverRecordingId: string,
): Promise<LocalRecoveryAnchor> {
  const userId = user?.id ?? '';
  const target = normalizeId(serverRecordingId);
  if (!userId || !target) return { kind: 'unknown' };
  if (!scopeMatches(userId)) return { kind: 'unknown' };

  // ONE hard deadline for the whole operation: every source starts inside the
  // same window, so the wall clock is bounded once rather than summing
  // per-source timeouts. `withPromiseTimeout` keeps late native rejections
  // observed after the deadline already recovered the UI.
  const startedAt = Date.now();
  const remaining = () => Math.max(1, LOCAL_ANCHOR_LOOKUP_TIMEOUT_MS - (Date.now() - startedAt));
  const bound = <T>(promise: Promise<T>, label: string): Promise<T> =>
    withPromiseTimeout(promise, remaining(), label);

  const manifests = await bound(
    loadDurableManifestSnapshot(userId),
    'anchor_durable_manifests_timeout',
  ).catch((): DurableManifestSnapshot => null);

  const [draftResult, stashResult, vaultResult] = await Promise.allSettled([
    bound(findDraftAnchor(userId, target, manifests), 'anchor_drafts_timeout'),
    bound(findStashAnchor(userId, target, manifests), 'anchor_stashes_timeout'),
    bound(findVaultAnchor(user as AnchorUser, target), 'anchor_vault_timeout'),
  ]);

  if (!scopeMatches(userId)) return { kind: 'unknown' };

  const durable = findDurableAnchor(target, manifests);
  const settled = (result: PromiseSettledResult<AnchorSourceResult>): AnchorSourceResult =>
    result.status === 'fulfilled' ? result.value : { match: null, unknown: true };

  const stash = settled(stashResult);
  const draft = settled(draftResult);
  const vault = settled(vaultResult);

  // Deterministic ownership precedence: a committed stash beats its
  // crash-window draft duplicate, a draft beats its underlying orphan manifest,
  // and the standalone durable/vault routes are used only when no indexed
  // current-user owner matches.
  const match = stash.match ?? draft.match ?? durable.match ?? vault.match;
  if (match) return match;

  const anyUnknown = stash.unknown || draft.unknown || durable.unknown || vault.unknown;
  return { kind: anyUnknown ? 'unknown' : 'none' };
}

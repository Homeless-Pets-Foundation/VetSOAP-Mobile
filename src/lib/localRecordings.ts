import { draftStorage, durableManifestAudioExistence, type DurableManifestSnapshot } from './draftStorage';
import { stashStorage } from './stashStorage';
import { countUnsentStashSessions } from './unsentCount';
import { fileExistsStrict } from './fileOps';
import { clonePendingConfirm } from './pendingConfirm';
import { withPromiseTimeout } from './promiseTimeout';
import type { StrictExistence } from './strictRead';
import type { StashedSlot } from '../types/stash';
import { validateManifestObject, type DurableRecordingManifest } from './durableAudio/manifest';
import { isValidDurableId } from './durableAudio/paths';
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
      // A string `recordingId` was the only gate, so a manifest with malformed
      // required fields — or a malformed `serverRecordingId` anchor — was indexed
      // and later reduced to `missing`/no-match. With the other sources known
      // that let findLocalRecoveryAnchor answer `none` despite recoverable
      // durable audio. One invalid entry makes the whole SNAPSHOT unknown rather
      // than silently dropping it: a partial index is indistinguishable from
      // "this recording has no durable audio".
      if (!manifest || typeof manifest.recordingId !== 'string') return null;
      if (!isValidDurableId(manifest.recordingId)) return null;
      if (!validateManifestObject(manifest).ok) return null;
      const anchor = (manifest as { serverRecordingId?: unknown }).serverRecordingId;
      if (anchor !== undefined && anchor !== null && typeof anchor !== 'string') return null;
      byRecordingId.set(manifest.recordingId, manifest);
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

/**
 * The slice of the anchor deadline the optional native durable-recorder bridge
 * may consume. Bounded so a hanging bridge cannot starve the draft/stash/vault
 * reads that must still answer within the same window.
 */
export const MANIFEST_SNAPSHOT_BUDGET_MS = LOCAL_ANCHOR_LOOKUP_TIMEOUT_MS / 2;

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
    // Tri-state: an unreadable volume is not proof that the durable audio is
    // gone, so it must not fall through to `missing`.
    const durable = durableManifestAudioExistence(manifest);
    if (durable === 'present') return 'present';
    if (durable === 'unknown') sawUnknown = true;
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
  let sawUnknown = false;
  for (const manifest of manifests.values()) {
    const matches =
      normalizeId(manifest.serverRecordingId) === target ||
      pendingConfirmMatches(manifest.pendingConfirm, target);
    if (!matches) continue;
    // A manifest that MATCHES this recording but whose audio cannot be probed is
    // the most dangerous case: reporting no-match here is what would expose the
    // destructive delete for a visit that is still recoverable on this device.
    const durable = durableManifestAudioExistence(manifest);
    if (durable === 'present') {
      return {
        match: { kind: 'durable_recovery', durableRecordingId: manifest.recordingId },
        unknown: false,
      };
    }
    if (durable === 'unknown') sawUnknown = true;
  }
  return { match: null, unknown: sawUnknown };
}

async function findVaultAnchor(user: AnchorUser, target: string): Promise<AnchorSourceResult> {
  // Lazy-required so the vault's expo-file-system/native surface is not pulled
  // into every consumer of this module (rule 19 discipline).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vaultModule = require('./supportStaffRecoveryVault') as
    typeof import('./supportStaffRecoveryVault');
  const { supportStaffRecoveryVault, vaultSlotIsRecoverableStrict } = vaultModule;
  const snapshot = await supportStaffRecoveryVault.listItemsForUserStrict(user);
  let sawUnknown = false;
  for (const item of snapshot.items) {
    for (const slot of item.slots ?? []) {
      const matches =
        normalizeId(slot.sourceServerDraftId) === target ||
        pendingConfirmMatches(slot.pendingConfirm, target);
      if (!matches) continue;
      // Prove recovery on the MATCHING slot, AS THIS VIEWER. The item-level
      // snapshot only says SOME slot is recoverable, so for a multi-slot item a
      // metadata match could otherwise block deletion (and route to recovery)
      // for a target whose own audio is gone. Passing the user also applies the
      // role rule the listing applies — a veterinarian cannot reuse another
      // user's pending-confirm token without complete local audio, so certifying
      // the token alone would promise a route the listing filters out.
      const existence = vaultSlotIsRecoverableStrict(slot, user);
      if (existence === 'present') {
        return { match: { kind: 'support_recovery', vaultItemId: item.id }, unknown: false };
      }
      if (existence === 'unknown') sawUnknown = true;
    }
  }
  return { match: null, unknown: sawUnknown || !snapshot.recoverabilityComplete };
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

  // The optional durable-recorder bridge is the one source that can hang for the
  // WHOLE window, and the draft/stash proofs need its snapshot. Awaiting it
  // first and unbounded starved every other read down to `remaining()` === 1ms,
  // so a perfectly recoverable segment-based draft or stash came back `unknown`
  // and the detail screen offered neither its recovery route nor deletion — on
  // every Recheck. Cap it at half the deadline so the dependent reads always
  // keep a meaningful slice, and run the INDEPENDENT vault read alongside it.
  // START the independent vault read, but do NOT await it here: including it in
  // the same `Promise.all` as the manifest meant a vault read that consumed the
  // whole deadline delayed the draft/stash reads to `remaining()` === 1ms, which
  // is the very starvation this restructure was meant to remove. Only the
  // manifest snapshot actually gates them.
  const vaultPromise = bound(findVaultAnchor(user as AnchorUser, target), 'anchor_vault_timeout')
    .then((value): PromiseSettledResult<AnchorSourceResult> => ({ status: 'fulfilled', value }))
    .catch((reason): PromiseSettledResult<AnchorSourceResult> => ({ status: 'rejected', reason }));

  const manifestBudget = Math.max(1, Math.min(remaining(), MANIFEST_SNAPSHOT_BUDGET_MS));
  const manifests = await withPromiseTimeout(
    loadDurableManifestSnapshot(userId),
    manifestBudget,
    'anchor_durable_manifests_timeout',
  ).catch((): DurableManifestSnapshot => null);

  // The dependent reads start as soon as the bounded snapshot settles; the vault
  // is awaited alongside them, so all three share the remaining window.
  const [draftResult, stashResult, vaultResult] = await Promise.all([
    Promise.allSettled([
      bound(findDraftAnchor(userId, target, manifests), 'anchor_drafts_timeout'),
      bound(findStashAnchor(userId, target, manifests), 'anchor_stashes_timeout'),
    ]).then(([draft, stash]) => ({ draft, stash })),
    vaultPromise,
  ]).then(([both, vault]) => [both.draft, both.stash, vault] as const);

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

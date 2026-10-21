import type { LocalRecoveryAnchor } from './localRecordings';

/**
 * Where a server `status='draft'` row's audio lives, from THIS device's point
 * of view, for the signed-in account.
 *
 * Why this exists (UI/UX audit 2026-10-21, UX-H3): Save for Later deletes the
 * slot's local draft (the stash owns the audio from then on) but deliberately
 * keeps the server draft row so Resume → Submit promotes it in place. The
 * detail screen only looked in draftStorage, so every saved-session recording
 * read as "Audio Not on This Device" beside a red Delete Draft — false, and
 * steering the vet toward deleting work that was sitting in Saved Sessions.
 *
 * Fail-safe ordering mirrors `findLocalRecoveryAnchor`: a proven on-device
 * copy always wins, an unfinished or ambiguous check is never "not on device",
 * and deletion is offered only on a proven absence.
 */
export type DraftLocation =
  /** draftStorage holds resumable audio for this row (existing resume card). */
  | { kind: 'local_draft'; draftSlotId: string }
  /** A saved session (stash) on this device holds it. */
  | { kind: 'saved_session'; stashSessionId?: string }
  /** The strict anchor scan found a draft the lenient lookup missed. */
  | { kind: 'resumable_draft'; draftSlotId?: string }
  /** Crash recovery or the support-staff vault holds it. */
  | { kind: 'recovery'; source: 'durable' | 'support' }
  /** The lenient lookup or the strict anchor scan has not finished. */
  | { kind: 'checking' }
  /** The strict anchor scan could not prove either way. */
  | { kind: 'unknown' }
  /** Every local source completed and proved there is no copy here. */
  | { kind: 'not_on_device' };

export interface DraftLocationInput {
  /** The lenient draftStorage lookup has completed. */
  draftResolved: boolean;
  /** Slot id from the lenient lookup when it found resumable audio. */
  draftLocalSlotId: string | null;
  /** Strict on-device anchor; null while it is still loading. */
  anchor: LocalRecoveryAnchor | null;
}

export function classifyServerDraftLocation(input: DraftLocationInput): DraftLocation {
  if (input.draftLocalSlotId) {
    return { kind: 'local_draft', draftSlotId: input.draftLocalSlotId };
  }
  if (!input.draftResolved || !input.anchor) return { kind: 'checking' };

  switch (input.anchor.kind) {
    case 'saved_session':
      return { kind: 'saved_session', stashSessionId: input.anchor.stashSessionId };
    case 'draft':
      return { kind: 'resumable_draft', draftSlotId: input.anchor.draftSlotId };
    case 'durable_recovery':
      return { kind: 'recovery', source: 'durable' };
    case 'support_recovery':
      return { kind: 'recovery', source: 'support' };
    case 'none':
      return { kind: 'not_on_device' };
    default:
      return { kind: 'unknown' };
  }
}

/**
 * Whether the detail screen may offer Delete Draft. `local_draft` keeps its
 * existing secondary delete (the mutation purges the matching local draft);
 * `not_on_device` is the proven-absence case. Every other location either
 * holds the audio somewhere this screen cannot clean up, or is unproven.
 */
export function draftLocationAllowsDelete(location: DraftLocation): boolean {
  return location.kind === 'local_draft' || location.kind === 'not_on_device';
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const hasOwn = (map: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

interface StashedSlotLike {
  serverDraftId?: string | null;
}

interface StashedSessionLike {
  id: string;
  slots?: StashedSlotLike[] | null;
}

/**
 * Server draft ids held by saved sessions → the session id holding them, keyed
 * by normalized id. Labels and routing only — a lenient read that misses a
 * stash leaves the card on its old "Not on this device" path, and the detail
 * screen's strict anchor check still governs any destructive action.
 */
export function buildSavedSessionDraftMap(
  sessions: readonly StashedSessionLike[] | null | undefined
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const session of sessions ?? []) {
    for (const slot of session?.slots ?? []) {
      const key = normalizeId(slot?.serverDraftId);
      if (key && !hasOwn(map, key)) map[key] = session.id;
    }
  }
  return map;
}

export function savedSessionIdForDraft(
  map: Record<string, string>,
  recordingId: string | null | undefined
): string | undefined {
  // Own keys only: an inherited name ("constructor") must never read as a hit.
  const key = normalizeId(recordingId);
  return key && hasOwn(map, key) ? map[key] : undefined;
}

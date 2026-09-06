import type { RecordingStatus } from '../types';

/**
 * The one status pill in Home's "Recent Recordings" header.
 *
 * Replaces the two stat tiles ("3074 Total Recordings" / "✓ All Complete") that
 * could read as a contradiction: `failed` was never counted, so a green check
 * rendered beside two "could not be processed" rows in the attention block
 * (home layout audit, 2026-09-02). Precedence is worst-first so the pill can
 * never claim a clean state while anything listed still needs a person.
 *
 * The pill describes A LIST, so it returns null when there is no list to
 * describe — an account with no recordings and no drafts is not "all complete",
 * it is empty, and a green badge above "Your patients are waiting." is a claim
 * about nothing. The CALLER still owns whether the list is KNOWN: a failed fetch
 * with no cache reaches here as an empty array, indistinguishable from a genuine
 * zero, so Home hides the pill on that branch the same way it hides the list.
 *
 * Pure and RN-free so it runs under `tests/helpers/loadTs.mjs`.
 */
export type RecentStatusPillKind =
  | 'failed'
  | 'needs_details'
  | 'processing'
  | 'not_submitted'
  | 'all_complete';

export interface RecentStatusPill {
  kind: RecentStatusPillKind;
  count: number;
  variant: 'danger' | 'warning' | 'success';
}

/**
 * Statuses that are not "in flight". Drafts are counted by `draftCount`, never
 * here, and `pending_metadata` gets its own kind: it renders as "Awaiting
 * Details" and is blocked on the vet's own input, so counting it as "processing"
 * told them to wait for work that would never advance on its own.
 */
const SETTLED_STATUSES: ReadonlySet<RecordingStatus> = new Set<RecordingStatus>([
  'completed',
  'failed',
  'draft',
  'pending_metadata',
]);

export function deriveRecentStatusPill({
  recordings,
  draftCount,
}: {
  recordings: readonly { status: RecordingStatus }[];
  draftCount: number;
}): RecentStatusPill | null {
  if (recordings.length === 0 && draftCount === 0) return null;

  let failed = 0;
  let needsDetails = 0;
  let processing = 0;
  for (const recording of recordings) {
    if (recording.status === 'failed') failed += 1;
    else if (recording.status === 'pending_metadata') needsDetails += 1;
    else if (!SETTLED_STATUSES.has(recording.status)) processing += 1;
  }
  if (failed > 0) return { kind: 'failed', count: failed, variant: 'danger' };
  // Above `processing`: awaiting-details needs a person, processing needs nobody.
  if (needsDetails > 0) return { kind: 'needs_details', count: needsDetails, variant: 'warning' };
  if (processing > 0) return { kind: 'processing', count: processing, variant: 'warning' };
  if (draftCount > 0) return { kind: 'not_submitted', count: draftCount, variant: 'warning' };
  return { kind: 'all_complete', count: 0, variant: 'success' };
}

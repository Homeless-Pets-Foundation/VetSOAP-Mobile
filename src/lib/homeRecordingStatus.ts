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
 * Pure and RN-free so it runs under `tests/helpers/loadTs.mjs`.
 */
export type RecentStatusPillKind = 'failed' | 'processing' | 'not_submitted' | 'all_complete';

export interface RecentStatusPill {
  kind: RecentStatusPillKind;
  count: number;
  variant: 'danger' | 'warning' | 'success';
}

/** Statuses that are not "in flight". Drafts are counted by `draftCount`, never here. */
const SETTLED_STATUSES: ReadonlySet<RecordingStatus> = new Set<RecordingStatus>([
  'completed',
  'failed',
  'draft',
]);

export function deriveRecentStatusPill({
  recordings,
  draftCount,
}: {
  recordings: readonly { status: RecordingStatus }[];
  draftCount: number;
}): RecentStatusPill {
  let failed = 0;
  let processing = 0;
  for (const recording of recordings) {
    if (recording.status === 'failed') failed += 1;
    else if (!SETTLED_STATUSES.has(recording.status)) processing += 1;
  }
  if (failed > 0) return { kind: 'failed', count: failed, variant: 'danger' };
  if (processing > 0) return { kind: 'processing', count: processing, variant: 'warning' };
  if (draftCount > 0) return { kind: 'not_submitted', count: draftCount, variant: 'warning' };
  return { kind: 'all_complete', count: 0, variant: 'success' };
}

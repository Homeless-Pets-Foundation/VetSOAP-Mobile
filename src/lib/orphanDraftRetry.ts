/**
 * In-memory retention of orphan server-draft ids whose best-effort cleanup
 * failed transiently (offline, timeout, device-session 428). A
 * 'no_local_meta' orphan has no surviving local draft, so a dropped id can
 * never be rediscovered by the pending-sync or local orphan sweeps — retain
 * it per user until the next pending-draft sync retries the delete.
 *
 * Deliberately memory-only: cleanup is best-effort, the ids carry no PHI,
 * and a process restart merely forfeits one retry opportunity — it never
 * affects correctness (the server row simply waits for the next occasion).
 */
const pendingByUser = new Map<string, Set<string>>();

export function rememberOrphanDraftId(userId: string, recordingId: string): void {
  const set = pendingByUser.get(userId) ?? new Set<string>();
  set.add(recordingId);
  pendingByUser.set(userId, set);
}

/** Drain the retained ids for a user; callers re-remember any that fail again. */
export function takeOrphanDraftIds(userId: string): string[] {
  const set = pendingByUser.get(userId);
  if (!set || set.size === 0) return [];
  pendingByUser.delete(userId);
  return [...set];
}

import type { StashedSession } from '../types/stash';

/**
 * Number of stashed sessions that represent un-sent work on this device.
 *
 * A stashed session counts as un-sent even after it has been RESUMED. Tapping
 * "Resume Session" sets `resumedAt` immediately (`useStashedSessions.markResumed`),
 * but the resumed work is not yet submitted — and its local draft was already
 * deleted when the session was stashed (`stashSession` → `draftStorage.deleteDraft`)
 * and is NOT recreated on resume. So a resumed-but-unsubmitted stash is represented
 * by neither a counted draft nor (previously) a counted stash, which made the
 * sign-out / delete-account warning under-report unsent work (finding O6: a stash
 * was present yet the count came back 0, showing a generic "Are you sure?" with no
 * count).
 *
 * Counting all present sessions does not persistently over-warn: a resumed stash is
 * released (removed) on submit / discard / re-stash, and any stale `resumedAt` is
 * reset on the next app launch. The only over-count is the rare
 * resume → continue-recording → finish path (a fresh draft can briefly coexist with
 * the still-resumed stash), which is harmless for a "you have N unsent recordings"
 * warning. Under-reporting (the O6 bug) is the failure mode that actually matters.
 */
export function countUnsentStashSessions(sessions: StashedSession[]): number {
  return sessions.length;
}

function slotCarriesAudio(slot: StashedSession['slots'][number] | null | undefined): boolean {
  if (!slot) return false;
  if (Array.isArray(slot.segments) && slot.segments.length > 0) return true;
  if (slot.durable?.recordingId) return true;
  return !!slot.pendingConfirm;
}

/**
 * Number of un-sent RECORDINGS (patient slots) held by saved sessions — the
 * unit the sign-out / delete-account warning speaks in ("You have N
 * recordings…"). `countUnsentStashSessions` counted a 4-patient saved session
 * as 1 recording (UI/UX audit 2026-10-21, UX-H7).
 *
 * Each slot with audio evidence (segments, a durable pointer, or a pending
 * confirmation) counts once. A session with no slot that proves audio still
 * counts 1: this is a warning, and under-reporting is the failure that matters
 * (finding O6) — a torn or legacy stash must never read as zero.
 */
export function countUnsentStashRecordings(sessions: StashedSession[]): number {
  let total = 0;
  for (const session of sessions) {
    const withAudio = (session?.slots ?? []).filter(slotCarriesAudio).length;
    total += Math.max(1, withAudio);
  }
  return total;
}

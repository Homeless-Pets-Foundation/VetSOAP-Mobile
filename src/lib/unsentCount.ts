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

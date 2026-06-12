import { draftStorage } from './draftStorage';
import { stashStorage } from './stashStorage';

/**
 * Count un-sent recordings on this device for the current user: local drafts
 * with audio segments, plus stashed sessions. Best-effort: any failure returns
 * the partial count and never blocks sign-out or account-deletion UX. Assumes
 * draft/stash user scoping is already set by AuthProvider.fetchUser().
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
    stashes = sessions.filter((s) => !s.resumedAt).length;
  } catch {
    // best-effort
  }

  return drafts + stashes;
}

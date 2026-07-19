import { AppState } from 'react-native';
import { recordingsApi } from './recordings';
import {
  dedupeRecordingIds,
  runDraftPresenceBatches,
  type DraftPresenceSnapshot,
} from '../lib/draftPresenceBatch';
import { draftStorage } from '../lib/draftStorage';
import { measurePhase } from '../lib/monitoring';

const SNAPSHOT_CACHE_MS = 30_000;

interface CachedSnapshot {
  expiresAt: number;
  userScopeVersion: number;
  snapshot: DraftPresenceSnapshot;
}

interface InFlightSnapshot {
  requestedIds: ReadonlySet<string>;
  promise: Promise<DraftPresenceSnapshot | null>;
}

const cachedSnapshotByUser = new Map<string, CachedSnapshot>();
const inFlightSnapshotByUser = new Map<string, InFlightSnapshot>();

function includesEvery(
  available: ReadonlySet<string>,
  requested: readonly string[],
): boolean {
  return requested.every((id) => available.has(id));
}

function selectSnapshot(
  snapshot: DraftPresenceSnapshot,
  recordingIds: readonly string[],
): DraftPresenceSnapshot {
  const requestedIds = new Set(recordingIds);
  const statusById = new Map(
    recordingIds.map((id) => [id, snapshot.statusById.get(id) ?? 'missing'] as const),
  );
  return { requestedIds, statusById };
}

function isScopeValid(userId: string, userScopeVersion: number): boolean {
  return (
    AppState.currentState === 'active' &&
    draftStorage.getUserId() === userId &&
    draftStorage.getUserScopeVersion() === userScopeVersion
  );
}

/**
 * Return one all-or-nothing, user-scoped snapshot. Completed and in-flight
 * supersets are reused so reconciliation, orphan cleanup, and eviction do not
 * independently probe the same server rows.
 */
export async function getDraftPresenceSnapshot(
  userId: string,
  recordingIds: readonly string[],
): Promise<DraftPresenceSnapshot | null> {
  const uniqueIds = dedupeRecordingIds(recordingIds);
  const userScopeVersion = draftStorage.getUserScopeVersion();
  if (!isScopeValid(userId, userScopeVersion)) return null;
  if (uniqueIds.length === 0) {
    return {
      requestedIds: new Set<string>(),
      statusById: new Map(),
    };
  }

  const cached = cachedSnapshotByUser.get(userId);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.userScopeVersion === userScopeVersion &&
    includesEvery(cached.snapshot.requestedIds, uniqueIds)
  ) {
    return selectSnapshot(cached.snapshot, uniqueIds);
  }

  const existing = inFlightSnapshotByUser.get(userId);
  if (existing) {
    const snapshot = await existing.promise;
    if (!isScopeValid(userId, userScopeVersion)) return null;
    if (snapshot && includesEvery(snapshot.requestedIds, uniqueIds)) {
      return selectSnapshot(snapshot, uniqueIds);
    }
    return getDraftPresenceSnapshot(userId, uniqueIds);
  }

  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    controller.abort();
  };
  const appStateSubscription = AppState.addEventListener('change', (nextState) => {
    if (nextState !== 'active') interrupt();
  });
  const unsubscribeUser = draftStorage.subscribeUserIdChanges((nextUserId) => {
    if (nextUserId !== userId) interrupt();
  });
  const scopeValid = () =>
    !interrupted && isScopeValid(userId, userScopeVersion);

  const promise = measurePhase(
    'draft_presence_reconciliation',
    { count: uniqueIds.length },
    () =>
      runDraftPresenceBatches(
        uniqueIds,
        (chunk) =>
          measurePhase(
            'draft_presence_batch_request',
            { count: chunk.length },
            () =>
              recordingsApi.draftPresence(chunk, {
                signal: controller.signal,
              }),
            { warningThresholdMs: 10_000 },
          ),
        scopeValid,
      ),
    { warningThresholdMs: null },
  )
    .then((snapshot) => {
      if (!snapshot || !scopeValid()) return null;
      cachedSnapshotByUser.set(userId, {
        expiresAt: Date.now() + SNAPSHOT_CACHE_MS,
        userScopeVersion,
        snapshot,
      });
      return snapshot;
    })
    .finally(() => {
      appStateSubscription.remove();
      unsubscribeUser();
      const current = inFlightSnapshotByUser.get(userId);
      if (current?.promise === promise) {
        inFlightSnapshotByUser.delete(userId);
      }
    });

  inFlightSnapshotByUser.set(userId, {
    requestedIds: new Set(uniqueIds),
    promise,
  });
  return promise;
}

export function linkedServerDraftIds(
  drafts: readonly { serverDraftId: string | null; pendingSync: boolean }[],
): string[] {
  return dedupeRecordingIds(
    drafts.flatMap((draft) =>
      draft.serverDraftId && !draft.pendingSync ? [draft.serverDraftId] : [],
    ),
  );
}

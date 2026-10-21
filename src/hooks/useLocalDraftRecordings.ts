import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getDraftPresenceSnapshot,
  linkedServerDraftIds,
} from '../api/draftPresence';
import { buildDraftResumeMap } from '../lib/draftRecordings';
import { buildSavedSessionDraftMap } from '../lib/draftLocation';
import { draftStorage, type DraftMetadata } from '../lib/draftStorage';
import { stashStorage } from '../lib/stashStorage';
import { measurePhase } from '../lib/monitoring';
import { useAuthDeviceRegistration, useAuthUser } from './useAuth';

const LOCAL_DRAFTS_STALE_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const EMPTY_DRAFTS: DraftMetadata[] = [];
const EMPTY_SAVED_SESSION_MAP: Record<string, string> = {};

const lastReconciledAtByUser = new Map<string, number>();
const reconcileInFlightByUser = new Map<string, Promise<number>>();

function shouldDeferReconciliation(): boolean {
  return AppState.currentState !== 'active';
}

function shouldInterruptReconciliation(userId: string): boolean {
  return shouldDeferReconciliation() || draftStorage.getUserId() !== userId;
}

async function reconcileMissingServerDrafts(userId: string, force: boolean): Promise<number> {
  if (shouldInterruptReconciliation(userId)) return 0;

  const now = Date.now();
  const last = lastReconciledAtByUser.get(userId) ?? 0;
  if (!force && now - last < RECONCILE_INTERVAL_MS) return 0;

  const existing = reconcileInFlightByUser.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    const drafts = await measurePhase(
      'local_draft_list',
      { source: 'reconcile' },
      () => draftStorage.listDraftsForUser(userId),
      { warningThresholdMs: 10_000 },
    );
    const linkedDrafts = drafts.filter((draft) => draft.serverDraftId && !draft.pendingSync);

    return measurePhase(
      'missing_server_draft_reconciliation',
      { user_scoped: true, count: linkedDrafts.length },
      async () => {
        const snapshot = await getDraftPresenceSnapshot(
          userId,
          linkedServerDraftIds(linkedDrafts),
        );
        if (!snapshot || shouldInterruptReconciliation(userId)) return 0;

        let reconciled = 0;
        for (const draft of linkedDrafts) {
          const serverDraftId = draft.serverDraftId;
          if (!serverDraftId || snapshot.statusById.get(serverDraftId) !== 'missing') {
            continue;
          }
          // Recheck foreground + auth scope before every mutation. The storage
          // call also compare-and-clears the expected ID so an intervening save
          // cannot be overwritten by this delayed snapshot.
          if (shouldInterruptReconciliation(userId)) return reconciled;
          await draftStorage.clearServerDraftIdForUser(
            userId,
            draft.slotId,
            serverDraftId,
          );
          reconciled++;
        }
        lastReconciledAtByUser.set(userId, Date.now());
        return reconciled;
      },
      { warningThresholdMs: null },
    );
  })();

  reconcileInFlightByUser.set(userId, promise);
  promise.finally(() => {
    if (reconcileInFlightByUser.get(userId) === promise) {
      reconcileInFlightByUser.delete(userId);
    }
  }).catch(() => {});
  return promise;
}

export interface UseLocalDraftRecordingsResult {
  localDrafts: DraftMetadata[];
  draftResumeMap: Record<string, string>;
  /**
   * Normalized server draft id → saved-session id, for drafts whose audio a
   * saved session holds (Save for Later deletes the local draft but keeps the
   * server row). Look up with `savedSessionIdForDraft`. Labels/routing only.
   */
  savedSessionDraftMap: Record<string, string>;
  isLoading: boolean;
  isRefetching: boolean;
  isStale: boolean;
  refreshLocalDrafts: (opts?: { forceReconcile?: boolean }) => void;
}

export function useLocalDraftRecordings(): UseLocalDraftRecordingsResult {
  const user = useAuthUser();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const canReconcileServerDrafts = !!userId && !deviceRegistrationPending && !deviceRegistrationBlock;

  const reconcileInBackground = useCallback(
    (force: boolean) => {
      if (!userId || !canReconcileServerDrafts || shouldInterruptReconciliation(userId)) return;

      reconcileMissingServerDrafts(userId, force)
        .then((reconciled) => {
          if (reconciled === 0) return;
          return queryClient.invalidateQueries({
            queryKey: ['local-drafts', userId],
            refetchType: 'active',
          });
        })
        .catch(() => {});
    },
    [canReconcileServerDrafts, queryClient, userId]
  );

  useEffect(() => {
    if (!userId || !canReconcileServerDrafts) return;

    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' || draftStorage.getUserId() !== userId) return;

      // A background transition resolves active probes as interrupted. If
      // their shared job has not unwound yet, resume only after it leaves the
      // per-user in-flight map; otherwise the dedupe would join the canceled
      // job and no reconciliation would actually restart.
      const existing = reconcileInFlightByUser.get(userId);
      if (existing) {
        existing
          .finally(() => {
            if (AppState.currentState === 'active' && draftStorage.getUserId() === userId) {
              reconcileInBackground(false);
            }
          })
          .catch(() => {});
        return;
      }

      reconcileInBackground(false);
    });

    return () => subscription.remove();
  }, [canReconcileServerDrafts, reconcileInBackground, userId]);

  const query = useQuery({
    queryKey: ['local-drafts', userId],
    enabled: !!userId,
    staleTime: LOCAL_DRAFTS_STALE_MS,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (!userId) return [] as DraftMetadata[];
      const drafts = await measurePhase(
        'local_draft_list',
        { source: 'query' },
        () => draftStorage.listDraftsForUser(userId),
        { warningThresholdMs: 10_000 },
      );
      reconcileInBackground(false);
      return drafts;
    },
  });

  // Nested under ['local-drafts', userId] so every existing invalidation of the
  // draft list (stash save deletes the drafts → 'draft_deleted', focus refresh)
  // refreshes this too. Lenient read: a missed stash only leaves the card on its
  // previous "Not on this device" path; the detail screen's strict anchor check
  // still governs any destructive action.
  const savedSessionQuery = useQuery({
    queryKey: ['local-drafts', userId, 'saved-sessions'],
    enabled: !!userId,
    staleTime: LOCAL_DRAFTS_STALE_MS,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (!userId || stashStorage.getUserId() !== userId) return EMPTY_SAVED_SESSION_MAP;
      const sessions = await stashStorage.getStashedSessionsForUser(userId);
      return buildSavedSessionDraftMap(sessions);
    },
  });

  const localDrafts = query.data ?? EMPTY_DRAFTS;
  const draftResumeMap = useMemo(() => buildDraftResumeMap(localDrafts), [localDrafts]);
  const savedSessionDraftMap = savedSessionQuery.data ?? EMPTY_SAVED_SESSION_MAP;

  const refreshLocalDrafts = useCallback(
    (opts?: { forceReconcile?: boolean }) => {
      if (!userId) return;
      const forceReconcile = opts?.forceReconcile === true;
      measurePhase(
        'local_draft_refresh',
        { force_reconcile: forceReconcile },
        async () => {
          await queryClient.invalidateQueries({
            queryKey: ['local-drafts', userId],
            refetchType: 'active',
          });
          reconcileInBackground(forceReconcile);
        },
        { warningThresholdMs: null },
      ).catch(() => {});
    },
    [queryClient, reconcileInBackground, userId]
  );

  return {
    localDrafts,
    draftResumeMap,
    savedSessionDraftMap,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isStale: query.isStale,
    refreshLocalDrafts,
  };
}

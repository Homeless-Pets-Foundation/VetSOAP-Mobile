import { useCallback, useMemo } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { recordingsApi } from '../api/recordings';
import { buildDraftResumeMap } from '../lib/draftRecordings';
import { draftStorage, type DraftMetadata, type ServerDraftPresence } from '../lib/draftStorage';
import { measurePhase } from '../lib/monitoring';
import { useAuthDeviceRegistration, useAuthUser } from './useAuth';

const LOCAL_DRAFTS_STALE_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const RECONCILE_CONCURRENCY = 3;
const RECONCILE_REQUEST_TIMEOUT_MS = 10_000;
const RECONCILE_PROBE_DEADLINE_MS = 12_000;
const EMPTY_DRAFTS: DraftMetadata[] = [];

const lastReconciledAtByUser = new Map<string, number>();
const reconcileInFlightByUser = new Map<string, Promise<number>>();

interface ServerDraftProbeResult {
  presence: ServerDraftPresence;
  interrupted: boolean;
}

function getServerDraftPresence(serverDraftId: string): Promise<ServerDraftProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServerDraftProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      appStateSubscription.remove();
      resolve(result);
    };
    const deadline = setTimeout(() => {
      finish({ presence: 'unknown', interrupted: false });
    }, RECONCILE_PROBE_DEADLINE_MS);
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        finish({ presence: 'unknown', interrupted: true });
      }
    });

    recordingsApi
      .get(serverDraftId, { timeoutMs: RECONCILE_REQUEST_TIMEOUT_MS })
      .then((recording) => {
        finish({
          presence: recording.status === 'draft' ? 'present' : 'unknown',
          interrupted: false,
        });
      })
      .catch((error) => {
        finish({
          presence: error instanceof ApiError && error.status === 404 ? 'missing' : 'unknown',
          interrupted: false,
        });
      });
  });
}

function shouldDeferReconciliation(): boolean {
  return AppState.currentState !== 'active';
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>, limit: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor++;
      const item = items[index];
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(workers);
}

async function reconcileMissingServerDrafts(userId: string, force: boolean): Promise<number> {
  if (shouldDeferReconciliation()) return 0;

  const now = Date.now();
  const last = lastReconciledAtByUser.get(userId) ?? 0;
  if (!force && now - last < RECONCILE_INTERVAL_MS) return 0;

  const existing = reconcileInFlightByUser.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    const drafts = await measurePhase('local_draft_list', { source: 'reconcile' }, () =>
      draftStorage.listDraftsForUser(userId)
    );
    const linkedDrafts = drafts.filter((draft) => draft.serverDraftId && !draft.pendingSync);

    return measurePhase(
      'missing_server_draft_reconciliation',
      { user_scoped: true, count: linkedDrafts.length },
      async () => {
        let reconciled = 0;
        let deferredUntilForeground = false;

        await runBounded(
          linkedDrafts,
          async (draft) => {
            if (shouldDeferReconciliation()) {
              deferredUntilForeground = true;
              return;
            }
            const serverDraftId = draft.serverDraftId;
            if (!serverDraftId) return;
            const probe = await getServerDraftPresence(serverDraftId);
            if (probe.interrupted || shouldDeferReconciliation()) {
              deferredUntilForeground = true;
              return;
            }
            const presence = probe.presence;
            if (presence !== 'missing') return;
            await draftStorage.clearServerDraftIdForUser(userId, draft.slotId, serverDraftId);
            reconciled++;
          },
          RECONCILE_CONCURRENCY
        );

        if (!deferredUntilForeground) {
          lastReconciledAtByUser.set(userId, Date.now());
        }
        return reconciled;
      }
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
      if (!userId || !canReconcileServerDrafts || shouldDeferReconciliation()) return;

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

  const query = useQuery({
    queryKey: ['local-drafts', userId],
    enabled: !!userId,
    staleTime: LOCAL_DRAFTS_STALE_MS,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (!userId) return [] as DraftMetadata[];
      const drafts = await measurePhase('local_draft_list', { source: 'query' }, () =>
        draftStorage.listDraftsForUser(userId)
      );
      reconcileInBackground(false);
      return drafts;
    },
  });

  const localDrafts = query.data ?? EMPTY_DRAFTS;
  const draftResumeMap = useMemo(() => buildDraftResumeMap(localDrafts), [localDrafts]);

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
        }
      ).catch(() => {});
    },
    [queryClient, reconcileInBackground, userId]
  );

  return {
    localDrafts,
    draftResumeMap,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isStale: query.isStale,
    refreshLocalDrafts,
  };
}

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { recordingsApi } from '../api/recordings';
import { buildDraftResumeMap } from '../lib/draftRecordings';
import { draftStorage, type DraftMetadata, type ServerDraftPresence } from '../lib/draftStorage';
import { measurePhase } from '../lib/monitoring';
import { useAuthUser } from './useAuth';

const LOCAL_DRAFTS_STALE_MS = 60_000;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const RECONCILE_CONCURRENCY = 3;
const EMPTY_DRAFTS: DraftMetadata[] = [];

const lastReconciledAtByUser = new Map<string, number>();
const reconcileInFlightByUser = new Map<string, Promise<number>>();

async function getServerDraftPresence(serverDraftId: string): Promise<ServerDraftPresence> {
  try {
    const recording = await recordingsApi.get(serverDraftId);
    return recording.status === 'draft' ? 'present' : 'unknown';
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return 'missing';
    }
    return 'unknown';
  }
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>, limit: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

async function reconcileMissingServerDrafts(userId: string, force: boolean): Promise<number> {
  const now = Date.now();
  const last = lastReconciledAtByUser.get(userId) ?? 0;
  if (!force && now - last < RECONCILE_INTERVAL_MS) return 0;

  const existing = reconcileInFlightByUser.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    const drafts = await measurePhase('local_draft_list', { source: 'reconcile' }, () => draftStorage.listDrafts());
    const linkedDrafts = drafts.filter((draft) => draft.serverDraftId && !draft.pendingSync);

    return measurePhase(
      'missing_server_draft_reconciliation',
      { user_scoped: true, count: linkedDrafts.length },
      async () => {
        let reconciled = 0;

        await runBounded(
          linkedDrafts,
          async (draft) => {
            const serverDraftId = draft.serverDraftId;
            if (!serverDraftId) return;
            const presence = await getServerDraftPresence(serverDraftId);
            if (presence !== 'missing') return;
            await draftStorage.clearServerDraftId(draft.slotId);
            reconciled++;
          },
          RECONCILE_CONCURRENCY
        );

        lastReconciledAtByUser.set(userId, Date.now());
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
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: ['local-drafts', userId],
    enabled: !!userId,
    staleTime: LOCAL_DRAFTS_STALE_MS,
    gcTime: 10 * 60_000,
    queryFn: async () => {
      if (!userId) return [] as DraftMetadata[];
      await reconcileMissingServerDrafts(userId, false);
      return measurePhase('local_draft_list', { source: 'query' }, () => draftStorage.listDrafts());
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
          await reconcileMissingServerDrafts(userId, forceReconcile);
          await queryClient.invalidateQueries({
            queryKey: ['local-drafts', userId],
            refetchType: 'active',
          });
        }
      ).catch(() => {});
    },
    [queryClient, userId]
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

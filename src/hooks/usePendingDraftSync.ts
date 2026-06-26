import { useEffect } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import { draftStorage, type DraftSyncResult } from '../lib/draftStorage';
import { measurePhase } from '../lib/monitoring';
import { invalidateRecordingCaches } from '../lib/recordingQueryCache';
import { canRecordAppointments } from '../lib/recordingPermissions';
import { useAuthUser } from './useAuth';

const FAILURE_BACKOFF_MS = 2 * 60_000;

const inFlightByUser = new Map<string, Promise<DraftSyncResult>>();
const lastFailedAtByUser = new Map<string, number>();

function shouldRunForUser(userId: string): boolean {
  if (AppState.currentState !== 'active') return false;
  const lastFailedAt = lastFailedAtByUser.get(userId) ?? 0;
  return Date.now() - lastFailedAt >= FAILURE_BACKOFF_MS;
}

function runPendingDraftSync(userId: string): Promise<DraftSyncResult> | null {
  if (!shouldRunForUser(userId)) return null;
  const existing = inFlightByUser.get(userId);
  if (existing) return existing;

  const job = measurePhase('pending_draft_sync', { user_scoped: true }, async () => {
    try {
      const result = await draftStorage.syncPending(userId, (formData) => recordingsApi.create(formData, { isDraft: true }));
      if (result.failed > 0) {
        lastFailedAtByUser.set(userId, Date.now());
      } else {
        lastFailedAtByUser.delete(userId);
      }
      return result;
    } catch (error) {
      lastFailedAtByUser.set(userId, Date.now());
      throw error;
    }
  });

  inFlightByUser.set(userId, job);
  job.finally(() => {
    if (inFlightByUser.get(userId) === job) {
      inFlightByUser.delete(userId);
    }
  }).catch(() => {});
  return job;
}

export function usePendingDraftSync(): void {
  const user = useAuthUser();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const canSync = !!userId && canRecordAppointments(user?.role);

  useEffect(() => {
    if (!canSync || !userId) return;

    let cancelled = false;
    const maybeRun = () => {
      if (cancelled) return;
      NetInfo.fetch()
        .then((state) => {
          if (cancelled) return;
          if (state.isConnected && state.isInternetReachable !== false) {
            runPendingDraftSync(userId)?.then((result) => {
              if (result.succeeded > 0) {
                invalidateRecordingCaches(queryClient, 'draft_changed');
              }
            }).catch(() => {});
          }
        })
        .catch(() => {});
    };

    maybeRun();

    const netUnsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        runPendingDraftSync(userId)?.then((result) => {
          if (result.succeeded > 0) {
            invalidateRecordingCaches(queryClient, 'draft_changed');
          }
        }).catch(() => {});
      }
    });
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') maybeRun();
    });

    return () => {
      cancelled = true;
      netUnsubscribe();
      appStateSub.remove();
    };
  }, [canSync, queryClient, userId]);
}

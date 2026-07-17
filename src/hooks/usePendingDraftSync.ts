import { useEffect } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import * as durableRecorder from '../../modules/captivet-durable-recorder';
import { draftStorage, type DraftSyncResult } from '../lib/draftStorage';
import { measurePhase } from '../lib/monitoring';
import { invalidateRecordingCaches } from '../lib/recordingQueryCache';
import { canRecordAppointments } from '../lib/recordingPermissions';
import { useAuthUser } from './useAuth';
import { effectiveUploadIdempotencyKey } from '../lib/uploadIntent';

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
      const result = await draftStorage.syncPending(userId, async (draft) => {
        if (draft.supersededUploadKey || draft.uploadRestartPending) {
          throw new Error('controlled_upload_restart_requires_explicit_submit');
        }
        // A durable draft MUST create its server row with a deterministic
        // idempotency key derived from its on-disk durable recordingId. A later
        // Submit reuses the same `durable-${recordingId}` key, so the server
        // promotes THIS row instead of fresh-creating a duplicate — even if the
        // app dies after create() but before updateServerDraftId() persists the
        // anchor. A random key here would strand the created row. Also persist
        // serverRecordingId into the manifest as the death-surviving anchor so
        // the launch recovery scan can reconcile it against the server.
        const durableRecordingId = draft.durable?.recordingId;
        const idempotencyKey = effectiveUploadIdempotencyKey({
          uploadKeyOverride: draft.uploadKeyOverride,
          durableRecordingId,
          uploadIntentId: draft.uploadIntentId,
          slotId: draft.slotId,
        });
        if (durableRecordingId) {
          const created = await recordingsApi.create(draft.formData, {
            isDraft: true,
            idempotencyKey,
          });
          await durableRecorder
            .setServerRecordingId({ userId, recordingId: durableRecordingId, serverRecordingId: created.id })
            .catch(() => {});
          return created;
        }
        return recordingsApi.create(draft.formData, {
          isDraft: true,
          idempotencyKey,
        });
      });
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

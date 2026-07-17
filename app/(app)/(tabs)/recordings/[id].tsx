import React, { useCallback, useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable, Alert, RefreshControl, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { ChevronLeft, AlertTriangle, FileText, RotateCcw, Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { recordingsApi } from '../../../../src/api/recordings';
import { ApiError } from '../../../../src/api/client';
import { StatusBadge } from '../../../../src/components/StatusBadge';
import { SoapNoteView } from '../../../../src/components/SoapNoteView';
import { RecordingAudioPlayer } from '../../../../src/components/RecordingAudioPlayer';
import { TranscriptView } from '../../../../src/components/TranscriptView';
import { ClientEmailCard } from '../../../../src/components/ClientEmailCard';
import { ExportSheet } from '../../../../src/components/ExportSheet';
import { ReprocessSheet } from '../../../../src/components/ReprocessSheet';
import { TranslationCard } from '../../../../src/components/TranslationCard';
import { ConsultAICard } from '../../../../src/components/ConsultAICard';
import { SuggestedTasksCard } from '../../../../src/components/SuggestedTasksCard';
import { MetadataReviewCard } from '../../../../src/components/MetadataReviewCard';
import { ProcessingStepper } from '../../../../src/components/ProcessingStepper';
import { CelebrationBurst } from '../../../../src/components/CelebrationBurst';
import { Toast } from '../../../../src/components/Toast';
import { ReviewStatusChip } from '../../../../src/components/ReviewStatusChip';
import { Button } from '../../../../src/components/ui/Button';
import { Card } from '../../../../src/components/ui/Card';
import { Skeleton, SkeletonText } from '../../../../src/components/ui/Skeleton';
import { draftStorage } from '../../../../src/lib/draftStorage';
import { recoveryIntent } from '../../../../src/lib/recoveryIntent';
import { stashStorage } from '../../../../src/lib/stashStorage';
import { copyWithAutoClear } from '../../../../src/lib/secureClipboard';
import { fileExists, safeDeleteFile } from '../../../../src/lib/fileOps';
import { isValidDurableId } from '../../../../src/lib/durableAudio/paths';
import { clonePendingConfirm } from '../../../../src/lib/pendingConfirm';
import * as durableRecorder from '../../../../modules/captivet-durable-recorder';
import { ERROR_COPY, METADATA_REVIEW_COPY, RECORDING_DETAIL_COPY, REGENERATE_SOAP_COPY, TRANSCRIPT_COPY } from '../../../../src/constants/strings';
import { trackEvent } from '../../../../src/lib/analytics';
import { invalidateRecordingCaches, mergeRecordingIntoCachedLists } from '../../../../src/lib/recordingQueryCache';
import {
  shouldEmitExtractionObserved,
  buildExtractionObservedProps,
  shouldReportZeroFill,
  zeroFillErrorCode,
} from '../../../../src/lib/recordFirstObservability';
import { getSubmitTimestamps, clearSubmitTimestamps } from '../../../../src/lib/submitTiming';
import { reportClientError } from '../../../../src/api/telemetry';
import { useRecordingPermissions } from '../../../../src/hooks/usePermissions';
import { canRecordAppointments } from '../../../../src/lib/recordingPermissions';
import { hasVisibleReprocessModelChoice } from '../../../../src/lib/aiModels';
import { getTasksRefetchInterval } from '../../../../src/lib/recordingTasks';
import { getRecordingReviewStatus } from '../../../../src/lib/recordingReview';
import { useAuthUser } from '../../../../src/hooks/useAuth';
import { displayPatientName, isUntitledVisit } from '../../../../src/lib/recordingDisplay';
import type { RecordingMetadataField, UpdateRecordingMetadata } from '../../../../src/types';

function DetailSkeleton() {
  return (
    <SafeAreaView className="screen">
      <ScrollView className="flex-1">
        <View className="flex-row items-center p-5 pb-0">
          <Skeleton width={24} height={24} borderRadius={12} className="mr-3" />
          <Skeleton width="50%" height={22} />
        </View>
        <View className="card m-5 mt-4">
          <View className="flex-row flex-wrap gap-4">
            <View>
              <Skeleton width={60} height={12} className="mb-1.5" />
              <Skeleton width={80} height={16} />
            </View>
            <View>
              <Skeleton width={60} height={12} className="mb-1.5" />
              <Skeleton width={100} height={16} />
            </View>
          </View>
          <Skeleton width={140} height={12} className="mt-3" />
        </View>
        <View className="card mx-5 mb-4">
          <Skeleton width="40%" height={18} className="mb-3" />
          <SkeletonText lines={4} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function RecordingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { iconMd } = useResponsive();
  const colors = useThemeColors();
  const user = useAuthUser();
  const recordFirstEnabled = user?.capabilities?.includes('record_first') ?? false;

  const appStateRef = useRef(AppState.currentState);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const pollingStartedAtRef = useRef<number | null>(null);
  // Backoff attempts for the CURRENT poll session. query.state.dataUpdateCount
  // counts every data update for the query's lifetime, so after a
  // regenerate/reprocess the interval started near the 60s cap instead of 5s
  // and the stepper felt frozen. Reset wherever pollingStartedAtRef resets.
  const pollAttemptsRef = useRef(0);

  // Completion celebration — fired ONCE on the prev !== 'completed' →
  // 'completed' transition (the query polls/refetches, so guard against the
  // status settling re-firing every render).
  const [celebrate, setCelebrate] = useState(false);
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      setIsAppActive(nextState === 'active');
    });
    return () => {
      sub.remove();
    };
  }, []);

  const { data: recording, isLoading, isError, error, refetch: refetchRecording, isRefetching: isRefetchingRecording } = useQuery({
    queryKey: ['recording', id],
    queryFn: () => recordingsApi.get(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!isAppActive) return false;
      const status = query.state.data?.status;
      if (!status || ['completed', 'failed', 'pending_metadata', 'draft'].includes(status)) {
        pollingStartedAtRef.current = null;
        pollAttemptsRef.current = 0;
        return false;
      }
      if (!pollingStartedAtRef.current) {
        pollingStartedAtRef.current = Date.now();
        pollAttemptsRef.current = 0;
      }
      const elapsedMs = Date.now() - pollingStartedAtRef.current;
      if (elapsedMs > 30 * 60 * 1000) {
        return false; // Stop polling — stale processing
      }
      // Exponential backoff: 5s → 7.5s → 11.25s → … capped at 60s.
      // Per-session attempts ref, NOT query.state.dataUpdateCount (lifetime
      // counter — post-reprocess it started the interval near the cap).
      const attempts = pollAttemptsRef.current;
      pollAttemptsRef.current += 1;
      return Math.min(5_000 * Math.pow(1.5, attempts), 60_000);
    },
  });

  // Fire the celebration exactly on the transition into 'completed'.
  useEffect(() => {
    const next = recording?.status;
    const prev = prevStatusRef.current;
    prevStatusRef.current = next;
    if (next === 'completed' && prev !== undefined && prev !== 'completed') {
      setCelebrate(true);
      setShowCompletionToast(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }, [recording?.status]);

  // Org-level model options for the reprocess pickers. Flat org key (NOT under
  // ['recording', id]) so reprocess's invalidate/setQueryData leaves it cached.
  // Gated by reprocess role: the response leaks the org's AI-provider config, so a
  // viewer who can't reprocess shouldn't fetch it (server enforces the same role).
  const { data: aiModels } = useQuery({
    queryKey: ['orgAiModels'],
    queryFn: () => recordingsApi.getOrgAiModels(),
    staleTime: 1000 * 60 * 30,
    refetchOnMount: 'always',
    enabled: !!user && canRecordAppointments(user?.role),
  });

  const {
    data: soapNote,
    isLoading: isSoapNoteLoading,
    isError: isSoapNoteError,
    refetch: refetchSoapNote,
    isRefetching: isRefetchingSoapNote,
  } = useQuery({
    queryKey: ['soapNote', id],
    queryFn: () => recordingsApi.getSoapNote(id!),
    enabled: !!id && recording?.status === 'completed',
    retry: 3,
    retryDelay: 2000,
  });

  const {
    data: recordingTasks,
    refetch: refetchTasks,
    isRefetching: isRefetchingTasks,
  } = useQuery({
    queryKey: ['recordingTasks', id],
    queryFn: () => recordingsApi.getRecordingTasks(id!),
    enabled: !!id && recording?.status === 'completed',
    // Tasks are generated asynchronously a few seconds after completion. Refetch
    // on remount + poll briefly while empty so the card self-heals instead of
    // caching an empty list during that window. See getTasksRefetchInterval.
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      getTasksRefetchInterval({
        tasksCount: Array.isArray(query.state.data) ? query.state.data.length : 0,
        appActive: isAppActive,
        completedAtMs: recording?.processingCompletedAt
          ? Date.parse(recording.processingCompletedAt)
          : null,
        nowMs: Date.now(),
        attempts: query.state.dataUpdateCount,
      }),
  });

  const handleRefresh = useCallback(() => {
    refetchRecording().catch(() => {});
    refetchSoapNote().catch(() => {});
    refetchTasks().catch(() => {});
  }, [refetchRecording, refetchSoapNote, refetchTasks]);

  // time-to-SOAP — fires once per recording the first time a non-null SOAP
  // renders on this device. Uses timestamps seeded by record.tsx (Finish
  // tap + submit start) via the `submitTiming` singleton. If the user cold-
  // started between submit and viewing, both deltas come back null and we
  // skip the metric.
  const soapVisibleEmittedRef = useRef(false);
  useEffect(() => {
    if (!id || !soapNote || soapVisibleEmittedRef.current) return;
    soapVisibleEmittedRef.current = true;
    const timings = getSubmitTimestamps(id);
    const now = Date.now();
    trackEvent({
      name: 'soap_visible',
      props: {
        recording_id: id,
        ms_since_finish: timings?.finishAt ? now - timings.finishAt : null,
        ms_since_submit: timings?.submitAt ? now - timings.submitAt : null,
      },
    });
    clearSubmitTimestamps(id);
  }, [id, soapNote]);

  const isPollingStale =
    !!pollingStartedAtRef.current &&
    Date.now() - pollingStartedAtRef.current > 30 * 60 * 1000 &&
    !['completed', 'failed', 'pending_metadata', 'draft'].includes(recording?.status ?? '');
  const recordingPermissions = useRecordingPermissions(recording);

  const reviewMutation = useMutation({
    mutationFn: (reviewed: boolean) => recordingsApi.updateReview(id!, { reviewed }),
    onSuccess: (updatedRecording) => {
      if (id && updatedRecording?.id === id) {
        queryClient.setQueryData(['recording', id], updatedRecording);
        mergeRecordingIntoCachedLists(queryClient, updatedRecording);
      }
      invalidateRecordingCaches(queryClient, 'review_update');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert(
        'Review Update Failed',
        error instanceof ApiError ? error.message : 'Could not update the review status. Please try again.'
      );
    },
  });

  const retryMutation = useMutation({
    mutationFn: () => recordingsApi.retry(id!),
    onSuccess: (updatedRecording) => {
      if (id && updatedRecording?.id === id) {
        queryClient.setQueryData(['recording', id], updatedRecording);
        mergeRecordingIntoCachedLists(queryClient, updatedRecording);
        pollingStartedAtRef.current = null;
        pollAttemptsRef.current = 0;
      }
      queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
      invalidateRecordingCaches(queryClient, 'processing_retry');
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert(
        'Retry Failed',
        error instanceof ApiError ? error.message : 'An unexpected error occurred. Please try again.'
      );
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () => recordingsApi.regenerateSoap(id!, { templateId: recording?.templateId }),
    onSuccess: () => {
      if (id) {
        trackEvent({ name: 'soap_regenerated', props: { recording_id: id, template_changed: false } });
        queryClient.removeQueries({ queryKey: ['soapNote', id] });
        queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
        invalidateRecordingCaches(queryClient, 'soap_regenerated');
        pollingStartedAtRef.current = null;
        pollAttemptsRef.current = 0;
        setActiveNoteTab('soap');
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert(
        'Regenerate Failed',
        error instanceof ApiError ? error.message : 'Could not regenerate this SOAP note. Please try again.'
      );
    },
  });

  const metadataMutation = useMutation({
    mutationFn: (vars: {
      payload: UpdateRecordingMetadata;
      action: 'confirmed' | 'corrected' | 'dismissed';
      correctedFieldCount: number;
    }) => recordingsApi.updateMetadata(id!, vars.payload),
    onSuccess: (updatedRecording, vars) => {
      if (id && updatedRecording?.id === id) {
        queryClient.setQueryData(['recording', id], updatedRecording);
        mergeRecordingIntoCachedLists(queryClient, updatedRecording);
      }
      const pimsPatientIdSubmitted = Object.prototype.hasOwnProperty.call(
        vars.payload.fields ?? {},
        'pimsPatientId'
      );
      if (pimsPatientIdSubmitted || updatedRecording?.patientId !== recording?.patientId) {
        queryClient.invalidateQueries({ queryKey: ['patients'] }).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ['patient'] }).catch(() => {});
      }
      queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
      invalidateRecordingCaches(queryClient, 'metadata_update');
      trackEvent({
        name: 'ai_metadata_review_resolved',
        props: {
          action: vars.action,
          corrected_field_count: vars.correctedFieldCount,
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert('Save Failed', METADATA_REVIEW_COPY.failed);
    },
  });

  const handleConfirmMetadata = useCallback(() => {
    metadataMutation.mutate({
      payload: { review: 'confirmed' },
      action: 'confirmed',
      correctedFieldCount: 0,
    });
  }, [metadataMutation]);

  const handleSaveMetadata = useCallback(
    (payload: UpdateRecordingMetadata, correctedFieldCount: number) => {
      metadataMutation.mutate({
        payload,
        action: 'corrected',
        correctedFieldCount,
      });
    },
    [metadataMutation]
  );

  const confirmRegenerate = useCallback(() => {
    Alert.alert(
      REGENERATE_SOAP_COPY.title,
      REGENERATE_SOAP_COPY.body,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: REGENERATE_SOAP_COPY.confirm,
          style: 'destructive',
          onPress: () => {
            regenerateMutation.mutate();
          },
        },
      ]
    );
  }, [regenerateMutation]);

  // For draft recordings, figure out whether the audio is on THIS device.
  // If a matching local draft exists and all segments are present, the user
  // can resume in the Record screen. Otherwise the draft is orphaned (created
  // on another device, or local storage cleared) and the only sensible action
  // from here is to delete it.
  const [draftLocalSlotId, setDraftLocalSlotId] = useState<string | null>(null);
  const [draftResolved, setDraftResolved] = useState(false);

  // SOAP Note | Transcript segmented toggle (1C). Transcript tab exists only
  // when the recording is completed AND transcriptText is non-null (old/failed
  // recordings have none).
  const [activeNoteTab, setActiveNoteTab] = useState<'soap' | 'transcript'>('soap');
  const transcriptViewedEmittedRef = useRef(false);
  const metadataReviewShownIdsRef = useRef<Set<string>>(new Set());
  const extractionObservedIdsRef = useRef<Set<string>>(new Set());
  const handleSelectNoteTab = useCallback(
    (tab: 'soap' | 'transcript') => {
      setActiveNoteTab(tab);
      if (tab === 'transcript' && id && !transcriptViewedEmittedRef.current) {
        transcriptViewedEmittedRef.current = true;
        trackEvent({ name: 'transcript_viewed', props: { recording_id: id } });
      }
    },
    [id]
  );

  useEffect(() => {
    if (!recording || recording.status !== 'draft' || !id) {
      setDraftLocalSlotId(null);
      setDraftResolved(true);
      return;
    }

    let cancelled = false;
    setDraftResolved(false);
    draftStorage
      .listDrafts()
      .then((drafts) => {
        if (cancelled) return;
        const match = drafts.find((d) => d.serverDraftId === id);
        // A durable draft has empty segments — audio lives in audio.aac — so a
        // valid durable pointer counts as a resumable local draft (mirrors
        // isDraftResumable). Without this the durable "Not Submitted" card opens
        // a dead-end detail view instead of resuming into Record.
        const durableResumable = !!match?.durable && isValidDurableId(match.durable.recordingId);
        const confirmationResumable = !!clonePendingConfirm(match?.pendingConfirm);
        if (match && (confirmationResumable || durableResumable || (match.segments.length > 0 && match.segments.every((s) => fileExists(s.uri))))) {
          setDraftLocalSlotId(match.slotId);
        } else {
          setDraftLocalSlotId(null);
        }
      })
      .catch(() => {
        if (!cancelled) setDraftLocalSlotId(null);
      })
      .finally(() => {
        if (!cancelled) setDraftResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [recording, id]);

  // Record-first observability (A1 + A2). Fires once per completed record-first
  // recording, BEFORE the review-card `shouldShow` gate below — so it captures
  // the null-extraction (`had_metadata=false`) cohort that never shows a card,
  // the exact "looks broken" population the old card-based query was blind to.
  // Has its own dedupe Set; do NOT fold into the review-shown effect.
  useEffect(() => {
    if (!id || !recording) return;
    if (!shouldEmitExtractionObserved(recording, recordFirstEnabled)) return;
    if (extractionObservedIdsRef.current.has(id)) return;
    extractionObservedIdsRef.current.add(id);

    trackEvent({
      name: 'ai_metadata_extraction_observed',
      props: buildExtractionObservedProps(recording),
    });

    // A2 — zero-fill warning, keyed by recording into client_telemetry. Gated on
    // a blank patient name (manual recordings self-exclude), NOT on
    // needsMetadataReview (server clears it on null extraction — the case we
    // must catch). Mirrors the delete_draft reportClientError call below.
    if (shouldReportZeroFill(recording, recordFirstEnabled)) {
      const meta = recording.aiExtractedMetadata ?? null;
      const appliedCount = Array.isArray(meta?.appliedFields) ? meta.appliedFields.length : 0;
      const extractedCount = meta?.fields ? Object.keys(meta.fields).length : 0;
      reportClientError({
        phase: 'ai_extract',
        severity: 'warning',
        errorCode: zeroFillErrorCode(recording),
        message: `record-first zero-fill: had_metadata=${meta != null} applied=${appliedCount} extracted=${extractedCount}`,
        recordingId: id,
      });
    }
  }, [id, recordFirstEnabled, recording]);

  useEffect(() => {
    if (!id || !recordFirstEnabled || recording?.status !== 'completed') return;
    const reviewState = recording.aiExtractedMetadata?.review;
    const shouldShow = Boolean(recording.needsMetadataReview) || reviewState === 'unconfirmed';
    if (!shouldShow || metadataReviewShownIdsRef.current.has(id)) return;
    metadataReviewShownIdsRef.current.add(id);
    const appliedFieldCount = Array.isArray(recording.aiExtractedMetadata?.appliedFields)
      ? recording.aiExtractedMetadata.appliedFields.length
      : 0;
    trackEvent({
      name: 'ai_metadata_review_shown',
      props: { applied_field_count: appliedFieldCount },
    });
  }, [
    id,
    recordFirstEnabled,
    recording?.status,
    recording?.needsMetadataReview,
    recording?.aiExtractedMetadata,
  ]);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!id) return;
      if (!recordingPermissions.canDelete) {
        throw new ApiError(
          recordingPermissions.deleteBlockedReason ?? 'You do not have permission to delete this recording.',
          403,
          false,
          undefined,
          'RECORDING_DELETE_FORBIDDEN'
        );
      }
      await recordingsApi.delete(id, { reason: 'user_delete' });
      // If a local draft points at this server row, purge it too so the
      // "Not Submitted" card won't resurrect on next focus.
      if (draftLocalSlotId) {
        // draftStorage.deleteDraft() intentionally does NOT purge a durable
        // recording's native audio.aac (a stash may share it), so a durable draft
        // deleted from here would leave the audio on disk and the launch recovery
        // scan would resurrect it. Discard the native recording (and any loose
        // vault-restored copy) first.
        try {
          const localDraft = await draftStorage.getDraft(draftLocalSlotId);
          const rid = localDraft?.durable?.recordingId;
          if (rid && isValidDurableId(rid) && user?.id) {
            // A stash can share this native audio.aac (stash metadata committed,
            // then the draft-delete during stashing failed / the app died in that
            // window). Discard the native recording ONLY if we can POSITIVELY
            // confirm NO stash references it. Fail CLOSED: a Keystore read failure
            // must NOT be read as "no stashes" and delete a stash's shared audio
            // (Lela-class loss) — worst case of skipping is the recovery scan
            // re-offering a deleted card (recoverable), far better than data loss.
            let safeToDiscard = false;
            try {
              const stashes = await stashStorage.getStashedSessionsStrict();
              safeToDiscard = !stashes.some((s) =>
                s.slots.some((sl) => sl.durable?.recordingId === rid),
              );
            } catch {
              safeToDiscard = false; // read failed → assume shared → keep audio
            }
            if (safeToDiscard) {
              await durableRecorder.discard({ userId: user.id, recordingId: rid }).catch(() => {});
            }
          }
          if (localDraft?.durable?.recoveredAudioUri) {
            safeDeleteFile(localDraft.durable.recoveredAudioUri);
          }
        } catch {
          /* best-effort — proceed with the metadata delete */
        }
        await draftStorage.deleteDraft(draftLocalSlotId).catch(() => {});
        await recoveryIntent.clearForDraftSlot(draftLocalSlotId).catch(() => {});
      }
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      invalidateRecordingCaches(queryClient, recording?.status === 'draft' ? 'draft_deleted' : 'detail_deleted');
      queryClient.removeQueries({ queryKey: ['recording', id] });
      router.navigate('/recordings');
    },
    onError: (error: Error) => {
      if (id) {
        reportClientError({
          phase: 'delete_draft',
          severity: 'error',
          errorCode: error instanceof ApiError ? error.code ?? String(error.status) : 'unknown',
          message: error instanceof Error ? error.message : 'Draft delete failed',
          recordingId: id,
        });
      }
      Alert.alert(
        'Delete Failed',
        error instanceof ApiError ? error.message : 'Could not delete this draft. Please try again.'
      );
    },
  });

  const confirmDeleteDraft = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert(
      'Delete Draft?',
      'This will permanently remove the draft from your account. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteMutation.mutate();
          },
        },
      ]
    );
  }, [deleteMutation]);

  const handleResumeDraft = useCallback(() => {
    if (!draftLocalSlotId) return;
    Haptics.selectionAsync().catch(() => {});
    router.navigate(`/record?draftSlotId=${draftLocalSlotId}` as never);
  }, [draftLocalSlotId, router]);

  // Back respects where the user came from (Home, patient history, post-submit)
  // instead of always dumping them on the Recordings list.
  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/recordings');
    }
  }, [router]);

  if (isError) {
    return (
      <SafeAreaView className="screen justify-center items-center p-5">
        <Animated.View entering={FadeIn.duration(300)} className="items-center">
          <Text className="text-body-lg font-semibold text-status-danger mb-2">
            Failed to load recording
          </Text>
          <Text className="text-body text-content-tertiary text-center mb-4">
            {error instanceof ApiError ? error.message : 'An unexpected error occurred. Please try again.'}
          </Text>
          <View className="flex-row gap-3">
            <Button variant="primary" onPress={goBack}>
              Go Back
            </Button>
            <Button variant="secondary" onPress={() => { refetchRecording().catch(() => {}); }}>
              Retry
            </Button>
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  if (isLoading || !recording) {
    return <DetailSkeleton />;
  }

  const isProcessing = !['completed', 'failed', 'pending_metadata', 'draft'].includes(recording.status);
  const hasTranscript =
    recording.status === 'completed' &&
    typeof recording.transcriptText === 'string' &&
    recording.transcriptText.trim().length > 0;
  const reviewStatus = getRecordingReviewStatus(recording);
  const deleteDraftBlockedReason =
    recordingPermissions.deleteBlockedReason ?? 'You do not have permission to delete this draft.';
  const parsedDate = new Date(recording.createdAt);
  const formattedDate = isNaN(parsedDate.getTime())
    ? ''
    : parsedDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
  const patientLabel = displayPatientName(recording);
  const patientIsUntitled = isUntitledVisit(recording);
  const appliedMetadataFields = new Set<RecordingMetadataField>(
    Array.isArray(recording.aiExtractedMetadata?.appliedFields)
      ? recording.aiExtractedMetadata.appliedFields
      : []
  );
  const metadataReviewState = recording.aiExtractedMetadata?.review;
  const showHeaderPatientMetadataGlyph =
    (metadataReviewState === 'confirmed' || metadataReviewState === 'dismissed') &&
    appliedMetadataFields.has('patientName') &&
    !patientIsUntitled;
  // Gate the metadata-edit affordances on the same author/owner/admin permission
  // the server enforces for PATCH /:id/metadata (reuse recordingPermissions.canEdit,
  // which mirrors the delete/edit guard). Without this the review/add/edit cards
  // render for every viewer, so a vet opening a colleague's recording can tap
  // "Edit Details" and hit a 403 "Save Failed".
  const showMetadataReview =
    recordingPermissions.canEdit &&
    recordFirstEnabled &&
    recording.status === 'completed' &&
    (Boolean(recording.needsMetadataReview) || metadataReviewState === 'unconfirmed');
  const showAddMetadata =
    recordingPermissions.canEdit &&
    recordFirstEnabled &&
    recording.status === 'completed' &&
    !showMetadataReview &&
    !(recording.patientName ?? '').trim();
  const showEditMetadata =
    recordingPermissions.canEdit &&
    recordFirstEnabled &&
    recording.status === 'completed' &&
    !showMetadataReview &&
    !showAddMetadata &&
    Boolean((recording.patientName ?? '').trim());
  const renderInfoField = (
    field: RecordingMetadataField | null,
    label: string,
    value: string | null,
    className = 'pr-2'
  ) => value ? (
    <View style={{ width: '50%' }} className={`mb-3 ${className}`}>
      <View className="flex-row items-center">
        <Text className="text-caption text-content-tertiary font-medium uppercase">
          {label}
        </Text>
        {field && appliedMetadataFields.has(field) ? (
          <Sparkles color={colors.brand500} size={11} style={{ marginLeft: 4 }} />
        ) : null}
      </View>
      <Text
        className="text-body text-content-primary mt-0.5"
        numberOfLines={field === 'clientName' ? 1 : undefined}
      >
        {value}
      </Text>
    </View>
  ) : null;

  return (
    <SafeAreaView className="screen">
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl
            refreshing={isRefetchingRecording || isRefetchingSoapNote || isRefetchingTasks}
            onRefresh={handleRefresh}
          />
        }
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>
        {/* Header */}
        <View className="flex-row items-center px-5 pt-5">
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="mr-3 w-11 h-11 items-center justify-center"
          >
            <ChevronLeft color={colors.contentPrimary} size={iconMd} />
          </Pressable>
          <View className="flex-1">
            <View className="flex-row items-center">
              <Text
                className={`text-title font-bold text-content-primary ${patientIsUntitled ? 'italic text-content-tertiary' : ''}`}
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {patientLabel}
              </Text>
              {showHeaderPatientMetadataGlyph ? (
                <Sparkles color={colors.brand500} size={13} style={{ marginLeft: 5 }} />
              ) : null}
            </View>
          </View>
          <StatusBadge status={recording.status} />
        </View>

        {showMetadataReview && (
          <MetadataReviewCard
            recording={recording}
            mode="review"
            saving={metadataMutation.isPending}
            onConfirm={handleConfirmMetadata}
            onSave={handleSaveMetadata}
          />
        )}

        {showAddMetadata && (
          <MetadataReviewCard
            recording={recording}
            mode="add"
            saving={metadataMutation.isPending}
            onConfirm={handleConfirmMetadata}
            onSave={handleSaveMetadata}
          />
        )}

        {showEditMetadata && (
          <MetadataReviewCard
            recording={recording}
            mode="edit"
            saving={metadataMutation.isPending}
            onSave={handleSaveMetadata}
          />
        )}

        {/* Patient Info */}
        <Card className="m-5 mt-4">
          {recording.status === 'completed' && reviewStatus ? (
            <View className="flex-row items-center justify-between mb-3 pb-3 border-b border-border-default">
              <Text className="text-caption text-content-tertiary font-medium uppercase">
                Review
              </Text>
              <ReviewStatusChip
                status={reviewStatus}
                loading={reviewMutation.isPending}
                onPress={() => {
                  reviewMutation.mutate(reviewStatus !== 'reviewed');
                }}
              />
            </View>
          ) : null}
          <View className="flex-row flex-wrap">
            {renderInfoField('patientName', 'Patient', recording.patientName)}
            {/* pimsPatientId is vet-entered, never AI-filled → no sparkle (field null). */}
            {renderInfoField(null, 'Patient ID', recording.pimsPatientId, 'pl-2')}
            {renderInfoField('species', 'Species', recording.species)}
            {renderInfoField('breed', 'Breed', recording.breed, 'pl-2')}
            {renderInfoField('clientName', 'Client', recording.clientName)}
            {renderInfoField('appointmentType', 'Type', recording.appointmentType, 'pl-2')}
          </View>
          <Text className="text-caption text-content-tertiary">{formattedDate}</Text>
        </Card>

        {/* Audio playback — audioFileUrl exists from confirm-upload onward.
            Drafts are excluded (their audio is local; resume path owns it). */}
        {recording.audioFileUrl && recording.status !== 'draft' && id && (
          <RecordingAudioPlayer
            recordingId={id}
            initialDurationSeconds={recording.audioDurationSeconds}
          />
        )}

        {/* Reprocess — re-transcribe + regenerate SOAP with chosen models. Own card at top level so
            BOTH completed and failed (with audio) reach it; hidden until the backend returns a real,
            key/allow-list-filtered model list with a visible actual choice. The 202 body seeds
            status='uploaded' → the existing poller + ProcessingStepper take over. */}
        {id &&
          (recording.status === 'completed' || recording.status === 'failed') &&
          !!recording.audioFileUrl &&
          aiModels &&
          hasVisibleReprocessModelChoice(aiModels, {
            recordingForeignLanguage: recording.foreignLanguage,
          }) && (
            <ReprocessSheet
              recordingId={id}
              models={aiModels}
              canManage={canRecordAppointments(user?.role)}
              currentTranscriptionModel={recording.costBreakdown?.transcriptionModel}
              currentSoapModel={recording.costBreakdown?.modelUsed}
              recordingForeignLanguage={recording.foreignLanguage}
              onReprocessStarted={() => {
                pollingStartedAtRef.current = Date.now();
                pollAttemptsRef.current = 0;
              }}
            />
          )}

        {/* Processing Status */}
        {isProcessing && (
          <Card className="mx-5 mb-4">
            <Text className="text-body-lg font-semibold text-content-primary mb-1">
              {RECORDING_DETAIL_COPY.processingTitle}
            </Text>
            <Text className="text-body-sm text-content-tertiary mb-2">
              {RECORDING_DETAIL_COPY.processingBody}
            </Text>
            <ProcessingStepper currentStatus={recording.status} />
          </Card>
        )}

        {/* Stale processing warning — shown after 30 min of non-terminal status */}
        {isPollingStale && (
          <Card className="mx-5 mb-4 border-status-warning">
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-status-warning mb-1">
                  Processing is taking longer than expected
                </Text>
                <Text className="text-body-sm text-content-tertiary mb-2">
                  This may indicate a server issue. You can wait or retry processing.
                </Text>
                <View className="self-start">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => retryMutation.mutate()}
                    loading={retryMutation.isPending}
                  >
                    Retry Processing
                  </Button>
                </View>
              </View>
            </View>
          </Card>
        )}

        {/* Pending Metadata (Google Drive import awaiting details) */}
        {recording.status === 'pending_metadata' && (
          <Card className="mx-5 mb-4 border-status-warning">
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-status-warning mb-1">
                  {RECORDING_DETAIL_COPY.awaitingMetadataTitle}
                </Text>
                <Text className="text-body-sm text-content-tertiary">
                  {RECORDING_DETAIL_COPY.awaitingMetadataBody}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* Draft — two shapes depending on whether the audio is on this device.
            Resume path is reachable via normal card-tap routing in
            RecordingCard; this screen shows up when the audio isn't local,
            or when the user deep-linked here directly. */}
        {recording.status === 'draft' && draftResolved && (
          draftLocalSlotId ? (
            <Card className="mx-5 mb-4">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5"><FileText color={colors.brand500} size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-content-primary mb-1">
                    Finish Recording
                  </Text>
                  <Text className="text-body-sm text-content-tertiary mb-3">
                    This draft was saved on this device. Continue to review and
                    submit it for SOAP note generation.
                  </Text>
                  <View className="flex-row gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onPress={handleResumeDraft}
                      disabled={deleteMutation.isPending}
                      accessibilityLabel="Continue recording"
                    >
                      Continue Recording
                    </Button>
                    {recordingPermissions.canDelete ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onPress={confirmDeleteDraft}
                        loading={deleteMutation.isPending}
                        accessibilityLabel="Delete draft"
                      >
                        Delete Draft
                      </Button>
                    ) : (
                      <Text className="text-caption text-content-tertiary flex-1">
                        {deleteDraftBlockedReason}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            </Card>
          ) : (
            <Card className="mx-5 mb-4 border-status-warning">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-status-warning mb-1">
                    {RECORDING_DETAIL_COPY.audioNotOnDeviceTitle}
                  </Text>
                  <Text className="text-body-sm text-content-tertiary mb-3">
                    {RECORDING_DETAIL_COPY.audioNotOnDeviceBody}
                  </Text>
                  <View className="self-start">
                    {recordingPermissions.canDelete ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onPress={confirmDeleteDraft}
                        loading={deleteMutation.isPending}
                        accessibilityLabel="Delete draft"
                      >
                        Delete Draft
                      </Button>
                    ) : (
                      <Text className="text-caption text-content-tertiary">
                        {deleteDraftBlockedReason}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            </Card>
          )
        )}

        {/* Failed */}
        {recording.status === 'failed' && (
          <Animated.View entering={FadeInUp.duration(300)}>
            <Card className="mx-5 mb-4 border-status-danger">
              <Text className="text-body-lg font-semibold text-status-danger mb-1">
                {RECORDING_DETAIL_COPY.processingFailedTitle}
              </Text>
              <Text className="text-body-sm text-status-danger mb-3">
                {ERROR_COPY.processingFailedBody}
              </Text>
              <View className="self-start flex-row gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => retryMutation.mutate()}
                  loading={retryMutation.isPending}
                  accessibilityLabel="Retry processing"
                >
                  Retry
                </Button>
                {recording.errorMessage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      // Raw server error text stays off-screen (can be
                      // technical/PHI-adjacent); support gets it via clipboard.
                      copyWithAutoClear(recording.errorMessage ?? '').catch(() => {});
                    }}
                  >
                    {ERROR_COPY.copyDetails}
                  </Button>
                ) : null}
              </View>
            </Card>
          </Animated.View>
        )}

        {/* Transcript Quality Warnings */}
        {recording.status === 'completed' && Array.isArray(recording.qualityWarnings) && recording.qualityWarnings.length > 0 && (
          <Animated.View entering={FadeInUp.duration(300)}>
            <Card className="mx-5 mb-4 border-status-warning">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-status-warning mb-1">
                    Transcript Quality Warning
                  </Text>
                  {recording.qualityWarnings.map((warning, i) => (
                    <Text key={`warning-${i}-${warning}`} className="text-body-sm text-status-warning mb-1">
                      {warning}
                    </Text>
                  ))}
                </View>
              </View>
            </Card>
          </Animated.View>
        )}

        {recording.status === 'completed' && id && recordingTasks && recordingTasks.length > 0 && (
          <SuggestedTasksCard
            recordingId={id}
            tasks={recordingTasks}
            canManage={canRecordAppointments(user?.role)}
          />
        )}

        {recording.status === 'completed' && id && (
          <>
            {recordingPermissions.canExport && <ClientEmailCard recordingId={id} />}
            {recordingPermissions.canCopy && <TranslationCard recordingId={id} />}
          </>
        )}

        {/* Consult AI — outbound link to the Captivet web app; not tied to processing state or permissions */}
        {id && <ConsultAICard />}

        {/* SOAP Note */}
        {recording.status === 'completed' && (
          <View className="px-5 pb-8">
            {recording.errorCode === 'PARTIAL_GENERATION' && (
              <Animated.View entering={FadeInUp.duration(300)} className="mb-4">
                <Card className="border-status-warning">
                  <View className="flex-row items-start">
                    <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-status-warning mb-1">
                        Partial SOAP Note
                      </Text>
                      <Text className="text-body-sm text-content-tertiary mb-2">
                        One or more sections could not be generated. The note below may be incomplete.
                      </Text>
                      <View className="self-start">
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={confirmRegenerate}
                          loading={regenerateMutation.isPending}
                        >
                          Regenerate
                        </Button>
                      </View>
                    </View>
                  </View>
                </Card>
              </Animated.View>
            )}
            {hasTranscript && (
              <View className="flex-row bg-surface-sunken rounded-input p-1 mb-4">
                {(
                  [
                    { key: 'soap', label: TRANSCRIPT_COPY.toggleSoap },
                    { key: 'transcript', label: TRANSCRIPT_COPY.toggleTranscript },
                  ] as const
                ).map(({ key, label }) => (
                  <Pressable
                    key={key}
                    onPress={() => handleSelectNoteTab(key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: activeNoteTab === key }}
                    accessibilityLabel={`Show ${label}`}
                    className={`flex-1 items-center justify-center py-2 rounded-lg ${
                      activeNoteTab === key ? 'bg-surface-raised shadow-btn' : ''
                    }`}
                    style={{ minHeight: 40 }}
                  >
                    {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                    <Text
                      className={`text-body-sm ${
                        activeNoteTab === key
                          ? 'text-content-primary font-semibold'
                          : 'text-content-secondary'
                      }`}
                      style={{ flexShrink: 0, paddingRight: 2 }}
                    >
                      {`${label} `}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            {activeNoteTab === 'transcript' && hasTranscript ? (
              <TranscriptView transcript={recording.transcriptText ?? ''} />
            ) : isSoapNoteLoading ? (
              <View>
                {[1, 2, 3, 4].map((i) => (
                  <View key={i} className="border border-border-default rounded-input mb-2 p-3">
                    <Skeleton width="30%" height={16} className="mb-2" />
                    <SkeletonText lines={2} />
                  </View>
                ))}
              </View>
            ) : isSoapNoteError ? (
              <View className="py-5 items-center">
                <Text className="text-body text-status-danger mb-3">
                  Failed to load SOAP note.
                </Text>
                <Button variant="secondary" size="sm" onPress={() => { refetchSoapNote().catch(() => {}); }}>
                  Retry
                </Button>
              </View>
            ) : soapNote ? (
              <View>
                {recordingPermissions.canEdit && (
                  <View className="items-start mb-4">
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={confirmRegenerate}
                      loading={regenerateMutation.isPending}
                      icon={<RotateCcw color={colors.contentBody} size={14} />}
                    >
                      {REGENERATE_SOAP_COPY.button}
                    </Button>
                  </View>
                )}
                <SoapNoteView
                  soapNote={soapNote}
                  recordingId={id ?? undefined}
                  canEdit={recordingPermissions.canEdit}
                />
                {recordingPermissions.canExport && (
                  <ExportSheet soapNote={soapNote} recording={recording} />
                )}
              </View>
            ) : (
              <View className="py-5 items-center">
                <Text className="text-body text-content-tertiary">
                  SOAP note not available.
                </Text>
              </View>
            )}

          </View>
        )}
        </View>
      </ScrollView>
      {celebrate && <CelebrationBurst onComplete={() => setCelebrate(false)} />}
      <Toast
        message="SOAP note ready!"
        visible={showCompletionToast}
        onHide={() => setShowCompletionToast(false)}
      />
    </SafeAreaView>
  );
}

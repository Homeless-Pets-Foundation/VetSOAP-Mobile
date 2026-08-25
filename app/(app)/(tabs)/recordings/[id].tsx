import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  Alert,
  RefreshControl,
  AppState,
  BackHandler,
} from 'react-native';
import { Text } from '../../../../src/components/ui/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { ChevronLeft, AlertTriangle, FileText, LifeBuoy, RotateCcw, Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import {
  isRecordingAudioMissingError,
  recordingsApi,
} from '../../../../src/api/recordings';
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
import {
  AUDIO_PLAYER_COPY,
  ATTENTION_FEED_COPY,
  DELETE_RECORDING_COPY,
  ERROR_COPY,
  METADATA_REVIEW_COPY,
  RECORDING_DETAIL_COPY,
  REGENERATE_SOAP_COPY,
  TRANSCRIPT_COPY,
} from '../../../../src/constants/strings';
import { trackEvent } from '../../../../src/lib/analytics';
import {
  invalidateRecordingCaches,
  mergeRecordingIntoCachedLists,
  purgeDeletedRecordingCaches,
  removeRecordingFromCachedLists,
} from '../../../../src/lib/recordingQueryCache';
import {
  shouldEmitExtractionObserved,
  buildExtractionObservedProps,
  hasUnresolvedAiMetadataAttention,
  validAppliedFields,
} from '../../../../src/lib/recordFirstObservability';
import {
  getProcessingStaleness,
  metadataAttentionReasons,
  parseAttentionFocus,
  parseTimestampMs,
  type AttentionFocus,
} from '../../../../src/lib/attentionFeed';
import {
  findLocalRecoveryAnchor,
  type LocalRecoveryAnchor,
} from '../../../../src/lib/localRecordings';
import { getSubmitTimestamps, clearSubmitTimestamps } from '../../../../src/lib/submitTiming';
import { reportClientError } from '../../../../src/api/telemetry';
import { useRecordingPermissions } from '../../../../src/hooks/usePermissions';
import { canRecordAppointments } from '../../../../src/lib/recordingPermissions';
import { hasVisibleReprocessModelChoice } from '../../../../src/lib/aiModels';
import { getTasksRefetchInterval } from '../../../../src/lib/recordingTasks';
import { getRecordingRetryPresentation } from '../../../../src/lib/recordingRetryState';
import { useAuthUser } from '../../../../src/hooks/useAuth';
import { displayPatientName, isUntitledVisit } from '../../../../src/lib/recordingDisplay';
import { PERSIST_GC_TIME_MS } from '../../../../src/lib/queryPersistence';
import type { RecordingMetadataField, UpdateRecordingMetadata } from '../../../../src/types';
import { CLIP_SAFE, clipSafe } from '../../../../src/components/ui/styles';

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
  const { id, from, focus } = useLocalSearchParams<{ id: string; from?: string; focus?: string }>();
  // Route params are untrusted: `focus` is allowlisted, and the analytics
  // source is derived from the validated route value — never echoed back raw.
  const requestedFocus = parseAttentionFocus(focus);
  const cameFromAttention = from === 'attention';
  const router = useRouter();
  const queryClient = useQueryClient();
  const { iconMd } = useResponsive();
  const colors = useThemeColors();
  const user = useAuthUser();
  const recordFirstEnabled = user?.capabilities?.includes('record_first') ?? false;

  const appStateRef = useRef(AppState.currentState);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  // Row-age staleness needs its own clock: polling stops after 30 minutes, and
  // an attention tap must not have to wait another 30 minutes to reveal Retry.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pollingStartedAtRef = useRef<number | null>(null);
  // A definitive 403 (access revoked) or 404 (deleted) means the cached
  // transcript/SOAP/audio must NOT keep showing — set once, then the query is
  // disabled (so eviction below can't trigger a refetch loop) and the render
  // falls to a terminal screen instead of the offline-cache fallback (Codex
  // P1, PR #143).
  const [accessRevoked, setAccessRevoked] = useState<{ status: number } | null>(null);
  const [retryAudioMissing, setRetryAudioMissing] = useState(false);
  useEffect(() => {
    setAccessRevoked(null); // reset when navigating to a different recording
    setRetryAudioMissing(false);
    pollingStartedAtRef.current = null;
  }, [id]);

  // Completion celebration — fired ONCE on the prev !== 'completed' →
  // 'completed' transition (the query polls/refetches, so guard against the
  // status settling re-firing every render).
  const [celebrate, setCelebrate] = useState(false);
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      try {
        appStateRef.current = nextState;
        setIsAppActive(nextState === 'active');
        if (nextState === 'active') setNowMs(Date.now());
      } catch {
        // A listener throw would tear down the subscription.
      }
    });
    return () => {
      sub.remove();
    };
  }, []);

  const { data: recording, isLoading, isError, error, refetch: refetchRecording, isRefetching: isRefetchingRecording } = useQuery({
    queryKey: ['recording', id],
    queryFn: () => recordingsApi.get(id!),
    enabled: !!id && !accessRevoked,
    // Survives into the persisted offline snapshot (WP28).
    gcTime: PERSIST_GC_TIME_MS,
    refetchInterval: (query) => {
      if (!isAppActive) return false;
      const status = query.state.data?.status;
      if (!status || ['completed', 'failed', 'pending_metadata', 'draft'].includes(status)) {
        pollingStartedAtRef.current = null;
        return false;
      }
      if (!pollingStartedAtRef.current) {
        pollingStartedAtRef.current = Date.now();
      }
      const elapsedMs = Date.now() - pollingStartedAtRef.current;
      if (elapsedMs > 30 * 60 * 1000) {
        return false; // Stop polling — stale processing
      }
      // Time-based backoff derived from the poll session's start: 5s for the
      // first ~20s, then elapsed/4, capped at 60s. React Query re-evaluates
      // this callback on unrelated observer/state updates, so a mutating
      // attempts counter (and before it, lifetime dataUpdateCount) advanced
      // the backoff without any actual poll (Codex P2, PR #143); elapsed time
      // is deterministic no matter how often this runs.
      return Math.min(60_000, Math.max(5_000, elapsedMs / 4));
    },
  });

  // Catch a definitive access-revoked / deleted response and latch it.
  useEffect(() => {
    if (accessRevoked) return;
    if (isError && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      setAccessRevoked({ status: error.status });
    }
  }, [isError, error, accessRevoked]);

  // Once latched, purge the revoked/deleted record from the cache (and the
  // persisted snapshot) so it can't render offline on the next launch. The
  // query is already disabled above, so this can't spawn a refetch loop.
  useEffect(() => {
    if (!accessRevoked || !id) return;
    queryClient.removeQueries({ queryKey: ['recording', id] });
    queryClient.removeQueries({ queryKey: ['soapNote', id] });
    queryClient.removeQueries({ queryKey: ['recordingTasks', id] });
    // Also strip it from cached list pages, or its patient/client metadata
    // still renders offline in the Recordings list (Codex P1, PR #143).
    removeRecordingFromCachedLists(queryClient, id);
  }, [accessRevoked, id, queryClient]);

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
    gcTime: PERSIST_GC_TIME_MS,
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
    gcTime: PERSIST_GC_TIME_MS,
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

  // Status-aware ROW AGE, not "30 minutes since this screen began polling".
  // The old presentation made an attention tap wait another 30 minutes before
  // revealing the action the feed had already promised. Detail knows
  // `audioFileUrl`, so it uses the exact audio-aware window (5 min for a
  // committed upload) where the list-shaped feed must stay conservative.
  const processingStaleness = getProcessingStaleness({
    status: recording?.status ?? 'completed',
    updatedAtMs: parseTimestampMs(recording?.updatedAt),
    nowMs,
    audioAvailability: recording?.audioFileUrl ? 'known_present' : 'known_absent',
  });
  const isPollingStale = processingStaleness === 'stale';
  const recordingPermissions = useRecordingPermissions(recording);
  const canRetryProcessing = canRecordAppointments(user?.role);
  const retryPresentation = recording
    ? getRecordingRetryPresentation({
        status: recording.status,
        audioFileUrl: recording.audioFileUrl,
        isPollingStale,
        audioMissingError: retryAudioMissing,
      })
    : 'hidden';

  // Tick while a processing row can still cross its stale threshold. Stops in
  // the background and once the status settles.
  useEffect(() => {
    if (!isAppActive) return;
    if (processingStaleness !== 'fresh') return;
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isAppActive, processingStaleness]);

  const retryMutation = useMutation({
    mutationFn: () => recordingsApi.retry(id!),
    onSuccess: (updatedRecording) => {
      setRetryAudioMissing(false);
      if (id && updatedRecording?.id === id) {
        queryClient.setQueryData(['recording', id], updatedRecording);
        mergeRecordingIntoCachedLists(queryClient, updatedRecording);
        pollingStartedAtRef.current = null;
              }
      queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
      invalidateRecordingCaches(queryClient, 'processing_retry');
    },
    onError: (error: Error) => {
      if (isRecordingAudioMissingError(error)) {
        // Expected business outcome: the audio disappeared after render.
        // Switch to the same non-retry state without reporting an exception.
        setRetryAudioMissing(true);
        queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
        return;
      }
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

  // Bounded, PHI-free encoding of the PRE-mutation AI reason set. Field
  // association only (e.g. `breed:low_confidence`) — never a value.
  const MAX_REPORTED_REASON_CODES = 12;
  const preMutationReasonCodes = useCallback((): string => {
    if (!recording) return '';
    const codes = metadataAttentionReasons(recording, { recordFirstEnabled }).map((reason) => {
      const code = reason.code.startsWith('metadata_')
        ? reason.code.slice('metadata_'.length)
        : reason.code;
      return reason.field ? `${reason.field}:${code}` : code;
    });
    return Array.from(new Set(codes)).slice(0, MAX_REPORTED_REASON_CODES).join(',');
  }, [recording, recordFirstEnabled]);

  const metadataMutation = useMutation({
    mutationFn: (vars: {
      payload: UpdateRecordingMetadata;
      action: 'confirmed' | 'corrected' | 'dismissed';
      correctedFieldCount: number;
      changedFields: RecordingMetadataField[];
      wasUnresolvedBefore: boolean;
      reasonCodes: string;
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
      // ONLY a real AI-review resolution counts. Firing on every metadata save
      // — including an ordinary edit long after the review was confirmed —
      // polluted the correction KPI the extraction tuning depends on.
      const stillUnresolved = updatedRecording
        ? hasUnresolvedAiMetadataAttention(updatedRecording)
        : true;
      if (vars.wasUnresolvedBefore && !stillUnresolved) {
        trackEvent({
          name: 'ai_metadata_review_resolved',
          props: {
            action: vars.action,
            corrected_field_count: vars.correctedFieldCount,
            source: cameFromAttention ? 'attention_feed' : 'recording_detail',
            changed_fields: vars.changedFields.join(','),
            attention_reason_codes: vars.reasonCodes,
          },
        });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert(
        'Save Failed',
        METADATA_REVIEW_COPY.failed
      );
    },
  });

  const handleConfirmMetadata = useCallback(() => {
    metadataMutation.mutate({
      payload: { review: 'confirmed' },
      action: 'confirmed',
      correctedFieldCount: 0,
      changedFields: [],
      wasUnresolvedBefore: !!recording && hasUnresolvedAiMetadataAttention(recording),
      reasonCodes: preMutationReasonCodes(),
    });
  }, [metadataMutation, preMutationReasonCodes, recording]);

  const handleDismissMetadata = useCallback(() => {
    metadataMutation.mutate({
      payload: { review: 'dismissed' },
      action: 'dismissed',
      correctedFieldCount: 0,
      changedFields: [],
      wasUnresolvedBefore: !!recording && hasUnresolvedAiMetadataAttention(recording),
      reasonCodes: preMutationReasonCodes(),
    });
  }, [metadataMutation, preMutationReasonCodes, recording]);

  const handleSaveMetadata = useCallback(
    (
      payload: UpdateRecordingMetadata,
      correctedFieldCount: number,
      changedFields: RecordingMetadataField[]
    ) => {
      metadataMutation.mutate({
        payload,
        action: 'corrected',
        correctedFieldCount,
        changedFields,
        wasUnresolvedBefore: !!recording && hasUnresolvedAiMetadataAttention(recording),
        reasonCodes: preMutationReasonCodes(),
      });
    },
    [metadataMutation, preMutationReasonCodes, recording]
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

  // Attention-feed focus: scroll to the EXISTING source card once it lays out.
  // The parameter only chooses a scroll target — it can never render a card the
  // permission gates below would not have rendered anyway.
  const scrollRef = useRef<ScrollView>(null);
  const focusTargetsRef = useRef<Record<AttentionFocus, number | null>>({
    metadata: null,
    processing: null,
    quality: null,
  });
  const focusAppliedRef = useRef(false);

  useEffect(() => {
    focusTargetsRef.current = { metadata: null, processing: null, quality: null };
    focusAppliedRef.current = false;
  }, [id]);

  const registerFocusTarget = useCallback(
    (target: AttentionFocus, y: number) => {
      focusTargetsRef.current[target] = y;
      if (!requestedFocus || focusAppliedRef.current) return;
      const offset = focusTargetsRef.current[requestedFocus];
      if (offset === null || !Number.isFinite(offset)) return;
      focusAppliedRef.current = true;
      scrollRef.current?.scrollTo({ y: Math.max(0, offset - 12), animated: true });
    },
    [requestedFocus]
  );

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

  /**
   * On-device recovery anchor for an audio-unavailable server row. Answers:
   * does THIS device, for the SIGNED-IN account, still hold a recoverable copy?
   *
   * While it is loading — and whenever it comes back `unknown` — there is NO
   * destructive button. `none` is the only result that unlocks deletion, and
   * even then the confirmation says the check cannot see other devices or
   * accounts.
   */
  const [localAnchor, setLocalAnchor] = useState<LocalRecoveryAnchor | null>(null);
  const [anchorAttempt, setAnchorAttempt] = useState(0);
  const needsAnchorCheck =
    !!id &&
    !!recording &&
    recording.status !== 'draft' &&
    retryPresentation === 'audio_unavailable';

  useEffect(() => {
    if (!needsAnchorCheck || !id || !user?.id) {
      setLocalAnchor(null);
      return;
    }
    let cancelled = false;
    setLocalAnchor(null);
    findLocalRecoveryAnchor(user, id)
      .then((anchor) => {
        if (!cancelled) setLocalAnchor(anchor);
      })
      .catch(() => {
        // Fail closed: an unexpected throw is an ambiguous read, not "none".
        if (!cancelled) setLocalAnchor({ kind: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [needsAnchorCheck, id, user, anchorAttempt]);

  const recheckLocalAnchor = useCallback(() => {
    setAnchorAttempt((attempt) => attempt + 1);
  }, []);

  const openAnchorDestination = useCallback(() => {
    if (!localAnchor) return;
    Haptics.selectionAsync().catch(() => {});
    switch (localAnchor.kind) {
      case 'draft':
        router.navigate(`/record?draftSlotId=${localAnchor.draftSlotId}` as never);
        return;
      case 'saved_session':
        router.navigate('/record' as never);
        return;
      case 'durable_recovery':
        router.push('/durable-recovery' as never);
        return;
      case 'support_recovery':
        router.push('/recording-recovery' as never);
        return;
      default:
    }
  }, [localAnchor, router]);

  // Record-first product observability. Fires once per completed record-first
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
  }, [id, recordFirstEnabled, recording]);

  // Uses the SHARED unresolved-AI predicate — not `needsMetadataReview`, whose
  // incomplete gate hides the `review: 'none'` low-confidence cohort entirely.
  useEffect(() => {
    if (!id || recording?.status !== 'completed') return;
    if (!hasUnresolvedAiMetadataAttention(recording)) return;
    if (metadataReviewShownIdsRef.current.has(id)) return;
    metadataReviewShownIdsRef.current.add(id);
    trackEvent({
      name: 'ai_metadata_review_shown',
      props: { applied_field_count: validAppliedFields(recording).length },
    });
  }, [id, recording]);

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
      if (recording?.status === 'draft') {
        invalidateRecordingCaches(queryClient, 'draft_deleted');
        queryClient.removeQueries({ queryKey: ['recording', id] });
      } else if (id) {
        // A non-draft delete CASCADES the SOAP note and tasks server-side.
        // Purge every terminal consumer (and the linked patient's cached visit
        // pages) BEFORE navigating, or offline clinical content for a deleted
        // recording survives in the persisted snapshot.
        purgeDeletedRecordingCaches(queryClient, {
          recordingId: id,
          patientId: recording?.patientId ?? null,
        });
      }
      router.navigate('/recordings');
    },
    onError: (error: Error) => {
      if (id) {
        reportClientError({
          // The destructive non-draft path gets its OWN phase: sharing
          // `delete_draft` made a regression in it indistinguishable from
          // ordinary draft cleanup in both the rate-limit key and the
          // dashboards.
          phase: recording?.status === 'draft' ? 'delete_draft' : 'delete_recording',
          severity: 'error',
          errorCode: error instanceof ApiError ? error.code ?? String(error.status) : 'unknown',
          message: error instanceof Error ? error.message : 'Recording delete failed',
          recordingId: id,
        });
      }
      Alert.alert(
        'Delete Failed',
        error instanceof ApiError ? error.message : DELETE_RECORDING_COPY.deleteFailed
      );
    },
  });

  const confirmDeleteDraft = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert(DELETE_RECORDING_COPY.draftTitle, DELETE_RECORDING_COPY.draftBody, [
      { text: DELETE_RECORDING_COPY.cancel, style: 'cancel' },
      {
        text: DELETE_RECORDING_COPY.delete,
        style: 'destructive',
        onPress: () => {
          deleteMutation.mutate();
        },
      },
    ]);
  }, [deleteMutation]);

  /**
   * Delete an audio-unavailable placeholder. Reachable ONLY after a proven
   * "no matching anchor on this device for this account" result; the copy is
   * explicit that other devices/accounts are outside the check, and that the
   * SOAP note and tasks go with it.
   */
  const confirmDeleteUnavailableRecording = useCallback(() => {
    const isAuthor = !!user?.id && recording?.userId === user.id;
    const body = isAuthor
      ? DELETE_RECORDING_COPY.unavailableBody
      : `${DELETE_RECORDING_COPY.unavailableBody}${DELETE_RECORDING_COPY.colleagueSuffix}`;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert(DELETE_RECORDING_COPY.unavailableTitle, body, [
      { text: DELETE_RECORDING_COPY.cancel, style: 'cancel' },
      {
        text: DELETE_RECORDING_COPY.delete,
        style: 'destructive',
        onPress: () => {
          deleteMutation.mutate();
        },
      },
    ]);
  }, [deleteMutation, recording?.userId, user?.id]);

  const handleResumeDraft = useCallback(() => {
    if (!draftLocalSlotId) return;
    Haptics.selectionAsync().catch(() => {});
    router.navigate(`/record?draftSlotId=${draftLocalSlotId}` as never);
  }, [draftLocalSlotId, router]);

  // Back respects where the user came from (Home, patient history) instead of
  // always dumping them on the Recordings list. Exception: a post-submit push
  // (`from=submit`) sits on top of the just-reset Record form, so a plain
  // router.back() would land on an empty form — route those to the recordings
  // list explicitly (Codex P2, PR #143).
  const goBack = useCallback(() => {
    if (from === 'submit') {
      router.replace('/recordings');
      return;
    }
    // Feed entries route deterministically. `router.back()` follows the ROOT
    // navigator history, which on a cross-tab entry undoes the TAB SWITCH
    // instead of popping this screen — that is what stranded the Recordings tab
    // on a detail whose list could never be reached again (verified on an
    // Android emulator). The feed now lives at `/recordings/attention`, INSIDE
    // this tab's stack, so naming it is both correct and stable.
    if (cameFromAttention) {
      router.replace('/recordings/attention' as never);
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    // A deep link / cold start has no history to pop.
    router.replace('/recordings');
  }, [router, from, cameFromAttention]);

  // Android hardware back must take the SAME route as the header control.
  useFocusEffect(
    useCallback(() => {
      if (!cameFromAttention) return;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        router.replace('/recordings/attention' as never);
        return true;
      });
      return () => subscription.remove();
    }, [cameFromAttention, router])
  );

  const startNewRecording = useCallback(() => {
    router.push('/record');
  }, [router]);

  // Access revoked (403) or deleted (404): terminal even with cached data —
  // never keep rendering the cached transcript/SOAP/audio once the server has
  // definitively denied access (Codex P1, PR #143). No Retry (it would just
  // re-deny); the record is already evicted above.
  if (accessRevoked) {
    return (
      <SafeAreaView className="screen justify-center items-center p-5">
        <Animated.View entering={FadeIn.duration(300)} className="items-center">
          <Text className="text-body-lg font-semibold text-status-danger mb-2">
            {accessRevoked.status === 404 ? 'Recording not available' : 'Access unavailable'}
          </Text>
          <Text className="text-body text-content-tertiary text-center mb-4">
            {accessRevoked.status === 404
              ? 'This recording is no longer available. It may have been deleted.'
              : 'You no longer have access to this recording.'}
          </Text>
          <Button variant="primary" onPress={goBack}>
            Go Back
          </Button>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // Otherwise a terminal error only when nothing is cached: with offline
  // persistence a transient/offline failed refetch coexists with restored data
  // — render the recording, not the failure screen (Codex P1, PR #143).
  if (isError && !recording) {
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
  const anchorRecoverable =
    localAnchor?.kind === 'draft' ||
    localAnchor?.kind === 'saved_session' ||
    localAnchor?.kind === 'durable_recovery' ||
    localAnchor?.kind === 'support_recovery';
  const anchorActionLabel =
    localAnchor?.kind === 'draft'
      ? DELETE_RECORDING_COPY.resumeDraft
      : localAnchor?.kind === 'saved_session'
        ? DELETE_RECORDING_COPY.openSavedSessions
        : DELETE_RECORDING_COPY.openRecovery;
  const hasTranscript =
    recording.status === 'completed' &&
    typeof recording.transcriptText === 'string' &&
    recording.transcriptText.trim().length > 0;
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
  // Deliberately NOT gated on the current `record_first` capability: disabling
  // future record-first capture must not orphan existing AI review work. Only
  // the ambiguous null-extraction add/empty state below stays capability-gated.
  // `canEdit` still gates every mutation affordance (the server enforces the
  // same author/owner/admin rule on PATCH /:id/metadata).
  const showMetadataReview =
    recordingPermissions.canEdit &&
    recording.status === 'completed' &&
    hasUnresolvedAiMetadataAttention(recording);
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
  // A practice-wide (read-only) attention row still navigates here. Without
  // this the destination shows NO trace of what the feed flagged, so the tap
  // reads as a dead end. Informational only — every mutation affordance stays
  // behind `canEdit`, and the copy names who can actually fix it.
  //
  // Derived from the SAME reason builder the feed uses, not from
  // `hasUnresolvedAiMetadataAttention` — that predicate returns false for the
  // `aiExtractedMetadata === null` cohort, which the feed still surfaces as
  // `metadata_missing` when record-first is enabled. Gating on the predicate
  // therefore left exactly those practice-wide rows landing on a screen with no
  // trace of what was flagged. Mirroring the builder makes the two agree by
  // construction (it applies the same capability gate to that null cohort).
  const readOnlyMetadataReasons =
    !recordingPermissions.canEdit && recording.status === 'completed'
      ? metadataAttentionReasons(recording, { recordFirstEnabled })
      : [];
  const showMetadataReadOnlyNotice = readOnlyMetadataReasons.length > 0;
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
        numberOfLines={field === 'clientName' ? 2 : undefined}
      >
        {value}
      </Text>
    </View>
  ) : null;

  return (
    <SafeAreaView className="screen">
      <ScrollView
        ref={scrollRef}
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
          <View onLayout={(event) => registerFocusTarget('metadata', event.nativeEvent.layout.y)}>
            <MetadataReviewCard
              recording={recording}
              mode="review"
              recordFirstEnabled={recordFirstEnabled}
              saving={metadataMutation.isPending}
              onConfirm={handleConfirmMetadata}
              onDismiss={handleDismissMetadata}
              onSave={handleSaveMetadata}
            />
          </View>
        )}

        {showAddMetadata && (
          <View onLayout={(event) => registerFocusTarget('metadata', event.nativeEvent.layout.y)}>
            <MetadataReviewCard
              recording={recording}
              mode="add"
              recordFirstEnabled={recordFirstEnabled}
              saving={metadataMutation.isPending}
              onSave={handleSaveMetadata}
            />
          </View>
        )}

        {showEditMetadata && (
          <MetadataReviewCard
            recording={recording}
            mode="edit"
            recordFirstEnabled={recordFirstEnabled}
            saving={metadataMutation.isPending}
            onSave={handleSaveMetadata}
          />
        )}

        {showMetadataReadOnlyNotice && (
          <View onLayout={(event) => registerFocusTarget('metadata', event.nativeEvent.layout.y)}>
            <Card className="mx-5 mb-4 border-status-warning">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5" style={{ flexShrink: 0 }}>
                  <AlertTriangle color={colors.warning600} size={18} />
                </View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-status-warning mb-1">
                    {METADATA_REVIEW_COPY.reasonsTitle}
                  </Text>
                  {readOnlyMetadataReasons.map((reason) => (
                    <Text
                      key={`${reason.code}:${reason.field ?? 'none'}`}
                      className="text-body-sm text-content-secondary mb-1"
                      numberOfLines={3}
                    >
                      {reason.message}
                    </Text>
                  ))}
                  <Text className="text-caption text-content-tertiary mt-1" numberOfLines={2}>
                    {ATTENTION_FEED_COPY.readOnlyNote}
                  </Text>
                </View>
              </View>
            </Card>
          </View>
        )}

        {/* Patient Info */}
        <Card className="m-5 mt-4">
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
          recordingPermissions.canPlayAudio ? (
            <RecordingAudioPlayer
              recordingId={id}
              initialDurationSeconds={recording.audioDurationSeconds}
            />
          ) : (
            <Card className="mx-5 mb-4">
              <Text className="text-body-lg font-semibold text-content-primary mb-1">
                {AUDIO_PLAYER_COPY.title}
              </Text>
              <Text className="text-body-sm text-content-tertiary">
                {AUDIO_PLAYER_COPY.forbidden}
              </Text>
            </Card>
          )
        )}

        {retryPresentation === 'audio_unavailable' && (
          <View onLayout={(event) => registerFocusTarget('processing', event.nativeEvent.layout.y)}>
            <Card className="mx-5 mb-4 border-status-warning">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5">
                  {anchorRecoverable ? (
                    <LifeBuoy color={colors.warning600} size={18} />
                  ) : (
                    <AlertTriangle color={colors.warning600} size={18} />
                  )}
                </View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-status-warning mb-1">
                    Audio unavailable
                  </Text>
                  <Text className="text-body-sm text-content-tertiary mb-3">
                    This recording no longer has audio to process. Start a new recording to continue.
                  </Text>

                  {/* A proven on-device copy always wins over deletion. */}
                  {anchorRecoverable ? (
                    <View className="self-start">
                      <Button
                        variant="primary"
                        size="sm"
                        onPress={openAnchorDestination}
                        accessibilityLabel={anchorActionLabel}
                      >
                        {anchorActionLabel}
                      </Button>
                    </View>
                  ) : null}

                  {/* Loading or ambiguous → guidance + recheck, never a delete. */}
                  {!localAnchor || localAnchor.kind === 'unknown' ? (
                    <View>
                      <Text className="text-body-sm text-content-tertiary mb-2">
                        {localAnchor?.kind === 'unknown'
                          ? DELETE_RECORDING_COPY.unknownLocalState
                          : DELETE_RECORDING_COPY.checking}
                      </Text>
                      {localAnchor?.kind === 'unknown' ? (
                        <View className="self-start">
                          <Button variant="secondary" size="sm" onPress={recheckLocalAnchor}>
                            {DELETE_RECORDING_COPY.recheck}
                          </Button>
                        </View>
                      ) : null}
                    </View>
                  ) : null}

                  {localAnchor?.kind === 'none' && !recordingPermissions.canDelete ? (
                    <Text className="text-body-sm text-content-tertiary mb-2">
                      {DELETE_RECORDING_COPY.coordinate}
                    </Text>
                  ) : null}

                  <View className="flex-row flex-wrap gap-2 mt-1">
                    {/* Start-new remediation is role-gated too: the server
                        rejects a recording attempt from support staff. */}
                    {canRetryProcessing ? (
                      <Button
                        variant={anchorRecoverable ? 'secondary' : 'primary'}
                        size="sm"
                        onPress={startNewRecording}
                        accessibilityLabel="Start new recording"
                      >
                        Start New Recording
                      </Button>
                    ) : null}
                    {localAnchor?.kind === 'none' && recordingPermissions.canDelete ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onPress={confirmDeleteUnavailableRecording}
                        loading={deleteMutation.isPending}
                        accessibilityLabel={DELETE_RECORDING_COPY.deleteUnavailable}
                      >
                        {DELETE_RECORDING_COPY.deleteUnavailable}
                      </Button>
                    ) : null}
                  </View>
                </View>
              </View>
            </Card>
          </View>
        )}

        {/* Reprocess — re-transcribe + regenerate SOAP with chosen models. Own card at top level so
            BOTH completed and failed (with audio) reach it; hidden until the backend returns a real,
            key/allow-list-filtered model list with a visible actual choice. The 202 body seeds
            status='uploaded' → the existing poller + ProcessingStepper take over. */}
        {id &&
          (recording.status === 'completed' || recording.status === 'failed') &&
          !!recording.audioFileUrl &&
          retryPresentation !== 'audio_unavailable' &&
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
                              }}
            />
          )}

        {/* Processing Status */}
        {isProcessing && (
          <Card
            className="mx-5 mb-4"
            onLayout={(event) => registerFocusTarget('processing', event.nativeEvent.layout.y)}
          >
            <Text className="text-body-lg font-semibold text-content-primary mb-1">
              {RECORDING_DETAIL_COPY.processingTitle}
            </Text>
            <Text className="text-body-sm text-content-tertiary mb-2">
              {RECORDING_DETAIL_COPY.processingBody}
            </Text>
            <ProcessingStepper currentStatus={recording.status} />
          </Card>
        )}

        {recording.status === 'retry_scheduled' &&
          !isPollingStale &&
          retryPresentation === 'retry' && (
            <Card
              className="mx-5 mb-4 border-status-warning"
              onLayout={(event) => registerFocusTarget('processing', event.nativeEvent.layout.y)}
            >
              <Text className="text-body font-semibold text-status-warning mb-1">
                Retry scheduled
              </Text>
              <Text className="text-body-sm text-content-tertiary mb-3">
                Processing will retry automatically. You can also retry it now.
              </Text>
              {/* POST /:id/retry is org-scoped for owner/admin/veterinarian and
                  does NOT require authorship — but support staff would be
                  rejected, so never show them the control. */}
              {canRetryProcessing ? (
                <View className="self-start">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => retryMutation.mutate()}
                    loading={retryMutation.isPending}
                  >
                    Retry Now
                  </Button>
                </View>
              ) : null}
            </Card>
          )}

        {/* Stale processing warning — shown after 30 min of non-terminal status */}
        {isPollingStale && retryPresentation === 'retry' && (
          <Card
            className="mx-5 mb-4 border-status-warning"
            onLayout={(event) => registerFocusTarget('processing', event.nativeEvent.layout.y)}
          >
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color={colors.warning600} size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-status-warning mb-1">
                  Processing is taking longer than expected
                </Text>
                <Text className="text-body-sm text-content-tertiary mb-2">
                  This may indicate a server issue. You can wait or retry processing.
                </Text>
                {canRetryProcessing ? (
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
                ) : null}
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
                  {/* self-start shrink-wraps this wrapper to its content, which is right
                      for the Button branch but starves the Text branch of width. That
                      Text is the only explanation the user gets for why the destructive
                      action is unavailable, so it takes the full row instead
                      (CLAUDE.md > UI Gotchas). numberOfLines stays unset — the reason is
                      a sentence and should wrap, not ellipsize. */}
                  {recordingPermissions.canDelete ? (
                    <View className="self-start">
                      <Button
                        variant="danger"
                        size="sm"
                        onPress={confirmDeleteDraft}
                        loading={deleteMutation.isPending}
                        accessibilityLabel="Delete draft"
                      >
                        Delete Draft
                      </Button>
                    </View>
                  ) : (
                    <Text className="text-caption text-content-tertiary w-full">
                      {deleteDraftBlockedReason}
                    </Text>
                  )}
                </View>
              </View>
            </Card>
          )
        )}

        {/* Failed */}
        {recording.status === 'failed' && (
          <Animated.View
            entering={FadeInUp.duration(300)}
            onLayout={(event) => registerFocusTarget('processing', event.nativeEvent.layout.y)}
          >
            <Card className="mx-5 mb-4 border-status-danger">
              <Text className="text-body-lg font-semibold text-status-danger mb-1">
                {RECORDING_DETAIL_COPY.processingFailedTitle}
              </Text>
              <Text className="text-body-sm text-status-danger mb-3">
                {ERROR_COPY.processingFailedBody}
              </Text>
              <View className="self-start flex-row gap-2">
                {retryPresentation === 'retry' && canRetryProcessing && (
                  <Button
                    variant="primary"
                    size="sm"
                    onPress={() => retryMutation.mutate()}
                    loading={retryMutation.isPending}
                    accessibilityLabel="Retry processing"
                  >
                    Retry
                  </Button>
                )}
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
          <Animated.View
            entering={FadeInUp.duration(300)}
            onLayout={(event) => registerFocusTarget('quality', event.nativeEvent.layout.y)}
          >
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
                      style={CLIP_SAFE}
                    >
                      {clipSafe(label)}
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

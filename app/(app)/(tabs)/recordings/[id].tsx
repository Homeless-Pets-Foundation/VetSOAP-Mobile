import React, { useCallback, useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable, Alert, RefreshControl, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp, ZoomIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { ChevronLeft, Check, AlertTriangle, FileText } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { recordingsApi } from '../../../../src/api/recordings';
import { ApiError } from '../../../../src/api/client';
import { StatusBadge } from '../../../../src/components/StatusBadge';
import { SoapNoteView } from '../../../../src/components/SoapNoteView';
import { Button } from '../../../../src/components/ui/Button';
import { Card } from '../../../../src/components/ui/Card';
import { Skeleton, SkeletonText } from '../../../../src/components/ui/Skeleton';
import { draftStorage } from '../../../../src/lib/draftStorage';
import { fileExists } from '../../../../src/lib/fileOps';
import { PROCESSING_STEP_LABELS } from '../../../../src/constants/strings';

const PROCESSING_STEPS = [
  { status: 'uploading', label: PROCESSING_STEP_LABELS.uploading },
  { status: 'uploaded', label: PROCESSING_STEP_LABELS.uploaded },
  { status: 'transcribing', label: PROCESSING_STEP_LABELS.transcribing },
  { status: 'generating', label: PROCESSING_STEP_LABELS.generating },
  { status: 'completed', label: PROCESSING_STEP_LABELS.completed },
] as const;

const STATUS_ORDER = ['uploading', 'uploaded', 'transcribing', 'transcribed', 'generating', 'completed'];

function ProcessingStepper({ currentStatus }: { currentStatus: string }) {
  if (currentStatus === 'failed') return null;

  const currentIndex = STATUS_ORDER.indexOf(currentStatus);

  return (
    <View className="my-4">
      {PROCESSING_STEPS.map((step, i) => {
        const stepIndex = STATUS_ORDER.indexOf(step.status);
        const isComplete = currentIndex > stepIndex;
        const isCurrent = currentIndex === stepIndex;
        const isLast = i === PROCESSING_STEPS.length - 1;

        return (
          <View key={step.status}>
            <View
              className="flex-row items-center mb-1"
              accessibilityLabel={`${step.label}: ${isComplete ? 'complete' : isCurrent ? 'in progress' : 'pending'}`}
            >
              <View
                className={`w-6 h-6 rounded-full justify-center items-center mr-3 ${
                  isComplete
                    ? 'bg-brand-500'
                    : isCurrent
                      ? 'bg-warning-100 border-2 border-warning-500'
                      : 'bg-stone-100'
                }`}
              >
                {isComplete && (
                  <Animated.View entering={ZoomIn.duration(300)}>
                    <Check color="#fff" size={14} strokeWidth={3} />
                  </Animated.View>
                )}
                {isCurrent && (
                  <View className="w-2 h-2 rounded-full bg-warning-500" />
                )}
              </View>
              <Text
                numberOfLines={2}
                className={`flex-1 text-body ${
                  isComplete
                    ? 'text-brand-500 font-medium'
                    : isCurrent
                      ? 'text-warning-700 font-semibold'
                      : 'text-stone-400'
                }`}
              >
                {step.label}
              </Text>
            </View>
            {!isLast && (
              <View className="ml-[11px] mb-1">
                <View
                  className={`w-0.5 h-4 ${
                    isComplete ? 'bg-brand-500' : 'bg-stone-200'
                  }`}
                />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

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

  const appStateRef = useRef(AppState.currentState);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const pollingStartedAtRef = useRef<number | null>(null);

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
        return false;
      }
      if (!pollingStartedAtRef.current) {
        pollingStartedAtRef.current = Date.now();
      }
      const elapsedMs = Date.now() - pollingStartedAtRef.current;
      if (elapsedMs > 30 * 60 * 1000) {
        return false; // Stop polling — stale processing
      }
      // Exponential backoff: 5s → 7.5s → 11.25s → … capped at 60s
      const attempts = query.state.dataUpdateCount;
      return Math.min(5_000 * Math.pow(1.5, attempts), 60_000);
    },
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

  const handleRefresh = useCallback(() => {
    refetchRecording().catch(() => {});
    refetchSoapNote().catch(() => {});
  }, [refetchRecording, refetchSoapNote]);

  const isPollingStale =
    !!pollingStartedAtRef.current &&
    Date.now() - pollingStartedAtRef.current > 30 * 60 * 1000 &&
    !['completed', 'failed', 'pending_metadata', 'draft'].includes(recording?.status ?? '');

  const retryMutation = useMutation({
    mutationFn: () => recordingsApi.retry(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
    },
    onError: (error: Error) => {
      Alert.alert(
        'Retry Failed',
        error instanceof ApiError ? error.message : 'An unexpected error occurred. Please try again.'
      );
    },
  });

  // For draft recordings, figure out whether the audio is on THIS device.
  // If a matching local draft exists and all segments are present, the user
  // can resume in the Record screen. Otherwise the draft is orphaned (created
  // on another device, or local storage cleared) and the only sensible action
  // from here is to delete it.
  const [draftLocalSlotId, setDraftLocalSlotId] = useState<string | null>(null);
  const [draftResolved, setDraftResolved] = useState(false);

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
        if (match && match.segments.length > 0 && match.segments.every((s) => fileExists(s.uri))) {
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

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!id) return;
      await recordingsApi.delete(id);
      // If a local draft points at this server row, purge it too so the
      // "Not Submitted" card won't resurrect on next focus.
      if (draftLocalSlotId) {
        await draftStorage.deleteDraft(draftLocalSlotId).catch(() => {});
      }
    },
    onSuccess: () => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
      queryClient.removeQueries({ queryKey: ['recording', id] });
      router.navigate('/recordings');
    },
    onError: (error: Error) => {
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

  if (isError) {
    return (
      <SafeAreaView className="screen justify-center items-center p-5">
        <Animated.View entering={FadeIn.duration(300)} className="items-center">
          <Text className="text-body-lg font-semibold text-danger-700 mb-2">
            Failed to load recording
          </Text>
          <Text className="text-body text-stone-500 text-center mb-4">
            {error instanceof ApiError ? error.message : 'An unexpected error occurred. Please try again.'}
          </Text>
          <View className="flex-row gap-3">
            <Button variant="primary" onPress={() => router.navigate('/recordings')}>
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

  return (
    <SafeAreaView className="screen">
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl
            refreshing={isRefetchingRecording || isRefetchingSoapNote}
            onRefresh={handleRefresh}
          />
        }
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>
        {/* Header */}
        <View className="flex-row items-center px-5 pt-5">
          <Pressable
            onPress={() => router.navigate('/recordings')}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="mr-3 w-11 h-11 items-center justify-center"
          >
            <ChevronLeft color="#1c1917" size={iconMd} />
          </Pressable>
          <View className="flex-1">
            <Text className="text-title font-bold text-stone-900" numberOfLines={1}>
              {recording.patientName}
            </Text>
          </View>
          <StatusBadge status={recording.status} />
        </View>

        {/* Patient Info */}
        <Card className="m-5 mt-4">
          <View className="flex-row flex-wrap">
            {recording.species && (
              <View style={{ width: '50%' }} className="mb-3 pr-2">
                <Text className="text-caption text-stone-400 font-medium uppercase">Species</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.species}</Text>
              </View>
            )}
            {recording.breed && (
              <View style={{ width: '50%' }} className="mb-3 pl-2">
                <Text className="text-caption text-stone-400 font-medium uppercase">Breed</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.breed}</Text>
              </View>
            )}
            {recording.clientName && (
              <View style={{ width: '50%' }} className="mb-3 pr-2">
                <Text className="text-caption text-stone-400 font-medium uppercase">Client</Text>
                <Text className="text-body text-stone-900 mt-0.5" numberOfLines={1}>{recording.clientName}</Text>
              </View>
            )}
            {recording.appointmentType && (
              <View style={{ width: '50%' }} className="mb-3 pl-2">
                <Text className="text-caption text-stone-400 font-medium uppercase">Type</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.appointmentType}</Text>
              </View>
            )}
          </View>
          <Text className="text-caption text-stone-400">{formattedDate}</Text>
        </Card>

        {/* Processing Status */}
        {isProcessing && (
          <Card className="mx-5 mb-4">
            <Text className="text-body-lg font-semibold text-stone-900 mb-1">
              Processing...
            </Text>
            <Text className="text-body-sm text-stone-500 mb-2">
              This usually takes 1-2 minutes.
            </Text>
            <ProcessingStepper currentStatus={recording.status} />
          </Card>
        )}

        {/* Stale processing warning — shown after 30 min of non-terminal status */}
        {isPollingStale && (
          <Card className="mx-5 mb-4 border-warning-200">
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-warning-700 mb-1">
                  Processing is taking longer than expected
                </Text>
                <Text className="text-body-sm text-stone-500 mb-2">
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
          <Card className="mx-5 mb-4 border-warning-200">
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-warning-700 mb-1">
                  Awaiting Patient Details
                </Text>
                <Text className="text-body-sm text-stone-500">
                  This recording was imported and needs patient details before processing can begin. Complete the details on the web app.
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
                <View className="mr-2 mt-0.5"><FileText color="#0d8775" size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-stone-900 mb-1">
                    Finish Recording
                  </Text>
                  <Text className="text-body-sm text-stone-500 mb-3">
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={confirmDeleteDraft}
                      loading={deleteMutation.isPending}
                      accessibilityLabel="Delete draft"
                    >
                      Delete Draft
                    </Button>
                  </View>
                </View>
              </View>
            </Card>
          ) : (
            <Card className="mx-5 mb-4 border-warning-200">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-warning-700 mb-1">
                    Audio Not on This Device
                  </Text>
                  <Text className="text-body-sm text-stone-500 mb-3">
                    This draft was started on another device, or its local audio
                    was cleared from this one. Submit it from the device where
                    you recorded it, or delete it here to clean up.
                  </Text>
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
                </View>
              </View>
            </Card>
          )
        )}

        {/* Failed */}
        {recording.status === 'failed' && (
          <Animated.View entering={FadeInUp.duration(300)}>
            <Card className="mx-5 mb-4 border-danger-100">
              <Text className="text-body-lg font-semibold text-danger-700 mb-1">
                Processing Failed
              </Text>
              {recording.errorMessage && (
                <Text className="text-body-sm text-danger-700 mb-3">
                  {recording.errorMessage.slice(0, 200)}
                </Text>
              )}
              <View className="self-start">
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => retryMutation.mutate()}
                  loading={retryMutation.isPending}
                  accessibilityLabel="Retry processing"
                >
                  Retry
                </Button>
              </View>
            </Card>
          </Animated.View>
        )}

        {/* Transcript Quality Warnings */}
        {recording.status === 'completed' && Array.isArray(recording.qualityWarnings) && recording.qualityWarnings.length > 0 && (
          <Animated.View entering={FadeInUp.duration(300)}>
            <Card className="mx-5 mb-4 border-warning-200">
              <View className="flex-row items-start">
                <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-warning-700 mb-1">
                    Transcript Quality Warning
                  </Text>
                  {recording.qualityWarnings.map((warning, i) => (
                    <Text key={i} className="text-body-sm text-warning-600 mb-1">
                      {warning}
                    </Text>
                  ))}
                </View>
              </View>
            </Card>
          </Animated.View>
        )}

        {/* SOAP Note */}
        {recording.status === 'completed' && (
          <View className="px-5 pb-8">
            {recording.errorCode === 'PARTIAL_GENERATION' && (
              <Animated.View entering={FadeInUp.duration(300)} className="mb-4">
                <Card className="border-warning-200">
                  <View className="flex-row items-start">
                    <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-warning-700 mb-1">
                        Partial SOAP Note
                      </Text>
                      <Text className="text-body-sm text-stone-500 mb-2">
                        One or more sections could not be generated. The note below may be incomplete.
                      </Text>
                      <View className="self-start">
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => retryMutation.mutate()}
                          loading={retryMutation.isPending}
                        >
                          Regenerate
                        </Button>
                      </View>
                    </View>
                  </View>
                </Card>
              </Animated.View>
            )}
            {isSoapNoteLoading ? (
              <View>
                {[1, 2, 3, 4].map((i) => (
                  <View key={i} className="border border-stone-200 rounded-input mb-2 p-3">
                    <Skeleton width="30%" height={16} className="mb-2" />
                    <SkeletonText lines={2} />
                  </View>
                ))}
              </View>
            ) : isSoapNoteError ? (
              <View className="py-5 items-center">
                <Text className="text-body text-danger-700 mb-3">
                  Failed to load SOAP note.
                </Text>
                <Button variant="secondary" size="sm" onPress={() => { refetchSoapNote().catch(() => {}); }}>
                  Retry
                </Button>
              </View>
            ) : soapNote ? (
              <SoapNoteView soapNote={soapNote} />
            ) : (
              <View className="py-5 items-center">
                <Text className="text-body text-stone-500">
                  SOAP note not available.
                </Text>
              </View>
            )}

          </View>
        )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

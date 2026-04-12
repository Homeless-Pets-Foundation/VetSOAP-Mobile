import React, { useCallback, useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, Pressable, Alert, RefreshControl, AppState, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp, ZoomIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { ChevronLeft, Check, AlertTriangle } from 'lucide-react-native';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { recordingsApi, type CompleteMetadataPayload } from '../../../../src/api/recordings';
import { ApiError } from '../../../../src/api/client';
import type { Recording } from '../../../../src/types';
import { StatusBadge } from '../../../../src/components/StatusBadge';
import { SoapNoteView } from '../../../../src/components/SoapNoteView';
import { Button } from '../../../../src/components/ui/Button';
import { Card } from '../../../../src/components/ui/Card';
import { Skeleton, SkeletonText } from '../../../../src/components/ui/Skeleton';
import { TextInputField } from '../../../../src/components/ui/TextInputField';
import { useTemplates } from '../../../../src/hooks/useTemplates';

const PROCESSING_STEPS = [
  { status: 'uploading', label: 'Uploading' },
  { status: 'uploaded', label: 'Uploaded' },
  { status: 'transcribing', label: 'Transcribing' },
  { status: 'generating', label: 'Generating SOAP' },
  { status: 'completed', label: 'Complete' },
] as const;

const STATUS_ORDER = ['uploading', 'uploaded', 'transcribing', 'generating', 'completed'];

interface MetadataFormProps {
  recording: Recording;
  onSuccess: () => void;
}

function MetadataForm({ recording, onSuccess }: MetadataFormProps) {
  const queryClient = useQueryClient();
  const { templates } = useTemplates();

  const [patientName, setPatientName] = useState(recording.patientName || '');
  const [clientName, setClientName] = useState(recording.clientName || '');
  const [species, setSpecies] = useState(recording.species || '');
  const [breed, setBreed] = useState(recording.breed || '');
  const [appointmentType, setAppointmentType] = useState(recording.appointmentType || '');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [foreignLanguage, setForeignLanguage] = useState(false);

  const completeMetadataMutation = useMutation({
    mutationFn: async () => {
      if (!patientName.trim()) {
        throw new Error('Patient name is required');
      }
      const payload: CompleteMetadataPayload = {
        patientName,
        clientName,
        species,
        breed,
        appointmentType,
        templateId: selectedTemplateId,
        foreignLanguage,
      };
      return recordingsApi.completeMetadata(recording.id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recordings', 'list'] }).catch(() => {});
      onSuccess();
    },
    onError: (error: Error) => {
      Alert.alert('Error', error.message);
    },
  });

  const handleSubmit = () => {
    if (!patientName.trim()) {
      Alert.alert('Required Field', 'Please enter a patient name');
      return;
    }
    completeMetadataMutation.mutate();
  };

  return (
    <Card className="mx-5 mb-4">
      <Text className="text-body-lg font-semibold text-stone-900 mb-3">
        Complete Recording Details
      </Text>

      <TextInputField
        label="Patient Name"
        required
        placeholder="Enter patient name"
        value={patientName}
        onChangeText={setPatientName}
      />

      <TextInputField
        label="Client Name"
        placeholder="Enter client name"
        value={clientName}
        onChangeText={setClientName}
      />

      <TextInputField
        label="Species"
        placeholder="e.g., Dog, Cat"
        value={species}
        onChangeText={setSpecies}
      />

      <TextInputField
        label="Breed"
        placeholder="Enter breed"
        value={breed}
        onChangeText={setBreed}
      />

      <TextInputField
        label="Appointment Type"
        placeholder="e.g., Consultation, Surgery"
        value={appointmentType}
        onChangeText={setAppointmentType}
      />

      {templates.length > 0 && (
        <View className="mb-3.5">
          <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
            Template
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row gap-2">
            <Pressable
              onPress={() => setSelectedTemplateId(null)}
              className={`px-4 py-2 rounded-full border-2 ${
                selectedTemplateId === null
                  ? 'border-brand-500 bg-brand-50'
                  : 'border-stone-300 bg-stone-50'
              }`}
            >
              <Text
                className={`text-body-sm font-medium ${
                  selectedTemplateId === null ? 'text-brand-700' : 'text-stone-600'
                }`}
              >
                Default
              </Text>
            </Pressable>
            {templates.map((template) => (
              <Pressable
                key={template.id}
                onPress={() => setSelectedTemplateId(template.id)}
                className={`px-4 py-2 rounded-full border-2 ${
                  selectedTemplateId === template.id
                    ? 'border-brand-500 bg-brand-50'
                    : 'border-stone-300 bg-stone-50'
                }`}
              >
                <Text
                  className={`text-body-sm font-medium ${
                    selectedTemplateId === template.id ? 'text-brand-700' : 'text-stone-600'
                  }`}
                  numberOfLines={1}
                >
                  {template.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-body-sm font-medium text-stone-700">
          Foreign Language
        </Text>
        <Switch
          value={foreignLanguage}
          onValueChange={(v) => {
            setForeignLanguage(v);
          }}
        />
      </View>

      <Button
        variant="primary"
        onPress={handleSubmit}
        loading={completeMetadataMutation.isPending}
      >
        Start Processing
      </Button>
    </Card>
  );
}

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
                className={`text-body ${
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
    return () => sub.remove();
  }, []);

  const { data: recording, isLoading, isError, error, refetch: refetchRecording, isRefetching: isRefetchingRecording } = useQuery({
    queryKey: ['recording', id],
    queryFn: () => recordingsApi.get(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!isAppActive) return false;
      const status = query.state.data?.status;
      if (!status || ['completed', 'failed', 'pending_metadata'].includes(status)) {
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
    !['completed', 'failed', 'pending_metadata'].includes(recording?.status ?? '');

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

  const isProcessing = !['completed', 'failed', 'pending_metadata'].includes(recording.status);
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
          <MetadataForm recording={recording} onSuccess={() => { refetchRecording().catch(() => {}); }} />
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

        {/* Transcript */}
        {recording.status === 'completed' && recording.transcriptText && (
          <View className="px-5 mb-4">
            <Text className="text-heading font-bold text-stone-900 mb-2" accessibilityRole="header">
              Transcript
            </Text>
            <Card>
              <Text className="text-body-sm text-stone-600 leading-relaxed">
                {recording.transcriptText}
              </Text>
            </Card>
          </View>
        )}

        {/* Export status */}
        {recording.status === 'completed' && recording.isExported && (
          <View className="px-5 mb-4">
            <Card className="border-brand-100 bg-brand-50">
              <Text className="text-body-sm text-brand-700 font-medium">
                Exported{recording.exportedTo ? ` to ${recording.exportedTo}` : ''}
                {recording.exportedBy ? ` by ${recording.exportedBy.fullName}` : ''}
                {recording.exportedAt
                  ? (() => {
                      const exportDate = new Date(recording.exportedAt);
                      return !isNaN(exportDate.getTime())
                        ? ` on ${exportDate.toLocaleDateString()}`
                        : '';
                    })()
                  : ''}
              </Text>
            </Card>
          </View>
        )}

        {/* Cost breakdown */}
        {recording.status === 'completed' && recording.costBreakdown && (
          <View className="px-5 mb-4">
            <Card>
              <Text className="text-caption text-stone-400 font-medium uppercase mb-1">Processing Cost</Text>
              <Text className="text-body-sm text-stone-600">
                ${((recording.costBreakdown.totalCostCents ?? 0) / 100).toFixed(4)}
              </Text>
            </Card>
          </View>
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

import React from 'react';
import { View, Text, ScrollView, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp, ZoomIn } from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, RotateCcw, Check } from 'lucide-react-native';
import { recordingsApi } from '../../../src/api/recordings';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { SoapNoteView } from '../../../src/components/SoapNoteView';
import { Button } from '../../../src/components/ui/Button';
import { Card } from '../../../src/components/ui/Card';
import { Skeleton, SkeletonText } from '../../../src/components/ui/Skeleton';
import { useScreenSecurity } from '../../../src/hooks/useScreenSecurity';

const PROCESSING_STEPS = [
  { status: 'uploading', label: 'Uploading' },
  { status: 'uploaded', label: 'Uploaded' },
  { status: 'transcribing', label: 'Transcribing' },
  { status: 'transcribed', label: 'Transcribed' },
  { status: 'generating', label: 'Generating SOAP' },
  { status: 'completed', label: 'Complete' },
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

  // Prevent screenshots on screens displaying patient health data
  useScreenSecurity();

  const { data: recording, isLoading, isError, error } = useQuery({
    queryKey: ['recording', id],
    queryFn: () => recordingsApi.get(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && !['completed', 'failed'].includes(status)) {
        return 5000;
      }
      return false;
    },
  });

  const {
    data: soapNote,
    isLoading: isSoapNoteLoading,
  } = useQuery({
    queryKey: ['soapNote', id],
    queryFn: () => recordingsApi.getSoapNote(id!),
    enabled: !!id && recording?.status === 'completed',
  });

  const retryMutation = useMutation({
    mutationFn: () => recordingsApi.retry(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recording', id] });
    },
    onError: (error: Error) => {
      Alert.alert('Retry Failed', error.message);
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
            {error instanceof Error ? error.message : 'An unexpected error occurred'}
          </Text>
          <Button variant="primary" onPress={() => router.back()}>
            Go Back
          </Button>
        </Animated.View>
      </SafeAreaView>
    );
  }

  if (isLoading || !recording) {
    return <DetailSkeleton />;
  }

  const isProcessing = !['completed', 'failed'].includes(recording.status);
  const formattedDate = new Date(recording.createdAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <SafeAreaView className="screen">
      <ScrollView className="flex-1">
        {/* Header */}
        <View className="flex-row items-center px-5 pt-5">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="mr-3 w-11 h-11 items-center justify-center"
          >
            <ChevronLeft color="#1c1917" size={24} />
          </Pressable>
          <View className="flex-1">
            <Text className="text-title font-bold text-stone-900">
              {recording.patientName}
            </Text>
          </View>
          <StatusBadge status={recording.status} />
        </View>

        {/* Patient Info */}
        <Card className="m-5 mt-4">
          <View className="flex-row flex-wrap gap-4">
            {recording.species && (
              <View>
                <Text className="text-[11px] text-stone-400 font-medium">SPECIES</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.species}</Text>
              </View>
            )}
            {recording.breed && (
              <View>
                <Text className="text-[11px] text-stone-400 font-medium">BREED</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.breed}</Text>
              </View>
            )}
            {recording.clientName && (
              <View>
                <Text className="text-[11px] text-stone-400 font-medium">CLIENT</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.clientName}</Text>
              </View>
            )}
            {recording.appointmentType && (
              <View>
                <Text className="text-[11px] text-stone-400 font-medium">TYPE</Text>
                <Text className="text-body text-stone-900 mt-0.5">{recording.appointmentType}</Text>
              </View>
            )}
          </View>
          <Text className="text-caption text-stone-400 mt-3">{formattedDate}</Text>
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

        {/* Failed */}
        {recording.status === 'failed' && (
          <Animated.View entering={FadeInUp.duration(300)}>
            <Card className="mx-5 mb-4 border-danger-100">
              <Text className="text-body-lg font-semibold text-danger-700 mb-1">
                Processing Failed
              </Text>
              {recording.errorMessage && (
                <Text className="text-body-sm text-danger-700 mb-3">
                  {recording.errorMessage}
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

        {/* SOAP Note */}
        {recording.status === 'completed' && (
          <View className="px-5 pb-8">
            {isSoapNoteLoading ? (
              <View>
                {[1, 2, 3, 4].map((i) => (
                  <View key={i} className="border border-stone-200 rounded-input mb-2 p-3">
                    <Skeleton width="30%" height={16} className="mb-2" />
                    <SkeletonText lines={2} />
                  </View>
                ))}
              </View>
            ) : soapNote ? (
              <SoapNoteView soapNote={soapNote} />
            ) : (
              <View className="py-5 items-center">
                <Text className="text-body text-danger-700">
                  Failed to load SOAP note. Pull down to refresh.
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

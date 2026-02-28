import React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, RotateCcw } from 'lucide-react-native';
import { recordingsApi } from '../../../src/api/recordings';
import { StatusBadge } from '../../../src/components/StatusBadge';
import { SoapNoteView } from '../../../src/components/SoapNoteView';

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
    <View style={{ marginVertical: 16 }}>
      {PROCESSING_STEPS.map((step) => {
        const stepIndex = STATUS_ORDER.indexOf(step.status);
        const isComplete = currentIndex > stepIndex;
        const isCurrent = currentIndex === stepIndex;

        return (
          <View key={step.status} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: isComplete ? '#0d8775' : isCurrent ? '#fef3c7' : '#f5f5f4',
                borderWidth: isCurrent ? 2 : 0,
                borderColor: isCurrent ? '#f59e0b' : undefined,
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: 12,
              }}
            >
              {isComplete && (
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>✓</Text>
              )}
              {isCurrent && (
                <ActivityIndicator size="small" color="#f59e0b" />
              )}
            </View>
            <Text
              style={{
                fontSize: 14,
                color: isComplete ? '#0d8775' : isCurrent ? '#92400e' : '#a8a29e',
                fontWeight: isCurrent ? '600' : '400',
              }}
            >
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function RecordingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

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
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: '#991b1b', marginBottom: 8 }}>
          Failed to load recording
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center', marginBottom: 16 }}>
          {error instanceof Error ? error.message : 'An unexpected error occurred'}
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={{ backgroundColor: '#0d8775', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Go Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (isLoading || !recording) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#0d8775" />
      </SafeAreaView>
    );
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
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <ScrollView style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 0 }}>
          <Pressable onPress={() => router.back()} style={{ marginRight: 12 }}>
            <ChevronLeft color="#1c1917" size={24} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: '#1c1917' }}>
              {recording.patientName}
            </Text>
          </View>
          <StatusBadge status={recording.status} />
        </View>

        {/* Patient Info */}
        <View
          style={{
            backgroundColor: '#fff',
            margin: 20,
            marginTop: 16,
            borderRadius: 14,
            padding: 16,
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {recording.species && (
              <View>
                <Text style={{ fontSize: 11, color: '#a8a29e', fontWeight: '500' }}>SPECIES</Text>
                <Text style={{ fontSize: 14, color: '#1c1917', marginTop: 2 }}>{recording.species}</Text>
              </View>
            )}
            {recording.breed && (
              <View>
                <Text style={{ fontSize: 11, color: '#a8a29e', fontWeight: '500' }}>BREED</Text>
                <Text style={{ fontSize: 14, color: '#1c1917', marginTop: 2 }}>{recording.breed}</Text>
              </View>
            )}
            {recording.clientName && (
              <View>
                <Text style={{ fontSize: 11, color: '#a8a29e', fontWeight: '500' }}>CLIENT</Text>
                <Text style={{ fontSize: 14, color: '#1c1917', marginTop: 2 }}>{recording.clientName}</Text>
              </View>
            )}
            {recording.appointmentType && (
              <View>
                <Text style={{ fontSize: 11, color: '#a8a29e', fontWeight: '500' }}>TYPE</Text>
                <Text style={{ fontSize: 14, color: '#1c1917', marginTop: 2 }}>{recording.appointmentType}</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 12 }}>{formattedDate}</Text>
        </View>

        {/* Processing Status */}
        {isProcessing && (
          <View
            style={{
              backgroundColor: '#fff',
              marginHorizontal: 20,
              marginBottom: 16,
              borderRadius: 14,
              padding: 16,
              borderWidth: 1,
              borderColor: '#e7e5e4',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917', marginBottom: 4 }}>
              Processing...
            </Text>
            <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 8 }}>
              This usually takes 1-2 minutes.
            </Text>
            <ProcessingStepper currentStatus={recording.status} />
          </View>
        )}

        {/* Failed */}
        {recording.status === 'failed' && (
          <View
            style={{
              backgroundColor: '#fff',
              marginHorizontal: 20,
              marginBottom: 16,
              borderRadius: 14,
              padding: 16,
              borderWidth: 1,
              borderColor: '#fee2e2',
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#991b1b', marginBottom: 4 }}>
              Processing Failed
            </Text>
            {recording.errorMessage && (
              <Text style={{ fontSize: 13, color: '#991b1b', marginBottom: 12 }}>
                {recording.errorMessage}
              </Text>
            )}
            <Pressable
              onPress={() => retryMutation.mutate()}
              disabled={retryMutation.isPending}
              style={{
                backgroundColor: '#0d8775',
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 8,
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'flex-start',
                gap: 6,
              }}
            >
              <RotateCcw color="#fff" size={16} />
              <Text style={{ color: '#fff', fontWeight: '600' }}>
                {retryMutation.isPending ? 'Retrying...' : 'Retry'}
              </Text>
            </Pressable>
          </View>
        )}

        {/* SOAP Note */}
        {recording.status === 'completed' && (
          <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
            {isSoapNoteLoading ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#0d8775" />
                <Text style={{ color: '#78716c', marginTop: 8, fontSize: 14 }}>
                  Loading SOAP note...
                </Text>
              </View>
            ) : soapNote ? (
              <SoapNoteView soapNote={soapNote} />
            ) : (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ color: '#991b1b', fontSize: 14 }}>
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

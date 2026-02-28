import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mic, Pause, Play, Square, RotateCcw } from 'lucide-react-native';
import { useAudioRecorder } from '../../src/hooks/useAudioRecorder';
import { recordingsApi } from '../../src/api/recordings';
import { PatientForm } from '../../src/components/PatientForm';
import type { CreateRecording } from '../../src/types';

export default function RecordScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const recorder = useAudioRecorder();

  const [formData, setFormData] = useState<CreateRecording>({
    patientName: '',
    clientName: '',
    species: '',
    breed: '',
    appointmentType: '',
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!recorder.audioUri) throw new Error('No recording available');
      return recordingsApi.createWithFile(formData, recorder.audioUri, recorder.mimeType);
    },
    onSuccess: (recording) => {
      queryClient.invalidateQueries({ queryKey: ['recordings'] });
      router.push(`/(app)/recordings/${recording.id}` as any);
    },
    onError: (error: Error) => {
      Alert.alert('Upload Failed', error.message || 'Failed to process recording. Please try again.');
    },
  });

  const updateField = (field: keyof CreateRecording, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const canStartRecording = formData.patientName.trim().length > 0 && recorder.permissionGranted;
  const canSubmit = formData.patientName.trim().length > 0 && recorder.audioUri !== null;
  const isRecording = recorder.state === 'recording';

  const handleStart = async () => {
    try {
      await recorder.start();
    } catch (error) {
      Alert.alert(
        'Microphone Error',
        'Failed to access microphone. Please check permissions in Settings.'
      );
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <ScrollView style={{ flex: 1, padding: 20 }}>
        {/* Header */}
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#1c1917' }}>
            Record Appointment
          </Text>
          <Text style={{ fontSize: 14, color: '#78716c', marginTop: 4 }}>
            Record a live appointment and generate a SOAP note
          </Text>
        </View>

        {/* Permission warning */}
        {!recorder.permissionGranted && (
          <View
            style={{
              backgroundColor: '#fef3c7',
              padding: 14,
              borderRadius: 10,
              marginBottom: 16,
              borderWidth: 1,
              borderColor: '#fde68a',
            }}
          >
            <Text style={{ color: '#92400e', fontSize: 13, fontWeight: '500' }}>
              Microphone permission is required to record appointments. Please grant access when prompted.
            </Text>
          </View>
        )}

        {/* Step 1: Patient Info */}
        <View
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            marginBottom: 16,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View
              style={{
                backgroundColor: formData.patientName ? '#d1fae5' : '#e0e7ff',
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: 10,
                marginRight: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: formData.patientName ? '#065f46' : '#4338ca',
                }}
              >
                Step 1
              </Text>
            </View>
          </View>
          <PatientForm formData={formData} onUpdate={updateField} />
        </View>

        {/* Step 2: Recording Controls */}
        <View
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            marginBottom: 16,
            alignItems: 'center',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View
              style={{
                backgroundColor:
                  recorder.audioUri
                    ? '#d1fae5'
                    : !canStartRecording
                      ? '#f5f5f4'
                      : '#e0e7ff',
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: 10,
                marginRight: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color:
                    recorder.audioUri
                      ? '#065f46'
                      : !canStartRecording
                        ? '#a8a29e'
                        : '#4338ca',
                }}
              >
                Step 2
              </Text>
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917' }}>Record</Text>
          </View>

          {/* Status badge */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 6,
              borderRadius: 20,
              backgroundColor:
                isRecording ? '#fee2e2' :
                recorder.state === 'paused' ? '#fef3c7' :
                recorder.state === 'stopped' ? '#d1fae5' :
                '#f5f5f4',
              marginBottom: 16,
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                color:
                  isRecording ? '#991b1b' :
                  recorder.state === 'paused' ? '#92400e' :
                  recorder.state === 'stopped' ? '#065f46' :
                  '#78716c',
              }}
            >
              {recorder.state === 'idle'
                ? 'Ready to Record'
                : isRecording
                  ? 'Recording...'
                  : recorder.state === 'paused'
                    ? 'Paused'
                    : 'Recording Complete'}
            </Text>
          </View>

          {/* Timer */}
          <Text
            style={{
              fontSize: 48,
              fontWeight: '700',
              fontFamily: 'monospace',
              letterSpacing: 2,
              color: isRecording ? '#0d8775' : '#1c1917',
              marginBottom: 20,
            }}
          >
            {formatDuration(recorder.duration)}
          </Text>

          {/* Controls */}
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {recorder.state === 'idle' && (
              <Pressable
                onPress={handleStart}
                disabled={!canStartRecording}
                style={({ pressed }) => ({
                  backgroundColor: !canStartRecording ? '#d6d3d1' : pressed ? '#0bb89a' : '#0d8775',
                  paddingHorizontal: 28,
                  paddingVertical: 14,
                  borderRadius: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                })}
              >
                <Mic color="#fff" size={20} />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  {!formData.patientName.trim() ? 'Enter Patient Name' : 'Start Recording'}
                </Text>
              </Pressable>
            )}

            {isRecording && (
              <>
                <Pressable
                  onPress={recorder.pause}
                  style={{
                    borderWidth: 1,
                    borderColor: '#d6d3d1',
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    borderRadius: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Pause color="#44403c" size={18} />
                  <Text style={{ color: '#44403c', fontWeight: '600' }}>Pause</Text>
                </Pressable>
                <Pressable
                  onPress={recorder.stop}
                  style={{
                    backgroundColor: '#ef4444',
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    borderRadius: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Square color="#fff" size={18} />
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Stop</Text>
                </Pressable>
              </>
            )}

            {recorder.state === 'paused' && (
              <>
                <Pressable
                  onPress={recorder.resume}
                  style={{
                    backgroundColor: '#0d8775',
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    borderRadius: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Play color="#fff" size={18} />
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Resume</Text>
                </Pressable>
                <Pressable
                  onPress={recorder.stop}
                  style={{
                    backgroundColor: '#ef4444',
                    paddingHorizontal: 20,
                    paddingVertical: 12,
                    borderRadius: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Square color="#fff" size={18} />
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Stop</Text>
                </Pressable>
              </>
            )}

            {recorder.state === 'stopped' && (
              <Pressable
                onPress={recorder.reset}
                style={{
                  borderWidth: 1,
                  borderColor: '#d6d3d1',
                  paddingHorizontal: 20,
                  paddingVertical: 12,
                  borderRadius: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <RotateCcw color="#44403c" size={18} />
                <Text style={{ color: '#44403c', fontWeight: '600' }}>Record Again</Text>
              </Pressable>
            )}
          </View>

          {recorder.state === 'stopped' && recorder.audioUri && (
            <Text style={{ fontSize: 12, color: '#78716c', marginTop: 12, textAlign: 'center' }}>
              Recording complete ({formatDuration(recorder.duration)}). Processing usually takes 1-2 minutes.
            </Text>
          )}
        </View>

        {/* Step 3: Submit */}
        {recorder.audioUri && (
          <View
            style={{
              backgroundColor: '#fff',
              borderRadius: 14,
              padding: 20,
              borderWidth: 1,
              borderColor: '#e7e5e4',
              marginBottom: 32,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <View
                style={{
                  backgroundColor: '#e0e7ff',
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  borderRadius: 10,
                  marginRight: 8,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#4338ca' }}>Step 3</Text>
              </View>
              <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917' }}>Submit</Text>
            </View>

            <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 16 }}>
              Your recording is ready. Tap below to upload and generate your SOAP note.
            </Text>

            <Pressable
              onPress={() => uploadMutation.mutate()}
              disabled={!canSubmit || uploadMutation.isPending}
              style={({ pressed }) => ({
                backgroundColor: uploadMutation.isPending ? '#a8a29e' : pressed ? '#0bb89a' : '#0d8775',
                padding: 16,
                borderRadius: 12,
                alignItems: 'center',
                opacity: !canSubmit ? 0.5 : 1,
              })}
            >
              {uploadMutation.isPending ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                    Uploading...
                  </Text>
                </View>
              ) : (
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  Submit & Generate SOAP Note
                </Text>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

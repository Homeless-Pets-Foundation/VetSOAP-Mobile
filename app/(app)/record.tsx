import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAudioRecorder } from '../../src/hooks/useAudioRecorder';
import { recordingsApi } from '../../src/api/recordings';
import { PatientForm } from '../../src/components/PatientForm';
import { AudioWaveform } from '../../src/components/AudioWaveform';
import { ScreenContainer } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { Badge } from '../../src/components/ui/Badge';
import type { CreateRecording } from '../../src/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function StepBadge({ step, variant }: { step: number; variant: 'pending' | 'active' | 'complete' }) {
  const bgClass =
    variant === 'complete'
      ? 'bg-success-100'
      : variant === 'active'
        ? 'bg-info-100'
        : 'bg-stone-100';
  const textClass =
    variant === 'complete'
      ? 'text-success-700'
      : variant === 'active'
        ? 'text-info-700'
        : 'text-stone-400';

  return (
    <View className={`px-2.5 py-0.5 rounded-input mr-2 ${bgClass}`}>
      <Text className={`text-[11px] font-bold ${textClass}`}>Step {step}</Text>
    </View>
  );
}

function PulsingDot() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className="w-2.5 h-2.5 rounded-full bg-danger-500 mr-2"
      style={style}
    />
  );
}

export default function RecordScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const recorder = useAudioRecorder();
  const recordBtnScale = useSharedValue(1);

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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['recordings'] });
      recorder.reset();
      setFormData({
        patientName: '',
        clientName: '',
        species: '',
        breed: '',
        appointmentType: '',
      });
      router.push(`/(app)/recordings/${recording.id}` as `/(app)/recordings/${string}`);
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
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      await recorder.start();
    } catch (error) {
      Alert.alert(
        'Microphone Error',
        'Failed to access microphone. Please check permissions in Settings.'
      );
    }
  };

  const handlePause = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    recorder.pause();
  };

  const handleResume = () => {
    Haptics.selectionAsync();
    recorder.resume();
  };

  const handleStop = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    recorder.stop();
  };

  const recordBtnAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordBtnScale.value }],
  }));

  const step1Variant = formData.patientName ? 'complete' : 'active';
  const step2Variant = recorder.audioUri ? 'complete' : canStartRecording ? 'active' : 'pending';
  const step3Variant = recorder.audioUri ? 'active' : 'pending';

  return (
    <ScreenContainer>
      {/* Header */}
      <View className="mb-6">
        <Text
          className="text-display font-bold text-stone-900"
          accessibilityRole="header"
        >
          Record Appointment
        </Text>
        <Text className="text-body text-stone-500 mt-1">
          Record a live appointment and generate a SOAP note
        </Text>
      </View>

      {/* Permission warning */}
      {!recorder.permissionGranted && (
        <View
          className="bg-warning-100 p-3.5 rounded-input mb-4 border border-warning-500/30"
          accessibilityRole="alert"
        >
          <Text className="text-body-sm text-warning-700 font-medium">
            Microphone permission is required to record appointments. Please grant access when prompted.
          </Text>
        </View>
      )}

      {/* Step 1: Patient Info */}
      <Card className="mb-4">
        <View className="flex-row items-center mb-4">
          <StepBadge step={1} variant={step1Variant} />
        </View>
        <PatientForm formData={formData} onUpdate={updateField} />
      </Card>

      {/* Step 2: Recording Controls */}
      <Card className="mb-4 items-center">
        <View className="flex-row items-center mb-5">
          <StepBadge step={2} variant={step2Variant} />
          <Text className="text-body-lg font-semibold text-stone-900">Record</Text>
        </View>

        {/* Status badge */}
        <View className="mb-4" accessibilityLiveRegion="polite">
          {isRecording ? (
            <View className="flex-row items-center">
              <PulsingDot />
              <Badge variant="danger">Recording...</Badge>
            </View>
          ) : recorder.state === 'paused' ? (
            <Badge variant="warning">Paused</Badge>
          ) : recorder.state === 'stopped' ? (
            <Badge variant="success">Recording Complete</Badge>
          ) : (
            <Badge variant="neutral">Ready to Record</Badge>
          )}
        </View>

        {/* Waveform */}
        <AudioWaveform
          isActive={isRecording || recorder.state === 'paused'}
          isPaused={recorder.state === 'paused'}
        />

        {/* Timer */}
        <Text
          className={`text-timer font-bold font-mono tracking-wider mb-5 ${
            isRecording ? 'text-brand-500' : 'text-stone-900'
          }`}
        >
          {formatDuration(recorder.duration)}
        </Text>

        {/* Controls */}
        <View className="flex-row gap-3">
          {recorder.state === 'idle' && (
            <Animated.View entering={FadeIn.duration(300)}>
              <AnimatedPressable
                onPress={handleStart}
                onPressIn={() => {
                  recordBtnScale.value = withSpring(0.9, { damping: 15, stiffness: 300 });
                }}
                onPressOut={() => {
                  recordBtnScale.value = withSpring(1, { damping: 15, stiffness: 300 });
                }}
                disabled={!canStartRecording}
                accessibilityRole="button"
                accessibilityLabel={!formData.patientName.trim() ? 'Enter patient name first' : 'Start recording'}
                className={`w-20 h-20 rounded-full justify-center items-center ${
                  canStartRecording ? 'bg-brand-500' : 'bg-stone-300'
                }`}
                style={recordBtnAnimStyle}
              >
                <Mic color="#fff" size={32} />
              </AnimatedPressable>
            </Animated.View>
          )}

          {isRecording && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="secondary" onPress={handlePause}>
                Pause
              </Button>
              <Button variant="danger" onPress={handleStop}>
                Stop
              </Button>
            </Animated.View>
          )}

          {recorder.state === 'paused' && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="primary" onPress={handleResume}>
                Resume
              </Button>
              <Button variant="danger" onPress={handleStop}>
                Stop
              </Button>
            </Animated.View>
          )}

          {recorder.state === 'stopped' && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Button variant="secondary" onPress={recorder.reset}>
                Record Again
              </Button>
            </Animated.View>
          )}
        </View>

        {recorder.state === 'stopped' && recorder.audioUri && (
          <Text className="text-caption text-stone-500 mt-3 text-center">
            Recording complete ({formatDuration(recorder.duration)}). Processing usually takes 1-2 minutes.
          </Text>
        )}
      </Card>

      {/* Step 3: Submit */}
      {recorder.audioUri && (
        <Animated.View entering={FadeInUp.duration(300)}>
          <Card className="mb-8">
            <View className="flex-row items-center mb-3">
              <StepBadge step={3} variant={step3Variant} />
              <Text className="text-body-lg font-semibold text-stone-900">Submit</Text>
            </View>

            <Text className="text-body-sm text-stone-500 mb-4">
              Your recording is ready. Tap below to upload and generate your SOAP note.
            </Text>

            <Button
              variant="primary"
              size="lg"
              onPress={() => uploadMutation.mutate()}
              loading={uploadMutation.isPending}
              disabled={!canSubmit}
              accessibilityLabel="Submit and generate SOAP note"
            >
              Submit & Generate SOAP Note
            </Button>
          </Card>
        </Animated.View>
      )}
    </ScreenContainer>
  );
}

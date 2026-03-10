import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, Alert, ActivityIndicator, Linking } from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { useAudioRecorder } from '../../src/hooks/useAudioRecorder';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useTemplates } from '../../src/hooks/useTemplates';
import { recordingsApi } from '../../src/api/recordings';
import { ApiError } from '../../src/api/client';
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
    return () => { cancelAnimation(opacity); };
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

function PermissionGate({ onGranted }: { onGranted: () => void }) {
  const { scale } = useResponsive();
  const [requesting, setRequesting] = useState(false);

  const handleRequest = () => {
    setRequesting(true);
    requestRecordingPermissionsAsync()
      .then(({ granted, canAskAgain }) => {
        if (granted) {
          onGranted();
        } else if (!canAskAgain) {
          Alert.alert(
            'Permission Required',
            'Microphone access was denied. Please enable it in your device Settings to record appointments.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => {
                  Linking.openSettings().catch(() => {});
                },
              },
            ]
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        setRequesting(false);
      });
  };

  return (
    <ScreenContainer>
      <View className="flex-1 justify-center items-center px-6">
        <View
          className="bg-brand-50 rounded-full justify-center items-center mb-6"
          style={{ width: scale(96), height: scale(96) }}
        >
          <Mic color="#0d8775" size={scale(40)} />
        </View>
        <Text className="text-display font-bold text-stone-900 text-center mb-3">
          Microphone Access
        </Text>
        <Text className="text-body text-stone-500 text-center mb-8">
          Captivet needs microphone permission to record veterinary appointments and generate SOAP notes.
        </Text>
        <Button
          variant="primary"
          size="lg"
          onPress={handleRequest}
          loading={requesting}
          accessibilityLabel="Grant microphone access"
        >
          Grant Microphone Access
        </Button>
      </View>
    </ScreenContainer>
  );
}

function RecordingSession() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const recorder = useAudioRecorder();
  const { scale } = useResponsive();
  const { templates, defaultTemplate, isLoading: templatesLoading } = useTemplates();
  const recordBtnScale = useSharedValue(1);

  const [formData, setFormData] = useState<CreateRecording>({
    patientName: '',
    clientName: '',
    species: '',
    breed: '',
    appointmentType: '',
  });

  // Auto-select default template once templates load
  useEffect(() => {
    if (defaultTemplate) {
      setFormData((prev) => {
        if (!prev.templateId) {
          return { ...prev, templateId: defaultTemplate.id };
        }
        return prev;
      });
    }
  }, [defaultTemplate]);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!recorder.audioUri) throw new Error('No recording available');
      return recordingsApi.createWithFile(formData, recorder.audioUri, recorder.mimeType);
    },
    onSuccess: (recording) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recordings'] });
      recorder.reset();
      setFormData({
        patientName: '',
        clientName: '',
        species: '',
        breed: '',
        appointmentType: '',
        templateId: defaultTemplate?.id,
      });
      router.push(`/(app)/recordings/${recording.id}` as `/(app)/recordings/${string}`);
    },
    onError: (error: Error) => {
      Alert.alert(
        'Upload Failed',
        error.message || 'Failed to process recording. Please try again.'
      );
    },
  });

  const updateField = (field: keyof CreateRecording, value: string | boolean | undefined) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const hasRequiredFields =
    formData.patientName.trim().length > 0 &&
    formData.clientName.trim().length > 0 &&
    !!formData.species;
  const canSubmit = hasRequiredFields && recorder.audioUri !== null;
  const isRecording = recorder.state === 'recording';

  const handleStart = () => {
    (async () => {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        await recorder.start();
      } catch (error) {
        const msg =
          error instanceof Error && error.message.toLowerCase().includes('permission')
            ? 'Microphone permission is required. Please grant access in Settings.'
            : 'Could not start recording. Please check that your device has a microphone and it is not in use by another app.';
        Alert.alert('Microphone Error', msg);
      }
    })().catch(() => {});
  };

  const handlePause = () => {
    (async () => {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        await recorder.pause();
      } catch {
        Alert.alert('Recording Error', 'Failed to pause recording.');
      }
    })().catch(() => {});
  };

  const handleResume = () => {
    (async () => {
      try {
        Haptics.selectionAsync().catch(() => {});
        await recorder.resume();
      } catch {
        Alert.alert('Recording Error', 'Failed to resume recording.');
      }
    })().catch(() => {});
  };

  const handleStop = () => {
    (async () => {
      try {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        await recorder.stop();
      } catch {
        Alert.alert('Recording Error', 'Failed to stop recording.');
      }
    })().catch(() => {});
  };

  const handleRecordAgain = () => {
    Alert.alert(
      'Delete Current Recording?',
      'Your current recording will be permanently deleted and cannot be recovered. Are you sure you want to start over?',
      [
        {
          text: 'Keep Recording',
          style: 'cancel',
        },
        {
          text: 'Delete & Start Over',
          style: 'destructive',
          onPress: () => {
            recorder.reset();
          },
        },
      ]
    );
  };

  const recordBtnAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordBtnScale.value }],
  }));

  const step1Variant = hasRequiredFields ? 'complete' : 'active';
  const step2Variant = recorder.audioUri ? 'complete' : hasRequiredFields ? 'active' : 'pending';
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

      {/* Step 1: Patient Info */}
      <Card className="mb-4">
        <View className="flex-row items-center mb-4">
          <StepBadge step={1} variant={step1Variant} />
        </View>
        <PatientForm
          formData={formData}
          onUpdate={updateField}
          templates={templates}
          templatesLoading={templatesLoading}
        />
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
          metering={recorder.metering}
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
                disabled={!hasRequiredFields}
                accessibilityRole="button"
                accessibilityLabel={!hasRequiredFields ? 'Enter patient name, client name, and species first' : 'Start recording'}
                className={`rounded-full justify-center items-center ${
                  hasRequiredFields ? 'bg-brand-500' : 'bg-stone-300'
                }`}
                style={[{ width: scale(80), height: scale(80) }, recordBtnAnimStyle]}
              >
                <Mic color="#fff" size={scale(32)} />
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
              <Button variant="danger" onPress={handleRecordAgain}>
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

export default function RecordScreen() {
  const [permissionStatus, setPermissionStatus] = useState<'checking' | 'granted' | 'denied'>('checking');

  useEffect(() => {
    getRecordingPermissionsAsync()
      .then(({ granted }) => {
        setPermissionStatus(granted ? 'granted' : 'denied');
      })
      .catch(() => {
        setPermissionStatus('denied');
      });
  }, []);

  if (permissionStatus === 'checking') {
    return (
      <ScreenContainer>
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#0d8775" />
        </View>
      </ScreenContainer>
    );
  }

  if (permissionStatus === 'denied') {
    return <PermissionGate onGranted={() => setPermissionStatus('granted')} />;
  }

  return <RecordingSession />;
}

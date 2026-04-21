import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
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
import { Mic, X, Plus, Scissors, Trash2, Check } from 'lucide-react-native';
import { PatientForm } from './PatientForm';
import { AudioWaveform } from './AudioWaveform';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import type { PatientSlot } from '../types/multiPatient';
import type { CreateRecording, Template } from '../types';
import type { UseAudioRecorderReturn } from '../hooks/useAudioRecorder';
import { useResponsive } from '../hooks/useResponsive';
import { patientsApi } from '../api/patients';
import {
  LONG_RECORDING_WARNING_COPY,
  LONG_RECORDING_WARNING_THRESHOLD_SEC,
} from '../constants/strings';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PatientSlotCardProps {
  slot: PatientSlot;
  slotIndex: number;
  totalSlots: number;
  isRecorderOwner: boolean;
  recorder: UseAudioRecorderReturn;
  recorderBusy: boolean;
  templates: Template[];
  templatesLoading: boolean;
  width: number;
  onUpdateForm: (field: keyof CreateRecording, value: string | boolean | undefined) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRecordAgain: () => void;
  onContinueRecording: () => void;
  onRemove: () => void;
  onSubmitSingle: () => void;
  onEditRecording: () => void;
  submitBlockedByLiveRecording: boolean;
}

function PulsingDot() {
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => { cancelAnimation(opacity); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacity is a stable Reanimated SharedValue ref
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

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// WARNING: update the comparator below when adding new props
export const PatientSlotCard = React.memo(function PatientSlotCard({
  slot,
  slotIndex,
  totalSlots,
  isRecorderOwner,
  recorder,
  recorderBusy,
  templates,
  templatesLoading,
  width,
  onUpdateForm,
  onStart,
  onPause,
  onResume,
  onStop,
  onRecordAgain,
  onContinueRecording,
  onRemove,
  onSubmitSingle,
  onEditRecording,
  submitBlockedByLiveRecording,
}: PatientSlotCardProps) {
  const { scale } = useResponsive();
  const recordBtnScale = useSharedValue(1);
  const recordBtnAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordBtnScale.value }],
  }));

  const [pimsLookupLoading, setPimsLookupLoading] = React.useState(false);
  const lookupIdRef = React.useRef(0);

  const handlePimsBlur = React.useCallback(() => {
    const pimsId = slot.formData.pimsPatientId?.trim();
    if (!pimsId) return;
    const lookupId = ++lookupIdRef.current;
    setPimsLookupLoading(true);
    patientsApi.lookupByPimsId(pimsId)
      .then((result) => {
        if (lookupIdRef.current !== lookupId) return;
        if (!result) return;
        onUpdateForm('patientName', result.patientName);
        if (result.clientName) onUpdateForm('clientName', result.clientName);
        if (result.species) onUpdateForm('species', result.species);
        if (result.breed) onUpdateForm('breed', result.breed);
      })
      .catch(() => {})
      .finally(() => {
        if (lookupIdRef.current === lookupId) setPimsLookupLoading(false);
      });
  }, [slot.formData.pimsPatientId, onUpdateForm]);

  const hasRequiredFields =
    slot.formData.patientName.trim().length > 0 &&
    slot.formData.clientName.trim().length > 0 &&
    !!slot.formData.species &&
    !!slot.formData.appointmentType;

  // The slot's audio state determines what we show
  const audioState = isRecorderOwner ? recorder.state : slot.audioState;
  const isRecording = audioState === 'recording';
  const isPaused = audioState === 'paused';
  const isStopped = audioState === 'stopped';
  const hasSegments = slot.segments.length > 0;
  const previousSegmentsDuration = slot.segments.reduce((sum, s) => sum + s.duration, 0);
  const duration = isRecorderOwner
    ? previousSegmentsDuration + recorder.duration
    : slot.audioDuration;
  const metering = isRecorderOwner ? recorder.metering : -160;

  // Allow recording when idle (even with existing segments — for continuation)
  const canStartRecording = hasRequiredFields && audioState === 'idle' && !recorder.isStarting;
  const showSubmitCard = hasRequiredFields && slot.segments.length > 0 && slot.uploadStatus !== 'success';
  const canSubmitSingle = showSubmitCard && !submitBlockedByLiveRecording && slot.uploadStatus !== 'uploading';

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Patient header */}
      <View className="flex-row items-center justify-between mt-4 mb-3">
        <Text className="text-body text-stone-500 flex-1">
          Patient {slotIndex + 1} of {totalSlots}
        </Text>
        {totalSlots > 1 && (
          <Pressable
            onPress={onRemove}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove patient ${slotIndex + 1}`}
            className="flex-row items-center px-3 py-2 min-h-[44px] flex-shrink-0"
          >
            <X color="#dc2626" size={16} />
            <Text className="text-body-sm text-danger-600 ml-1">Remove</Text>
          </Pressable>
        )}
      </View>

      {/* Patient Form */}
      <Card className="mb-4">
        <PatientForm
          formData={slot.formData}
          onUpdate={onUpdateForm}
          templates={templates}
          templatesLoading={templatesLoading}
          onPimsIdBlur={handlePimsBlur}
          pimsLookupLoading={pimsLookupLoading}
        />
      </Card>

      {/* Recording Controls */}
      <Card className="mb-4 items-center">
        <Text className="text-body-lg font-semibold text-stone-900 mb-3">Record</Text>

        {/* Status badge */}
        <View className="mb-4" accessibilityLiveRegion="polite">
          {isRecording && isRecorderOwner ? (
            <View className="flex-row items-center">
              <PulsingDot />
              <Badge variant="danger">Recording...</Badge>
            </View>
          ) : isPaused && isRecorderOwner ? (
            <Badge variant="warning">Paused</Badge>
          ) : slot.audioState === 'paused' && !isRecorderOwner ? (
            <Badge variant="warning">Paused</Badge>
          ) : isStopped ? (
            <Badge variant="success">Recording Complete</Badge>
          ) : (
            <Badge variant="neutral">Ready to Record</Badge>
          )}
        </View>

        {/* Waveform or completion message */}
        {isRecorderOwner ? (
          <>
            <AudioWaveform
              isActive={isRecording || isPaused}
              isPaused={isPaused}
              metering={metering}
            />
            <Text
              className={`text-timer font-bold font-mono mb-5 ${
                isRecording ? 'text-brand-500' : 'text-stone-900'
              }`}
              style={{ alignSelf: 'stretch', textAlign: 'center' }}
            >
              {formatDuration(duration)}
            </Text>
          </>
        ) : isStopped ? (
          <Text className="text-body text-stone-600 mb-3" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
            {slot.segments.length > 1
              ? `${slot.segments.length} segments · ${formatDuration(slot.audioDuration)}`
              : formatDuration(slot.audioDuration)}
          </Text>
        ) : (
          <>
            <AudioWaveform isActive={false} />
            <Text className="text-timer font-bold font-mono mb-5 text-stone-900" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
              {formatDuration(duration)}
            </Text>
          </>
        )}

        {/* Non-blocking warning for multi-hour recordings. Peak extraction scales with
            FFmpeg seek cost on the edit path, which is slow on low-end Android (A7 Lite,
            MediaTek P22T). No cap — staff sometimes legitimately need long sessions. */}
        {duration >= LONG_RECORDING_WARNING_THRESHOLD_SEC && (
          <View
            className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-4 self-stretch"
            accessibilityRole="alert"
          >
            <Text className="text-caption text-amber-800 text-center">
              {LONG_RECORDING_WARNING_COPY.body}
            </Text>
          </View>
        )}

        {/* Controls */}
        <View className="flex-row gap-3">
          {/* Idle: show big record button */}
          {audioState === 'idle' && (
            <Animated.View entering={FadeIn.duration(300)}>
              <AnimatedPressable
                onPress={onStart}
                onPressIn={() => {
                  recordBtnScale.value = withSpring(0.9, { damping: 15, stiffness: 300 });
                }}
                onPressOut={() => {
                  recordBtnScale.value = withSpring(1, { damping: 15, stiffness: 300 });
                }}
                disabled={!canStartRecording}
                accessibilityRole="button"
                accessibilityLabel={
                  !hasRequiredFields
                    ? 'Enter patient name, client name, species, and appointment type first'
                    : recorderBusy
                      ? 'Start recording — will stop current recording first'
                      : 'Start recording'
                }
                className={`rounded-full justify-center items-center ${
                  canStartRecording ? 'bg-brand-500' : 'bg-stone-300'
                }`}
                style={[{ width: scale(80), height: scale(80) }, recordBtnAnimStyle]}
              >
                <Mic color="#fff" size={scale(32)} />
              </AnimatedPressable>
            </Animated.View>
          )}

          {/* Recording: pause + finish */}
          {isRecorderOwner && isRecording && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="secondary" onPress={onPause}>Pause</Button>
              <Button variant="primary" onPress={onStop} icon={<Check color="#fff" size={16} />}>Finish</Button>
            </Animated.View>
          )}

          {/* Paused: resume + finish (recorder owner) */}
          {isRecorderOwner && isPaused && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="secondary" onPress={onResume}>Resume</Button>
              <Button variant="primary" onPress={onStop} icon={<Check color="#fff" size={16} />}>Finish</Button>
            </Animated.View>
          )}

          {/* Paused but not recorder owner: let user continue or start over */}
          {isPaused && !isRecorderOwner && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              <Button variant="primary" onPress={onContinueRecording} icon={<Plus color="#fff" size={18} />}>Continue Recording</Button>
              {hasSegments && (
                <Pressable
                  onPress={onRecordAgain}
                  accessibilityRole="button"
                  accessibilityLabel="Delete recording and start over"
                  className="min-h-[44px] justify-center items-center"
                >
                  <View className="flex-row items-center gap-1.5">
                    <Trash2 color="#a8a29e" size={14} />
                    <Text className="text-body-sm text-stone-400">Delete & Start Over</Text>
                  </View>
                </Pressable>
              )}
            </Animated.View>
          )}

          {/* Stopped with segments: continue, edit, or discard */}
          {isStopped && hasSegments && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              <Button variant="primary" size="lg" onPress={onContinueRecording} icon={<Plus color="#fff" size={18} />}>
                Continue Recording
              </Button>
              <Button variant="secondary" onPress={onEditRecording} icon={<Scissors color="#1c1917" size={16} />}>
                Edit Recording
              </Button>
              <Pressable
                onPress={onRecordAgain}
                accessibilityRole="button"
                accessibilityLabel="Delete recording and start over"
                className="min-h-[44px] justify-center items-center"
              >
                <View className="flex-row items-center gap-1.5">
                  <Trash2 color="#a8a29e" size={14} />
                  <Text className="text-body-sm text-stone-400">Delete & Start Over</Text>
                </View>
              </Pressable>
            </Animated.View>
          )}

          {/* Stopped with no segments (error recovery) */}
          {isStopped && !hasSegments && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Button variant="primary" onPress={onContinueRecording}>Try Again</Button>
            </Animated.View>
          )}
        </View>

        {isStopped && hasSegments && !isRecorderOwner && (
          <Text className="text-caption text-stone-400 mt-2" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
            Processing usually takes 1-2 minutes.
          </Text>
        )}

        {/* Idle with existing segments: show info that new recording will be appended */}
        {audioState === 'idle' && hasSegments && (
          <Text className="text-caption text-brand-600 mt-3" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
            {slot.segments.length} segment{slot.segments.length > 1 ? 's' : ''} recorded ({formatDuration(slot.audioDuration)}). New recording will be appended.
          </Text>
        )}
      </Card>

      {/* Per-patient Submit */}
      {showSubmitCard && (
        <Animated.View entering={FadeInUp.duration(300)}>
          <Card className="mb-4">
            <Text className="text-body-lg font-semibold text-stone-900 mb-2">Submit</Text>
            <Text className="text-body-sm text-stone-500 mb-4">
              Upload this patient&apos;s recording and generate a SOAP note.
            </Text>

            {submitBlockedByLiveRecording && (
              <View
                className="mb-4 p-3 rounded-lg bg-warning-50"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                <Text className="text-body-sm text-warning-700">
                  Finish or discard the active recording segment before submitting.
                </Text>
              </View>
            )}

            {slot.uploadStatus === 'uploading' && (
              <View
                className="mb-4"
                accessibilityRole="progressbar"
                accessibilityLabel={`Upload progress ${slot.uploadProgress}%`}
                accessibilityValue={{ min: 0, max: 100, now: slot.uploadProgress }}
                accessibilityLiveRegion="polite"
              >
                <View className="flex-row justify-between mb-1.5">
                  <Text className="text-caption font-medium text-stone-700">
                    {slot.uploadProgress < 10 ? 'Preparing...' : slot.uploadProgress >= 95 ? 'Processing...' : 'Uploading...'}
                  </Text>
                  <Text className="text-caption text-stone-500">{slot.uploadProgress}%</Text>
                </View>
                <View className="h-2.5 rounded-full bg-stone-100 overflow-hidden">
                  <View
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${slot.uploadProgress}%` }}
                  />
                </View>
              </View>
            )}

            {slot.uploadStatus === 'error' && slot.uploadError && (
              <View
                className="mb-4 p-3 rounded-lg bg-danger-50"
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <Text className="text-body-sm text-danger-700">{slot.uploadError}</Text>
              </View>
            )}

            <Button
              variant="primary"
              size="lg"
              onPress={onSubmitSingle}
              loading={slot.uploadStatus === 'uploading'}
              disabled={!canSubmitSingle}
              accessibilityLabel="Submit and generate SOAP note"
            >
              {slot.uploadStatus === 'uploading' ? 'Uploading...' : slot.uploadStatus === 'error' ? 'Retry Upload' : 'Submit & Generate SOAP Note'}
            </Button>
          </Card>
        </Animated.View>
      )}

      {/* Upload success indicator */}
      {slot.uploadStatus === 'success' && (
        <Animated.View entering={FadeIn.duration(300)} accessibilityLiveRegion="polite">
          <Card className="mb-4 items-center" accessibilityRole="alert">
            <Badge variant="success">Uploaded Successfully</Badge>
            <Text className="text-body-sm text-stone-500 mt-2 text-center">
              SOAP note is being generated. You can check the status in your recordings list.
            </Text>
          </Card>
        </Animated.View>
      )}
    </ScrollView>
  );
});

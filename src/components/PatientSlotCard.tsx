import React from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
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
import { Mic, X, Plus, Scissors, Trash2, Check, ChevronDown, ChevronUp } from 'lucide-react-native';
import { PatientForm } from './PatientForm';
import { AudioWaveform } from './AudioWaveform';
import { RecorderLiveReadout } from './RecorderLiveReadout';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Toggle } from './ui/Toggle';
import type { PatientSlot } from '../types/multiPatient';
import type { CreateRecording, Template } from '../types';
import type { UseAudioRecorderReturn } from '../hooks/useAudioRecorder';
import { useResponsive } from '../hooks/useResponsive';
import { useThemeColors } from '../hooks/useThemeColors';
import { patientsApi } from '../api/patients';
import {
  LONG_RECORDING_WARNING_COPY,
  LONG_RECORDING_WARNING_THRESHOLD_SEC,
  MULTI_PATIENT_RECORD_FIRST_COPY,
} from '../constants/strings';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const styles = StyleSheet.create({
  timerText: {
    alignSelf: 'stretch',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0,
    includeFontPadding: false,
  },
});

interface PatientSlotCardProps {
  slot: PatientSlot;
  slotIndex: number;
  totalSlots: number;
  isRecorderOwner: boolean;
  recorder: UseAudioRecorderReturn;
  recorderBusy: boolean;
  isFinishSaving: boolean;
  templates: Template[];
  templatesLoading: boolean;
  defaultTemplateId?: string | null;
  onSetDefaultTemplate?: (templateId: string) => void | Promise<void>;
  defaultTemplateSaving?: boolean;
  width: number;
  // Slot-id parameterized so the parent can pass stable useCallback refs once
  // and React.memo on this component actually short-circuits re-renders during
  // the recorder's 500ms metering polls.
  onUpdateForm: (slotId: string, field: keyof CreateRecording, value: string | boolean | undefined) => void;
  onStart: (slotId: string) => void;
  onPause: (slotId: string) => void;
  onResume: (slotId: string) => void;
  onStop: (slotId: string) => void;
  onRecordAgain: (slotId: string) => void;
  onContinueRecording: (slotId: string) => void;
  onRemove: (slotId: string) => void;
  onSubmitSingle: (slotId: string) => void;
  onEditRecording: (slotId: string) => void;
  submitBlockedByLiveRecording: boolean;
  recordFirstEnabled?: boolean;
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

// Shallow-memoized: the parent passes slot-id-parameterized stable callbacks,
// and recorder ticks no longer re-render the parent (live metering/timer is
// polled inside RecorderLiveReadout), so default prop equality is sufficient.
export const PatientSlotCard = React.memo(function PatientSlotCard({
  slot,
  slotIndex,
  totalSlots,
  isRecorderOwner,
  recorder,
  recorderBusy,
  isFinishSaving,
  templates,
  templatesLoading,
  defaultTemplateId,
  onSetDefaultTemplate,
  defaultTemplateSaving,
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
  recordFirstEnabled = false,
}: PatientSlotCardProps) {
  const { scale } = useResponsive();
  const colors = useThemeColors();
  const recordBtnScale = useSharedValue(1);
  const recordBtnAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordBtnScale.value }],
  }));
  // Active-slot emphasis: gently scale the Record card up while this slot owns
  // a live recorder, so the hot slot reads as the focal point of the session.
  const recordCardScale = useSharedValue(1);
  const recordCardAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordCardScale.value }],
  }));

  // Bind slot.id once per render so child components (PatientForm, Button)
  // get callbacks with the legacy no-id signature without forcing the parent
  // to recreate them.
  const slotId = slot.id;
  const handleUpdateForm = React.useCallback(
    (field: keyof CreateRecording, value: string | boolean | undefined) =>
      onUpdateForm(slotId, field, value),
    [onUpdateForm, slotId]
  );
  const handleStart = React.useCallback(() => onStart(slotId), [onStart, slotId]);
  const handlePause = React.useCallback(() => onPause(slotId), [onPause, slotId]);
  const handleResume = React.useCallback(() => onResume(slotId), [onResume, slotId]);
  const handleStop = React.useCallback(() => onStop(slotId), [onStop, slotId]);
  const handleRecordAgain = React.useCallback(() => onRecordAgain(slotId), [onRecordAgain, slotId]);
  const handleContinueRecording = React.useCallback(
    () => onContinueRecording(slotId),
    [onContinueRecording, slotId]
  );
  const handleRemove = React.useCallback(() => onRemove(slotId), [onRemove, slotId]);
  const handleSubmitSingle = React.useCallback(
    () => onSubmitSingle(slotId),
    [onSubmitSingle, slotId]
  );
  const handleEditRecording = React.useCallback(
    () => onEditRecording(slotId),
    [onEditRecording, slotId]
  );
  const preferPatientDetailsFirst = recordFirstEnabled && totalSlots > 1;

  const [pimsLookupLoading, setPimsLookupLoading] = React.useState(false);
  const [detailsExpanded, setDetailsExpanded] = React.useState(!recordFirstEnabled || preferPatientDetailsFirst);
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
        handleUpdateForm('patientName', result.patientName);
        if (result.clientName) handleUpdateForm('clientName', result.clientName);
        if (result.species) handleUpdateForm('species', result.species);
        if (result.breed) handleUpdateForm('breed', result.breed);
      })
      .catch(() => {})
      .finally(() => {
        if (lookupIdRef.current === lookupId) setPimsLookupLoading(false);
      });
  }, [slot.formData.pimsPatientId, handleUpdateForm]);

  const hasRequiredFields =
    slot.formData.patientName.trim().length > 0 &&
    (slot.formData.clientName?.trim().length ?? 0) > 0 &&
    (slot.formData.species?.trim().length ?? 0) > 0 &&
    !!slot.formData.appointmentType;
  const hasAnyPatientDetails =
    !!slot.formData.pimsPatientId?.trim() ||
    !!slot.formData.patientName.trim() ||
    !!slot.formData.clientName?.trim() ||
    !!slot.formData.species?.trim() ||
    !!slot.formData.breed?.trim() ||
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

  React.useEffect(() => {
    if (!recordFirstEnabled || preferPatientDetailsFirst) {
      setDetailsExpanded(true);
    }
  }, [preferPatientDetailsFirst, recordFirstEnabled]);

  React.useEffect(() => {
    if (recordFirstEnabled && !preferPatientDetailsFirst && audioState !== 'idle') {
      setDetailsExpanded(false);
    }
  }, [audioState, preferPatientDetailsFirst, recordFirstEnabled]);

  // This slot is the "hot" one when it owns the recorder and is live.
  const recorderLive = isRecorderOwner && (isRecording || isPaused);
  React.useEffect(() => {
    recordCardScale.value = withSpring(recorderLive ? 1.02 : 1, { damping: 15, stiffness: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recordCardScale is a stable SharedValue ref
  }, [recorderLive]);
  // red = capturing, amber = paused (CLAUDE.md: distinguish from slot.audioState).
  const activeEmphasisClass = recorderLive
    ? `shadow-glow border-l-4 ${isRecording ? 'border-l-danger-500' : 'border-l-warning-500'}`
    : '';

  // Allow recording when idle (even with existing segments — for continuation)
  const canStartRecording = (recordFirstEnabled || hasRequiredFields) && audioState === 'idle' && !recorder.isStarting && !isFinishSaving;
  const showSubmitCard = (recordFirstEnabled || hasRequiredFields) && slot.segments.length > 0 && slot.uploadStatus !== 'success';
  const canSubmitSingle = showSubmitCard && !submitBlockedByLiveRecording && slot.uploadStatus !== 'uploading' && !isFinishSaving;
  const patientForm = (
    <PatientForm
      formData={slot.formData}
      onUpdate={handleUpdateForm}
      templates={templates}
      templatesLoading={templatesLoading}
      defaultTemplateId={defaultTemplateId}
      onSetDefaultTemplate={onSetDefaultTemplate}
      defaultTemplateSaving={defaultTemplateSaving}
      onPimsIdBlur={handlePimsBlur}
      pimsLookupLoading={pimsLookupLoading}
      recordFirstEnabled={recordFirstEnabled}
      recordFirstMultiPatient={preferPatientDetailsFirst}
    />
  );
  const formCard = recordFirstEnabled ? (
    <Card className="mb-4">
      <Pressable
        onPress={() => setDetailsExpanded((current) => !current)}
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsExpanded }}
        accessibilityLabel="Add patient details"
        className="flex-row items-center justify-between py-1"
        hitSlop={8}
      >
        <View className="flex-1 pr-3">
          <Text className="text-body-lg font-semibold text-content-primary">
            Add patient details
          </Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">
            {preferPatientDetailsFirst
              ? MULTI_PATIENT_RECORD_FIRST_COPY.detailsSubtitle
              : 'Optional — AI will fill blanks from audio.'}
          </Text>
        </View>
        {detailsExpanded ? (
          <ChevronUp color={colors.contentTertiary} size={20} />
        ) : (
          <ChevronDown color={colors.contentTertiary} size={20} />
        )}
      </Pressable>
      {detailsExpanded ? (
        <View className="mt-4 pt-4 border-t border-border-default">
          {patientForm}
        </View>
      ) : hasAnyPatientDetails ? (
        <Text className="text-caption text-brand-600 mt-2">
          Details added
        </Text>
      ) : null}
    </Card>
  ) : (
    <Card className="mb-4">
      {patientForm}
    </Card>
  );
  // Recording-level flag — lives directly below the patient-details section,
  // not inside it, so it stays visible when details are collapsed.
  const foreignLanguageCard = (
    <Card className="mb-4">
      <Toggle
        value={!!slot.formData.foreignLanguage}
        onValueChange={(value) => handleUpdateForm('foreignLanguage', value)}
        label="Foreign Language"
        description="Enable if a non-English language was spoken during this exam"
        accessibilityLabel="Foreign Language"
        accessibilityHint="Enable if a non-English language was spoken during this exam"
      />
    </Card>
  );

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Patient header */}
      <View className="flex-row items-center justify-between mt-4 mb-3">
        <Text className="text-body text-content-tertiary flex-1">
          Patient {slotIndex + 1} of {totalSlots}
        </Text>
        {totalSlots > 1 && (
          <Pressable
            onPress={handleRemove}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove patient ${slotIndex + 1}`}
            className="flex-row items-center px-3 py-2 min-h-[44px] flex-shrink-0"
          >
            <X color={colors.danger600} size={16} style={{ flexShrink: 0 }} />
            {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
            <Text
              className="text-body-sm text-status-danger ml-1"
              allowFontScaling={false}
              style={{ flexShrink: 0, paddingRight: 2 }}
            >
              {'Remove '}
            </Text>
          </Pressable>
        )}
      </View>

      {(!recordFirstEnabled || preferPatientDetailsFirst) && formCard}
      {(!recordFirstEnabled || preferPatientDetailsFirst) && foreignLanguageCard}

      {/* Recording Controls */}
      <Animated.View style={recordCardAnimStyle}>
      <Card className={`mb-4 items-center ${activeEmphasisClass}`}>
        <Text className="text-body-lg font-semibold text-content-primary mb-3">Record</Text>

        {/* Status badge */}
        <View className="mb-4" accessibilityLiveRegion="polite">
          {isFinishSaving ? (
            <Badge variant="warning">Saving recording...</Badge>
          ) : isRecording && isRecorderOwner ? (
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

        {/* Waveform or completion message. The owner branch polls the
            recorder inside RecorderLiveReadout so metering/timer ticks
            re-render that leaf only — never this card or the record screen. */}
        {isRecorderOwner ? (
          <RecorderLiveReadout
            getLiveStats={recorder.getLiveStats}
            isLive={isRecording || isPaused}
            isRecording={isRecording}
            isPaused={isPaused}
            baseDurationSeconds={previousSegmentsDuration}
            fallbackDurationSeconds={recorder.duration}
          />
        ) : isStopped ? (
          <Text className="text-body text-content-secondary mb-3" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
            {slot.segments.length > 1
              ? `${slot.segments.length} segments · ${formatDuration(slot.audioDuration)}`
              : formatDuration(slot.audioDuration)}
          </Text>
        ) : (
          <>
            <AudioWaveform isActive={false} />
            <Text className="text-timer font-bold mb-5 text-content-primary" style={styles.timerText}>
              {formatDuration(duration)}
            </Text>
          </>
        )}

        {/* Non-blocking warning for multi-hour recordings (non-owner cards;
            the owner card's warning lives inside RecorderLiveReadout so it
            appears during a live recording, not only after a transition). */}
        {!isRecorderOwner && duration >= LONG_RECORDING_WARNING_THRESHOLD_SEC && (
          <View
            className="rounded-lg bg-status-warning border border-status-warning px-3 py-2 mb-4 self-stretch"
            accessibilityRole="alert"
          >
            <Text className="text-caption text-status-warning text-center">
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
                onPress={handleStart}
                onPressIn={() => {
                  recordBtnScale.value = withSpring(0.9, { damping: 15, stiffness: 300 });
                }}
                onPressOut={() => {
                  recordBtnScale.value = withSpring(1, { damping: 15, stiffness: 300 });
                }}
                disabled={!canStartRecording}
                accessibilityRole="button"
                accessibilityLabel={
                  !recordFirstEnabled && !hasRequiredFields
                    ? 'Enter patient name, client name, species, and appointment type first'
                    : recorderBusy
                      ? 'Start recording — will stop current recording first'
                      : 'Start recording'
                }
                className={`rounded-full justify-center items-center ${
                  canStartRecording ? 'bg-brand-500' : 'bg-border-strong'
                }`}
                style={[{ width: scale(80), height: scale(80) }, recordBtnAnimStyle]}
              >
                <Mic color={canStartRecording ? colors.contentOnBrand : colors.contentTertiary} size={scale(32)} />
              </AnimatedPressable>
            </Animated.View>
          )}

          {/* Recording: pause + finish */}
          {isRecorderOwner && isRecording && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="secondary" onPress={handlePause}>Pause</Button>
              <Button variant="primary" onPress={handleStop} icon={<Check color={colors.contentOnBrand} size={16} />}>Finish</Button>
            </Animated.View>
          )}

          {/* Paused: resume + finish (recorder owner) */}
          {isRecorderOwner && isPaused && (
            <Animated.View entering={FadeIn.duration(200)} className="flex-row gap-3">
              <Button variant="secondary" onPress={handleResume}>Resume</Button>
              <Button variant="primary" onPress={handleStop} icon={<Check color={colors.contentOnBrand} size={16} />}>Finish</Button>
            </Animated.View>
          )}

          {/* Paused but not recorder owner: let user continue or start over */}
          {isPaused && !isRecorderOwner && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              <Button variant="primary" onPress={handleContinueRecording} icon={<Plus color={colors.contentOnBrand} size={18} />}>Continue Recording</Button>
              {hasSegments && (
                <Pressable
                  onPress={handleRecordAgain}
                  accessibilityRole="button"
                  accessibilityLabel="Delete recording and start over"
                  className="min-h-[44px] justify-center items-center"
                >
                  <View className="flex-row items-center gap-1.5">
                    <Trash2 color={colors.contentTertiary} size={14} style={{ flexShrink: 0 }} />
                    {/* Trailing space + flexShrink:0 — Android under-measures Text in flex-row and clips the last glyph; do NOT remove. */}
                    <Text
                      className="text-body-sm text-content-tertiary"
                      allowFontScaling={false}
                      style={{ flexShrink: 0, paddingRight: 2 }}
                    >
                      {'Delete & Start Over '}
                    </Text>
                  </View>
                </Pressable>
              )}
            </Animated.View>
          )}

          {/* Stopped with segments: continue, edit, or discard */}
          {isStopped && hasSegments && isFinishSaving && (
            <Text className="text-body-sm text-content-tertiary text-center" accessibilityLiveRegion="polite">
              Saving recording...
            </Text>
          )}

          {isStopped && hasSegments && !isFinishSaving && (
            <Animated.View entering={FadeIn.duration(200)} className="gap-2">
              <Button variant="primary" size="lg" onPress={handleContinueRecording} icon={<Plus color={colors.contentOnBrand} size={18} />}>
                Continue Recording
              </Button>
              <Button variant="secondary" onPress={handleEditRecording} icon={<Scissors color={colors.contentPrimary} size={16} />}>
                Edit Recording
              </Button>
              <Pressable
                onPress={handleRecordAgain}
                accessibilityRole="button"
                accessibilityLabel="Delete recording and start over"
                className="min-h-[44px] justify-center items-center"
              >
                <View className="flex-row items-center gap-1.5">
                  <Trash2 color={colors.contentTertiary} size={14} style={{ flexShrink: 0 }} />
                  {/* Trailing space + flexShrink:0 — Android under-measures Text in flex-row and clips the last glyph; do NOT remove. */}
                  <Text
                    className="text-body-sm text-content-tertiary"
                    allowFontScaling={false}
                    style={{ flexShrink: 0, paddingRight: 2 }}
                  >
                    {'Delete & Start Over '}
                  </Text>
                </View>
              </Pressable>
            </Animated.View>
          )}

          {/* Stopped with no segments (error recovery) */}
          {isStopped && !hasSegments && !isFinishSaving && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Button variant="primary" onPress={handleContinueRecording}>Try Again</Button>
            </Animated.View>
          )}
        </View>

        {isStopped && hasSegments && !isRecorderOwner && !isFinishSaving && (
          <Text className="text-caption text-content-tertiary mt-2" style={{ alignSelf: 'stretch', textAlign: 'center' }}>
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
      </Animated.View>

      {recordFirstEnabled && !preferPatientDetailsFirst && formCard}
      {recordFirstEnabled && !preferPatientDetailsFirst && foreignLanguageCard}

      {/* Per-patient Submit */}
      {showSubmitCard && (
        <Animated.View entering={FadeInUp.duration(300)}>
          <Card className="mb-4">
            <Text className="text-body-lg font-semibold text-content-primary mb-2">Submit</Text>
            <Text className="text-body-sm text-content-tertiary mb-4">
              Upload this patient&apos;s recording and generate a SOAP note.
            </Text>

            {submitBlockedByLiveRecording && (
              <View
                className="mb-4 p-3 rounded-lg bg-status-warning"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                <Text className="text-body-sm text-status-warning">
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
                  <Text className="text-caption font-medium text-content-body">
                    {slot.uploadProgress < 10 ? 'Preparing...' : slot.uploadProgress >= 95 ? 'Processing...' : 'Uploading...'}
                  </Text>
                  <Text className="text-caption text-content-tertiary">{slot.uploadProgress}%</Text>
                </View>
                <View className="h-2.5 rounded-full bg-surface-sunken overflow-hidden">
                  <View
                    className="h-full rounded-full bg-brand-500"
                    style={{ width: `${slot.uploadProgress}%` }}
                  />
                </View>
              </View>
            )}

            {slot.uploadStatus === 'error' && slot.uploadError && (
              <View
                className="mb-4 p-3 rounded-lg bg-status-danger"
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <Text className="text-body-sm text-status-danger">{slot.uploadError}</Text>
              </View>
            )}

            <Button
              variant="primary"
              size="lg"
              onPress={handleSubmitSingle}
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
            <Text className="text-body-sm text-content-tertiary mt-2 text-center">
              SOAP note is being generated. You can check the status in your recordings list.
            </Text>
          </Card>
        </Animated.View>
      )}
    </ScrollView>
  );
});

import React from 'react';
import { View, Text } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { Button } from './ui/Button';
import type { PatientSlot } from '../types/multiPatient';

interface SubmitPanelProps {
  slots: PatientSlot[];
  isSubmitting: boolean;
  onSubmitAll: () => void;
  hasActiveRecording: boolean;
  recordFirstEnabled?: boolean;
}

export function SubmitPanel({
  slots,
  isSubmitting,
  onSubmitAll,
  hasActiveRecording,
  recordFirstEnabled = false,
}: SubmitPanelProps) {
  // A durable slot has empty segments (audio in audio.aac) but is a real,
  // submittable recording — count it as recorded/ready or Submit All hides for
  // durable-only sessions and durable slots are silently skipped.
  const hasAudio = (s: PatientSlot) => s.segments.length > 0 || s.durable !== null;
  const hasRequiredFields = (s: PatientSlot) =>
    s.formData.patientName.trim().length > 0 &&
    (s.formData.clientName?.trim().length ?? 0) > 0 &&
    (s.formData.species?.trim().length ?? 0) > 0 &&
    !!s.formData.appointmentType;
  const canSubmitSlot = (s: PatientSlot) => recordFirstEnabled || hasRequiredFields(s);
  const recorded = slots.filter(hasAudio).length;
  const uploaded = slots.filter((s) => s.uploadStatus === 'success').length;
  const readyToUpload = slots.filter(
    (s) => hasAudio(s) && canSubmitSlot(s) && s.uploadStatus !== 'success' && s.uploadStatus !== 'uploading'
  ).length;
  const needsDetails = recordFirstEnabled
    ? 0
    : slots.filter(
        (s) => hasAudio(s) && !hasRequiredFields(s) && s.uploadStatus !== 'success'
      ).length;
  const submitBlockedByMissingDetails = needsDetails > 0;

  // Show for 2+ slots when there is either something ready to submit or a
  // recorded slot that needs details before submission.
  if (slots.length < 2 || (readyToUpload === 0 && needsDetails === 0)) return null;

  const skipped = slots.length - recorded;

  return (
    <Animated.View
      entering={FadeInUp.duration(300)}
      className="px-5 py-4 border-t border-border-default bg-surface-raised"
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
    >
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-body-sm text-content-secondary">
          {recorded} of {slots.length} patients recorded
          {uploaded > 0 ? ` (${uploaded} already uploaded)` : ''}
        </Text>
      </View>

      {skipped > 0 && (
        <Text className="text-caption text-status-warning mb-2">
          {skipped} patient{skipped > 1 ? 's have' : ' has'} no recording — will be skipped
        </Text>
      )}

      {needsDetails > 0 && (
        <Text className="text-caption text-status-warning mb-2">
          {needsDetails} recorded patient{needsDetails > 1 ? 's need' : ' needs'} required details before submit
        </Text>
      )}

      {hasActiveRecording && (
        <Text className="text-caption text-status-warning mb-2">
          Finish or discard all active recording segments before submitting all patients.
        </Text>
      )}

      <Button
        variant="primary"
        size="lg"
        onPress={onSubmitAll}
        loading={isSubmitting}
        disabled={isSubmitting || hasActiveRecording || submitBlockedByMissingDetails}
        accessibilityLabel={
          submitBlockedByMissingDetails
            ? 'Add required details before submitting all recordings'
            : `Submit ${readyToUpload} recording${readyToUpload > 1 ? 's' : ''}`
        }
      >
        {isSubmitting
          ? 'Uploading...'
          : submitBlockedByMissingDetails
            ? 'Add Required Details'
            : `Submit All Recordings (${readyToUpload})`}
      </Button>
    </Animated.View>
  );
}

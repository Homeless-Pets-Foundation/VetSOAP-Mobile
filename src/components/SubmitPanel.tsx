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
}

export function SubmitPanel({ slots, isSubmitting, onSubmitAll, hasActiveRecording }: SubmitPanelProps) {
  const recorded = slots.filter((s) => s.segments.length > 0).length;
  const uploaded = slots.filter((s) => s.uploadStatus === 'success').length;
  const readyToUpload = slots.filter(
    (s) => s.segments.length > 0 && s.uploadStatus !== 'success' && s.uploadStatus !== 'uploading'
  ).length;

  // Only show when 2+ slots and at least 1 has a completed recording not yet uploaded
  if (slots.length < 2 || readyToUpload === 0) return null;

  const skipped = slots.length - recorded;

  return (
    <Animated.View
      entering={FadeInUp.duration(300)}
      className="px-5 py-4 border-t border-stone-200 bg-white"
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
    >
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-body-sm text-stone-600">
          {recorded} of {slots.length} patients recorded
          {uploaded > 0 ? ` (${uploaded} already uploaded)` : ''}
        </Text>
      </View>

      {skipped > 0 && (
        <Text className="text-caption text-warning-600 mb-2">
          {skipped} patient{skipped > 1 ? 's have' : ' has'} no recording — will be skipped
        </Text>
      )}

      {hasActiveRecording && (
        <Text className="text-caption text-warning-600 mb-2">
          Finish or discard all active recording segments before submitting all patients.
        </Text>
      )}

      <Button
        variant="primary"
        size="lg"
        onPress={onSubmitAll}
        loading={isSubmitting}
        disabled={isSubmitting || hasActiveRecording}
        accessibilityLabel={`Submit ${readyToUpload} recording${readyToUpload > 1 ? 's' : ''}`}
      >
        {isSubmitting ? 'Uploading...' : `Submit All Recordings (${readyToUpload})`}
      </Button>
    </Animated.View>
  );
}

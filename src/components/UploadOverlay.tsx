import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { Upload } from 'lucide-react-native';
import type { PatientSlot } from '../types/multiPatient';
import { UPLOAD_OVERLAY_COPY } from '../constants/strings';
import { useThemeColors } from '../hooks/useThemeColors';

interface UploadOverlayProps {
  visible: boolean;
  slots: PatientSlot[];
  currentSlotId: string | null;
  totalSlotsToUpload: number;
  isMulti: boolean;
}

export function UploadOverlay({
  visible,
  slots,
  currentSlotId,
  totalSlotsToUpload,
  isMulti,
}: UploadOverlayProps) {
  const colors = useThemeColors();
  const progressWidth = useSharedValue(0);

  // Compute progress
  const currentSlot = slots.find((s) => s.id === currentSlotId);
  const currentProgress = currentSlot?.uploadProgress ?? 0;

  const completedCount = slots.filter((s) => s.uploadStatus === 'success').length;
  const uploadsCompleted = Math.min(completedCount, totalSlotsToUpload);

  let overallProgress: number;
  let currentUploadIndex: number;

  if (isMulti && totalSlotsToUpload > 1) {
    overallProgress =
      totalSlotsToUpload > 0
        ? Math.round(((uploadsCompleted * 100 + currentProgress) / (totalSlotsToUpload * 100)) * 100)
        : 0;
    currentUploadIndex = uploadsCompleted + 1;
  } else {
    overallProgress = currentProgress;
    currentUploadIndex = 1;
  }

  // Use overallProgress for phase text in multi-patient mode so label matches percentage
  const progressForPhase = isMulti && totalSlotsToUpload > 1 ? overallProgress : currentProgress;
  // Sentinel: when uploadSlot is in the FFmpeg split phase, it sets progress
  // into [1, 5) (between the initial 0 and the upload-start 5). Display the
  // dedicated "Preparing audio…" label so users on slow tablets see meaningful
  // text instead of a frozen "Preparing..." for up to a minute.
  const phaseText =
    progressForPhase >= 1 && progressForPhase < 5
      ? UPLOAD_OVERLAY_COPY.phasePreparing
      : progressForPhase < 10
        ? UPLOAD_OVERLAY_COPY.phaseStarting
        : progressForPhase >= 95
          ? UPLOAD_OVERLAY_COPY.phaseProcessing
          : UPLOAD_OVERLAY_COPY.phaseUploading;

  useEffect(() => {
    if (!visible) {
      cancelAnimation(progressWidth);
      progressWidth.value = 0;
      return;
    }
    // Skip animation for the initial jump (0 → first real value)
    if (progressWidth.value === 0 && overallProgress > 0) {
      progressWidth.value = overallProgress;
    } else {
      progressWidth.value = withTiming(overallProgress, {
        duration: 300,
        easing: Easing.out(Easing.ease),
      });
    }
    return () => {
      cancelAnimation(progressWidth);
    };
  }, [overallProgress, visible, progressWidth]);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value}%`,
  }));

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      exiting={FadeOut.duration(200)}
      style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
      className="justify-center items-center px-6"
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={`Upload in progress. ${phaseText} ${overallProgress}%`}
    >
      <Animated.View
        entering={FadeInUp.duration(300)}
        className="bg-surface-raised rounded-2xl p-6 w-full items-center shadow-card-md"
        style={{ maxWidth: 340 }}
      >
        {/* Icon */}
        <View className="bg-brand-50 dark:bg-surface-sunken rounded-full w-16 h-16 justify-center items-center mb-4">
          <Upload color={colors.brand500} size={28} />
        </View>

        {/* Title */}
        <Text className="text-lg font-bold text-content-primary mb-1 text-center">
          {isMulti && totalSlotsToUpload > 1
            ? UPLOAD_OVERLAY_COPY.titleMulti
            : UPLOAD_OVERLAY_COPY.title}
        </Text>

        {/* Phase + percentage row */}
        <View className="flex-row justify-between w-full mb-2 mt-3">
          <Text className="text-sm text-content-secondary">{phaseText}</Text>
          <Text className="text-sm font-semibold text-brand-500">
            {overallProgress}%
          </Text>
        </View>

        {/* Progress bar */}
        <View
          className="h-3 rounded-full bg-surface-sunken overflow-hidden w-full mb-3"
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: overallProgress }}
        >
          <Animated.View
            className="h-full rounded-full bg-brand-500"
            style={progressStyle}
          />
        </View>

        {/* Multi-patient counter */}
        {isMulti && totalSlotsToUpload > 1 && (
          <Text className="text-xs text-content-tertiary">
            Recording {Math.min(currentUploadIndex, totalSlotsToUpload)} of{' '}
            {totalSlotsToUpload}
          </Text>
        )}

        {/* Reassurance text — no horizontal padding: centered captions in this
            narrow card clipped on Android with the old longer copy. */}
        <Text className="text-xs text-content-tertiary mt-3 text-center">
          {UPLOAD_OVERLAY_COPY.reassurance}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

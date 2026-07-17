import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { Upload } from 'lucide-react-native';
import type { PatientSlot } from '../types/multiPatient';
import { UPLOAD_OVERLAY_COPY } from '../constants/strings';
import { useThemeColors } from '../hooks/useThemeColors';
import { Toast } from './Toast';

interface UploadOverlayProps {
  visible: boolean;
  slots: PatientSlot[];
  currentSlotId: string | null;
  /** Slot ids in the CURRENT submit batch — progress math is scoped to these. */
  batchSlotIds: string[];
  isMulti: boolean;
  /** Optional escape hatch: lets the user hide the full-screen scrim while uploads continue. */
  onHide?: () => void;
}

/**
 * Completed-count for the current batch only. Counting every session slot
 * with uploadStatus === 'success' inflated progress when a Submit All
 * followed a single submit (started at 50%, showed "Recording 2 of 2").
 */
export function countBatchCompleted(slots: PatientSlot[], batchSlotIds: string[]): number {
  if (batchSlotIds.length === 0) return 0;
  const batch = new Set(batchSlotIds);
  return slots.filter((s) => batch.has(s.id) && s.uploadStatus === 'success').length;
}

export function UploadOverlay({
  visible,
  slots,
  currentSlotId,
  batchSlotIds,
  isMulti,
  onHide,
}: UploadOverlayProps) {
  const colors = useThemeColors();
  const progressWidth = useSharedValue(0);

  // Gentle pulse on the upload icon so the overlay feels alive mid-transfer.
  const iconPulse = useSharedValue(1);
  useEffect(() => {
    if (!visible) {
      cancelAnimation(iconPulse);
      iconPulse.value = 1;
      return;
    }
    iconPulse.value = withRepeat(
      withTiming(1.08, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => { cancelAnimation(iconPulse); };
  }, [visible, iconPulse]);
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: iconPulse.value }] }));

  // Per-slot "<Patient> uploaded" toast — fires as each slot confirms.
  const [slotToast, setSlotToast] = useState<string | null>(null);
  const confirmedIdsRef = useRef<Set<string>>(new Set());
  const prevVisibleRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      prevVisibleRef.current = false;
      confirmedIdsRef.current = new Set();
      // Clear any pending toast too — else a slow 2s timer that never fired
      // leaves a stale "<old patient> uploaded" that remounts on the next
      // submit in the same Record screen (wrong/confusing patient context).
      setSlotToast(null);
      return;
    }
    // On open, seed the set with slots that were ALREADY uploaded before this
    // batch so they don't fire stale "<old patient> uploaded" toasts.
    const justOpened = !prevVisibleRef.current;
    prevVisibleRef.current = true;
    for (const s of slots) {
      if (s.uploadStatus === 'success' && !confirmedIdsRef.current.has(s.id)) {
        confirmedIdsRef.current.add(s.id);
        if (!justOpened) {
          const name = s.formData.patientName?.trim() || 'Recording';
          setSlotToast(`${name} uploaded`);
        }
      }
    }
  }, [slots, visible]);

  // Compute progress — scoped to the current batch.
  const currentSlot = slots.find((s) => s.id === currentSlotId);
  const currentProgress = currentSlot?.uploadProgress ?? 0;

  const totalSlotsToUpload = batchSlotIds.length;
  const uploadsCompleted = Math.min(countBatchCompleted(slots, batchSlotIds), totalSlotsToUpload);

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
      // Announce the upload once — the live percentage moved to the
      // progressbar's accessibilityValue so screen readers aren't re-announced
      // assertively on every tick.
      accessibilityLabel={
        isMulti && totalSlotsToUpload > 1
          ? UPLOAD_OVERLAY_COPY.announceMulti(totalSlotsToUpload)
          : UPLOAD_OVERLAY_COPY.announceSingle
      }
    >
      <Animated.View
        entering={FadeInUp.duration(300)}
        className="bg-surface-raised rounded-2xl p-6 w-full items-center shadow-card-md"
        style={{ maxWidth: 340 }}
      >
        {/* Icon */}
        <View className="bg-brand-50 dark:bg-surface-sunken rounded-full w-16 h-16 justify-center items-center mb-4">
          <Animated.View style={iconStyle}>
            <Upload color={colors.brand500} size={28} />
          </Animated.View>
        </View>

        {/* Title */}
        <Text className="text-heading font-bold text-content-primary mb-1 text-center">
          {isMulti && totalSlotsToUpload > 1
            ? UPLOAD_OVERLAY_COPY.titleMulti
            : UPLOAD_OVERLAY_COPY.title}
        </Text>

        {/* Phase + percentage row */}
        <View className="flex-row justify-between w-full mb-2 mt-3">
          <Text className="text-body-sm text-content-secondary">{phaseText}</Text>
          <Text className="text-body-sm font-semibold text-brand-500">
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
          <Text className="text-caption text-content-tertiary">
            Recording {Math.min(currentUploadIndex, totalSlotsToUpload)} of{' '}
            {totalSlotsToUpload}
          </Text>
        )}

        {/* Reassurance text — no horizontal padding: centered captions in this
            narrow card clipped on Android with the old longer copy. */}
        <Text className="text-caption text-content-tertiary mt-3 text-center">
          {UPLOAD_OVERLAY_COPY.reassurance}
        </Text>

        {/* Escape hatch: uploads of up to 10 slots on cellular can take many
            minutes; without this the only way out of the scrim is killing the
            app. Hiding never cancels — the loop lives in record.tsx. */}
        {onHide && (
          <Pressable
            onPress={onHide}
            accessibilityRole="button"
            accessibilityLabel={UPLOAD_OVERLAY_COPY.hide}
            hitSlop={10}
            className="mt-4 px-4"
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
            <Text
              className="text-body-sm font-semibold text-brand-500"
              style={{ flexShrink: 0, paddingRight: 2 }}
            >
              {`${UPLOAD_OVERLAY_COPY.hide} `}
            </Text>
          </Pressable>
        )}
      </Animated.View>
      <Toast
        message={slotToast ?? ''}
        visible={!!slotToast}
        onHide={() => setSlotToast(null)}
      />
    </Animated.View>
  );
}

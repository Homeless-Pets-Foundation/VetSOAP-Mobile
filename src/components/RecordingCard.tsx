import React from 'react';
import { Alert, View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight, CloudOff, Smartphone, Sparkles } from 'lucide-react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { ApiError } from '../api/client';
import { recordingsApi } from '../api/recordings';
import { StatusBadge } from './StatusBadge';
import { ReviewStatusChip } from './ReviewStatusChip';
import type { Recording } from '../types';
import { METADATA_REVIEW_COPY } from '../constants/strings';
import { displayPatientName, isUntitledVisit } from '../lib/recordingDisplay';
import { getRecordingReviewStatus } from '../lib/recordingReview';
import { invalidateRecordingCaches, mergeRecordingIntoCachedLists } from '../lib/recordingQueryCache';
import { useThemeColors } from '../hooks/useThemeColors';

interface RecordingCardProps {
  recording: Recording;
  localDraftSlotId?: string;
  highlighted?: boolean;
}

function DraftLocationChip({ isOnDevice }: { isOnDevice: boolean }) {
  const colors = useThemeColors();
  const Icon = isOnDevice ? Smartphone : CloudOff;
  const containerClass = isOnDevice ? 'bg-brand-100 dark:bg-surface-sunken' : 'bg-status-warning';
  const textClass = isOnDevice ? 'text-brand-700 dark:text-brand-500' : 'text-status-warning';
  const iconColor = isOnDevice ? colors.brand500 : colors.statusWarningFg;
  const label = isOnDevice ? 'On this device' : 'Not on this device';

  return (
    <View
      className={`px-2 py-0.5 rounded-badge flex-row items-center self-end ${containerClass}`}
      accessibilityRole="text"
      accessibilityLabel={isOnDevice ? 'Draft audio is saved on this device' : 'Draft audio is not saved on this device'}
    >
      <Icon color={iconColor} size={12} style={{ marginRight: 4, flexShrink: 0 }} />
      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text in self-end flex-rows and clips the last glyph; do NOT remove. */}
      <Text className={`text-caption font-semibold ${textClass}`} style={{ flexShrink: 0, paddingRight: 2 }}>
        {`${label} `}
      </Text>
    </View>
  );
}

function AiLabeledChip() {
  const colors = useThemeColors();
  return (
    <View
      className="px-2 py-0.5 rounded-badge flex-row items-center self-end bg-brand-50 dark:bg-surface-sunken"
      accessibilityRole="text"
      accessibilityLabel={METADATA_REVIEW_COPY.aiLabeled}
    >
      <Sparkles color={colors.brand500} size={12} style={{ marginRight: 4, flexShrink: 0 }} />
      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text in self-end flex-rows and clips the last glyph; do NOT remove. */}
      <Text className="text-caption font-semibold text-brand-700 dark:text-brand-500" style={{ flexShrink: 0, paddingRight: 2 }}>
        {`${METADATA_REVIEW_COPY.aiLabeled} `}
      </Text>
    </View>
  );
}

export const RecordingCard = React.memo(function RecordingCard({
  recording,
  localDraftSlotId,
  highlighted = false,
}: RecordingCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const reviewStatus = getRecordingReviewStatus(recording);

  const reviewMutation = useMutation({
    mutationFn: (reviewed: boolean) => recordingsApi.updateReview(recording.id, { reviewed }),
    onSuccess: (updatedRecording) => {
      if (updatedRecording?.id) {
        queryClient.setQueryData(['recording', updatedRecording.id], updatedRecording);
        mergeRecordingIntoCachedLists(queryClient, updatedRecording);
      }
      invalidateRecordingCaches(queryClient, 'review_update');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
        return;
      }
      Alert.alert(
        'Review Update Failed',
        error instanceof ApiError ? error.message : 'Could not update the review status. Please try again.'
      );
    },
  });

  const formattedDate = React.useMemo(() => {
    const parsedDate = new Date(recording.createdAt);
    return isNaN(parsedDate.getTime())
      ? ''
      : parsedDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  }, [recording.createdAt]);

  const description = React.useMemo(
    () => [
      recording.species,
      recording.breed ? `${recording.breed}` : null,
    ]
      .filter(Boolean)
      .join(' \u00B7 '),
    [recording.breed, recording.species]
  );

  const clientLabel = recording.clientName?.trim();
  const patientLabel = displayPatientName(recording);
  const patientIsUntitled = isUntitledVisit(recording);
  const aiAppliedCount = Array.isArray(recording.aiExtractedMetadata?.appliedFields)
    ? recording.aiExtractedMetadata.appliedFields.length
    : 0;
  const showAiLabeledChip = aiAppliedCount > 0;
  const isDraft = recording.status === 'draft';
  const hasLocalDraftAudio = Boolean(localDraftSlotId);
  const accessibilityStatusSuffix = isDraft
    ? hasLocalDraftAudio
      ? ', audio on this device'
      : ', audio not on this device'
    : '';
  const showReviewChip = recording.status === 'completed' && reviewStatus !== null;

  return (
    <Pressable
      onPress={() => {
        if (recording.status === 'draft' && localDraftSlotId) {
          router.push(`/(tabs)/record?draftSlotId=${localDraftSlotId}` as any);
        } else if (recording.id) {
          router.push(`/recordings/${recording.id}` as `/recordings/${string}`);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={`${patientLabel}${clientLabel ? `, client ${clientLabel}` : ''}, ${formattedDate || 'unknown date'}, status ${recording.status}${accessibilityStatusSuffix}`}
      // Nested Pressables (patient-history link, review chip) are unreliable
      // for screen readers inside a parent Pressable — surface them as custom
      // actions on the card instead; the inner controls are hidden from the
      // a11y tree below.
      accessibilityActions={[
        ...(recording.patientId ? [{ name: 'open_patient_history', label: 'Open patient history' }] : []),
        ...(showReviewChip
          ? [{ name: 'toggle_reviewed', label: reviewStatus === 'reviewed' ? 'Mark as needs review' : 'Mark as reviewed' }]
          : []),
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'open_patient_history' && recording.patientId) {
          router.push(`/patient/${recording.patientId}` as `/patient/${string}`);
        } else if (event.nativeEvent.actionName === 'toggle_reviewed' && showReviewChip) {
          reviewMutation.mutate(reviewStatus !== 'reviewed');
        }
      }}
      className={`card mb-2 ${highlighted ? 'border-brand-500 bg-brand-50 dark:bg-surface-sunken' : ''}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.96 : 1 })}
    >
      <View className="flex-row justify-between items-center">
        <View className="flex-1 mr-3">
          <View className="flex-row items-center">
            {recording.patientId ? (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  router.push(`/patient/${recording.patientId}` as `/patient/${string}`);
                }}
                hitSlop={12}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                // Android-only above; VoiceOver needs the iOS equivalent or it
                // still walks the descendant text/control tree.
                accessibilityElementsHidden
                className="shrink"
              >
                <Text
                  className={`text-body-lg font-semibold text-brand-600 ${patientIsUntitled ? 'italic' : ''}`}
                  numberOfLines={1}
                >
                  {patientLabel}
                </Text>
              </Pressable>
            ) : (
              <Text
                className={`text-body-lg font-semibold text-content-primary shrink ${patientIsUntitled ? 'italic text-content-tertiary' : ''}`}
                numberOfLines={1}
              >
                {patientLabel}
              </Text>
            )}
            {clientLabel ? (
              /* Trailing space + paddingRight — Android under-measures Text in
                 flex-row and clips the last glyph of short client names even
                 with ellipsizeMode set; do NOT remove. */
              <Text
                className="text-body-lg text-content-tertiary ml-2 flex-1"
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ paddingRight: 2 }}
              >
                {`· ${clientLabel} `}
              </Text>
            ) : null}
          </View>
          {description ? (
            <Text
              className="text-body-sm text-content-tertiary mt-0.5"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {description}
            </Text>
          ) : null}
          <Text className="text-caption text-content-tertiary mt-1">
            {formattedDate}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <View className="items-end gap-1">
            <StatusBadge status={recording.status} />
            {showAiLabeledChip ? <AiLabeledChip /> : null}
            {showReviewChip ? (
              /* Hidden from the a11y tree like the history link above — the
                 card's toggle_reviewed custom action covers it, and a nested
                 accessible Pressable double-focuses under TalkBack. */
              <View
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
              >
                <ReviewStatusChip
                  status={reviewStatus}
                  loading={reviewMutation.isPending}
                  onPress={(event) => {
                    event.stopPropagation();
                    reviewMutation.mutate(reviewStatus !== 'reviewed');
                  }}
                />
              </View>
            ) : null}
            {isDraft ? <DraftLocationChip isOnDevice={hasLocalDraftAudio} /> : null}
          </View>
          <ChevronRight color={colors.contentTertiary} size={18} />
        </View>
      </View>
    </Pressable>
  );
}, (prev, next) =>
  prev.recording.id === next.recording.id &&
  prev.recording.status === next.recording.status &&
  prev.recording.patientName === next.recording.patientName &&
  prev.recording.clientName === next.recording.clientName &&
  prev.recording.species === next.recording.species &&
  prev.recording.breed === next.recording.breed &&
  prev.recording.createdAt === next.recording.createdAt &&
  // Without these, linking a recording to a patient (metadata confirm updates
  // cached lists in place) never surfaces the patient-history link until a
  // full refetch replaces object identity.
  prev.recording.patientId === next.recording.patientId &&
  prev.recording.pimsPatientId === next.recording.pimsPatientId &&
  getRecordingReviewStatus(prev.recording) === getRecordingReviewStatus(next.recording) &&
  prev.recording.aiExtractedMetadata?.review === next.recording.aiExtractedMetadata?.review &&
  (prev.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) ===
    (next.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) &&
  prev.recording.needsMetadataReview === next.recording.needsMetadataReview &&
  prev.localDraftSlotId === next.localDraftSlotId &&
  prev.highlighted === next.highlighted
);

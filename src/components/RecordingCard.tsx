import React from 'react';
import { Alert, View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
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
import { useThemeColors } from '../hooks/useThemeColors';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface RecordingCardProps {
  recording: Recording;
  localDraftSlotId?: string;
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
      <Icon color={iconColor} size={12} style={{ marginRight: 4 }} />
      <Text className={`text-caption font-semibold ${textClass}`}>
        {label}
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
      <Sparkles color={colors.brand500} size={12} style={{ marginRight: 4 }} />
      <Text className="text-caption font-semibold text-brand-700 dark:text-brand-500">
        {METADATA_REVIEW_COPY.aiLabeled}
      </Text>
    </View>
  );
}

export const RecordingCard = React.memo(function RecordingCard({ recording, localDraftSlotId }: RecordingCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const reviewStatus = getRecordingReviewStatus(recording);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const reviewMutation = useMutation({
    mutationFn: (reviewed: boolean) => recordingsApi.updateReview(recording.id, { reviewed }),
    onSuccess: (updatedRecording) => {
      if (updatedRecording?.id) {
        queryClient.setQueryData(['recording', updatedRecording.id], updatedRecording);
      }
      queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
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

  const parsedDate = new Date(recording.createdAt);
  const formattedDate = isNaN(parsedDate.getTime())
    ? ''
    : parsedDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

  const description = [
    recording.species,
    recording.breed ? `${recording.breed}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');

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
    <AnimatedPressable
      onPress={() => {
        if (recording.status === 'draft' && localDraftSlotId) {
          router.push(`/(tabs)/record?draftSlotId=${localDraftSlotId}` as any);
        } else if (recording.id) {
          router.push(`/recordings/${recording.id}` as `/recordings/${string}`);
        }
      }}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel={`Recording from ${formattedDate || 'unknown date'}, status ${recording.status}${accessibilityStatusSuffix}`}
      className="card mb-2"
      style={animatedStyle}
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
                hitSlop={4}
                accessibilityRole="link"
                accessibilityLabel={`View patient history for ${patientLabel}`}
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
              <ReviewStatusChip
                status={reviewStatus}
                loading={reviewMutation.isPending}
                onPress={(event) => {
                  event.stopPropagation();
                  reviewMutation.mutate(reviewStatus !== 'reviewed');
                }}
              />
            ) : null}
            {isDraft ? <DraftLocationChip isOnDevice={hasLocalDraftAudio} /> : null}
          </View>
          <ChevronRight color={colors.contentTertiary} size={18} />
        </View>
      </View>
    </AnimatedPressable>
  );
}, (prev, next) =>
  prev.recording.id === next.recording.id &&
  prev.recording.status === next.recording.status &&
  prev.recording.patientName === next.recording.patientName &&
  prev.recording.clientName === next.recording.clientName &&
  prev.recording.species === next.recording.species &&
  prev.recording.breed === next.recording.breed &&
  getRecordingReviewStatus(prev.recording) === getRecordingReviewStatus(next.recording) &&
  prev.recording.aiExtractedMetadata?.review === next.recording.aiExtractedMetadata?.review &&
  (prev.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) ===
    (next.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) &&
  prev.recording.needsMetadataReview === next.recording.needsMetadataReview &&
  prev.localDraftSlotId === next.localDraftSlotId
);

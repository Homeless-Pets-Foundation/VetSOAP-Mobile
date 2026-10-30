import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from './ui/Text';
import { useRouter } from 'expo-router';
import { ChevronRight, CloudOff, Smartphone, Sparkles } from 'lucide-react-native';
import { StatusBadge } from './StatusBadge';
import type { Recording } from '../types';
import { DRAFT_LOCATION_COPY, METADATA_REVIEW_COPY, EXPORT_COPY } from '../constants/strings';
import { displayPatientName, isUntitledVisit } from '../lib/recordingDisplay';
import { useThemeColors } from '../hooks/useThemeColors';
import { CLIP_SAFE, clipSafe } from './ui/styles';

interface RecordingCardProps {
  recording: Recording;
  localDraftSlotId?: string;
  /**
   * Set when a saved session (stash) on this device holds this draft's audio.
   * Save for Later deletes the local draft but keeps the server row, so without
   * this the card claimed "Not on this device" and opened a Delete Draft
   * dead end (UX-H3, 2026-10-21).
   */
  inSavedSession?: boolean;
  highlighted?: boolean;
  /**
   * List contexts pass `recording.status === 'completed'`: a green "Completed"
   * badge on every row carries no information when it is the default state.
   * The a11y label keeps `status …` regardless, and the detail header renders
   * its own StatusBadge (home layout reorg, 2026-09-02).
   */
  hideStatusBadge?: boolean;
}

type DraftLocationState = 'on_device' | 'saved_session' | 'not_on_device';

function DraftLocationChip({ location }: { location: DraftLocationState }) {
  const colors = useThemeColors();
  const isOnDevice = location !== 'not_on_device';
  const Icon = isOnDevice ? Smartphone : CloudOff;
  const containerClass = isOnDevice ? 'bg-brand-100 dark:bg-surface-sunken' : 'bg-status-warning';
  const textClass = isOnDevice ? 'text-brand-700 dark:text-brand-500' : 'text-status-warning';
  const iconColor = isOnDevice ? colors.brand500 : colors.statusWarningFg;
  const label =
    location === 'on_device'
      ? DRAFT_LOCATION_COPY.onDevice
      : location === 'saved_session'
        ? DRAFT_LOCATION_COPY.savedSession
        : DRAFT_LOCATION_COPY.notOnDevice;
  const a11yLabel =
    location === 'on_device'
      ? DRAFT_LOCATION_COPY.onDeviceA11y
      : location === 'saved_session'
        ? DRAFT_LOCATION_COPY.savedSessionA11y
        : DRAFT_LOCATION_COPY.notOnDeviceA11y;

  return (
    <View
      className={`px-2 py-0.5 rounded-badge flex-row items-center self-end ${containerClass}`}
      accessibilityRole="text"
      accessibilityLabel={a11yLabel}
    >
      <Icon color={iconColor} size={12} style={{ marginRight: 4, flexShrink: 0 }} />
      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text in self-end flex-rows and clips the last glyph; do NOT remove. */}
      <Text className={`text-caption font-semibold ${textClass}`} style={CLIP_SAFE}>
        {clipSafe(label)}
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
      <Text className="text-caption font-semibold text-brand-700 dark:text-brand-500" style={CLIP_SAFE}>
        {clipSafe(METADATA_REVIEW_COPY.aiLabeled)}
      </Text>
    </View>
  );
}

export const RecordingCard = React.memo(function RecordingCard({
  recording,
  localDraftSlotId,
  inSavedSession = false,
  highlighted = false,
  hideStatusBadge = false,
}: RecordingCardProps) {
  const router = useRouter();
  const colors = useThemeColors();

  // Same timestamp the Recordings list sorts and groups by (`submittedAt` with a
  // `createdAt` fallback). Printing `createdAt` here put "Sep 3, 10:14 AM" on a
  // card sitting under a "Today" header — the section and the row disagreeing
  // about the same recording.
  const formattedDate = React.useMemo(() => {
    const parsedDate = new Date(recording.submittedAt ?? recording.createdAt);
    return isNaN(parsedDate.getTime())
      ? ''
      : parsedDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  }, [recording.submittedAt, recording.createdAt]);

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
  // A resumable local draft wins: it is what a tap opens.
  const draftLocation: DraftLocationState = hasLocalDraftAudio
    ? 'on_device'
    : inSavedSession
      ? 'saved_session'
      : 'not_on_device';
  const accessibilityStatusSuffix = isDraft
    ? draftLocation === 'on_device'
      ? DRAFT_LOCATION_COPY.onDeviceSuffix
      : draftLocation === 'saved_session'
        ? DRAFT_LOCATION_COPY.savedSessionSuffix
        : DRAFT_LOCATION_COPY.notOnDeviceSuffix
    : '';

  return (
    <Pressable
      onPress={() => {
        if (recording.status === 'draft' && localDraftSlotId) {
          router.push(`/(tabs)/record?draftSlotId=${localDraftSlotId}` as any);
        } else if (recording.status === 'draft' && inSavedSession) {
          // Saved Sessions live on the Record tab; the param reveals the list
          // even when the current session has unsaved work.
          router.push('/(tabs)/record?showSavedSessions=1' as any);
        } else if (recording.id) {
          router.push(`/recordings/${recording.id}` as `/recordings/${string}`);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={`${patientLabel}${clientLabel ? `, client ${clientLabel}` : ''}, ${formattedDate || 'unknown date'}, status ${recording.status}${accessibilityStatusSuffix}${recording.status === 'completed' && recording.isExported === true ? `, ${EXPORT_COPY.markedStatus}` : ''}`}
      // A nested Pressable (the patient-history link) is unreliable for screen
      // readers inside a parent Pressable — surface it as a custom action on
      // the card instead; the inner control is hidden from the a11y tree below.
      accessibilityActions={
        recording.patientId ? [{ name: 'open_patient_history', label: 'Open patient history' }] : []
      }
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'open_patient_history' && recording.patientId) {
          router.push(`/patient/${recording.patientId}` as `/patient/${string}`);
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
            {hideStatusBadge ? null : <StatusBadge status={recording.status} />}
            {recording.status === 'completed' && recording.isExported === true ? (
              <Text className="text-caption text-brand-600" numberOfLines={2}>{EXPORT_COPY.markedStatus}</Text>
            ) : null}
            {showAiLabeledChip ? <AiLabeledChip /> : null}
            {isDraft ? <DraftLocationChip location={draftLocation} /> : null}
          </View>
          <ChevronRight color={colors.contentTertiary} size={18} />
        </View>
      </View>
    </Pressable>
  );
}, (prev, next) =>
  prev.recording.id === next.recording.id &&
  prev.recording.status === next.recording.status &&
  prev.recording.isExported === next.recording.isExported &&
  prev.recording.patientName === next.recording.patientName &&
  prev.recording.clientName === next.recording.clientName &&
  prev.recording.species === next.recording.species &&
  prev.recording.breed === next.recording.breed &&
  prev.recording.createdAt === next.recording.createdAt &&
  prev.recording.submittedAt === next.recording.submittedAt &&
  // Without these, linking a recording to a patient (metadata confirm updates
  // cached lists in place) never surfaces the patient-history link until a
  // full refetch replaces object identity.
  prev.recording.patientId === next.recording.patientId &&
  prev.recording.pimsPatientId === next.recording.pimsPatientId &&
  prev.recording.aiExtractedMetadata?.review === next.recording.aiExtractedMetadata?.review &&
  (prev.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) ===
    (next.recording.aiExtractedMetadata?.appliedFields?.length ?? 0) &&
  prev.recording.needsMetadataReview === next.recording.needsMetadataReview &&
  prev.localDraftSlotId === next.localDraftSlotId &&
  prev.inSavedSession === next.inSavedSession &&
  prev.hideStatusBadge === next.hideStatusBadge &&
  prev.highlighted === next.highlighted
);

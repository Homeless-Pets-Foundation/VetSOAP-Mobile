import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import type { OrgAiModels } from '../types';
import { REPROCESS_MODELS_COPY } from '../constants/strings';
import { trackEvent } from '../lib/analytics';
import { FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL, getCurrentModelLabel } from '../lib/aiModels';
import { invalidateRecordingCaches } from '../lib/recordingQueryCache';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SegmentedControl } from './ui/SegmentedControl';
import { useThemeColors } from '../hooks/useThemeColors';

interface ReprocessSheetProps {
  recordingId: string;
  models: OrgAiModels;
  canManage: boolean; // canRecordAppointments(user?.role)
  currentTranscriptionModel?: string | null; // costBreakdown.transcriptionModel
  currentSoapModel?: string | null; // costBreakdown.modelUsed
  recordingForeignLanguage?: boolean; // hides transcription picker, pins 'nova-3' (Connect item 3 edge)
  onReprocessStarted?: () => void; // parent resets pollingStartedAtRef
}

// Inline-expandable Card (mirrors ExportSheet.tsx) — NOT a modal (house pattern, no sheet lib).
export function ReprocessSheet({
  recordingId,
  models,
  canManage,
  currentTranscriptionModel,
  currentSoapModel,
  recordingForeignLanguage,
  onReprocessStarted,
}: ReprocessSheetProps) {
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  // Defaults = org defaults (not the current* display-only props). Foreign-language recordings pin
  // transcription to 'nova-3' (backend runs Deepgram language='multi', which rejects nova-3-medical).
  const [transcriptionModelId, setTranscriptionModelId] = useState<string | null>(
    recordingForeignLanguage ? FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL : models.transcription.default
  );
  const [soapModel, setSoapModel] = useState<string | null>(models.soap.default);

  const mutation = useMutation({
    // `?? undefined`: state is `string | null` (AiModelCategory.default); reprocessRecording takes
    // `string | undefined`. The call-site visible-choice gate guarantees non-null at runtime — this
    // only satisfies the typechecker.
    mutationFn: () =>
      recordingsApi.reprocessRecording(recordingId, {
        transcriptionModelId: transcriptionModelId ?? undefined,
        soapModel: soapModel ?? undefined,
      }),
    onSuccess: async (updated) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Clear caches tied to the OLD run before the status flip disables active observers.
      try {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: ['soapNote', recordingId], exact: true }),
          queryClient.cancelQueries({ queryKey: ['recordingTasks', recordingId], exact: true }),
        ]);
      } catch {
        // Best-effort cache cleanup; the recording status update below must still proceed.
      }
      queryClient.setQueryData(['soapNote', recordingId], null);
      queryClient.setQueryData(['recordingTasks', recordingId], null);
      queryClient.invalidateQueries({
        queryKey: ['soapNote', recordingId],
        exact: true,
        refetchType: 'none',
      }).catch(() => {});
      queryClient.invalidateQueries({
        queryKey: ['recordingTasks', recordingId],
        exact: true,
        refetchType: 'none',
      }).catch(() => {});
      // Seed the non-terminal status so the poller starts immediately (no refetch race).
      queryClient.setQueryData(['recording', recordingId], updated);
      // Restart the detail screen's 30-min poll watchdog (pollingStartedAtRef lives in the parent).
      onReprocessStarted?.();
      queryClient.invalidateQueries({ queryKey: ['recording', recordingId] }).catch(() => {});
      invalidateRecordingCaches(queryClient, 'soap_regenerated');
      setExpanded(false);
      trackEvent({
        name: 'recording_reprocessed',
        props: {
          recording_id: recordingId,
          transcription_model: transcriptionModelId ?? '',
          soap_model: soapModel ?? '',
          transcription_model_changed:
            !!currentTranscriptionModel && currentTranscriptionModel !== transcriptionModelId,
          soap_model_changed: !!currentSoapModel && currentSoapModel !== soapModel,
        },
      });
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') return;
      Alert.alert(
        REPROCESS_MODELS_COPY.sheetTitle,
        error instanceof ApiError ? error.message : REPROCESS_MODELS_COPY.failure
      );
    },
  });

  if (!canManage) return null;

  const showTranscriptionPicker =
    !recordingForeignLanguage && models.transcription.options.length > 1;
  const showSoapPicker = models.soap.options.length > 1;
  const currentTranscriptionLabel = getCurrentModelLabel(
    currentTranscriptionModel,
    models.transcription
  );
  const currentSoapLabel = getCurrentModelLabel(currentSoapModel, models.soap);

  if (!expanded) {
    return (
      <Card className="mx-5 mb-4">
        <Button
          variant="secondary"
          size="sm"
          onPress={() => setExpanded(true)}
          icon={<RefreshCw color={colors.contentBody} size={14} />}
        >
          {REPROCESS_MODELS_COPY.entryButton}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="mx-5 mb-4">
      <Text className="text-body-lg font-semibold text-content-primary mb-1">
        {REPROCESS_MODELS_COPY.sheetTitle}
      </Text>
      <Text className="text-body-sm text-content-tertiary mb-3" numberOfLines={3}>
        {REPROCESS_MODELS_COPY.sheetBody}
      </Text>

      {showTranscriptionPicker && (
        <View className="mb-3">
          <SegmentedControl
            label={REPROCESS_MODELS_COPY.transcriptionLabel}
            options={models.transcription.options.map((o) => ({ label: o.label, value: o.id }))}
            value={transcriptionModelId}
            onValueChange={(v) => setTranscriptionModelId(v)}
          />
          {!!currentTranscriptionLabel && (
            <Text className="text-caption text-content-tertiary mt-1" numberOfLines={1}>
              {REPROCESS_MODELS_COPY.currentPrefix}
              {currentTranscriptionLabel}
            </Text>
          )}
        </View>
      )}

      {showSoapPicker && (
        <View className="mb-3">
          <SegmentedControl
            label={REPROCESS_MODELS_COPY.soapLabel}
            scrollable // 4 long provider labels wrap/truncate on narrow Android otherwise
            options={models.soap.options.map((o) => ({ label: o.label, value: o.id }))}
            value={soapModel}
            onValueChange={(v) => setSoapModel(v)}
          />
          {!!currentSoapLabel && (
            <Text className="text-caption text-content-tertiary mt-1" numberOfLines={1}>
              {REPROCESS_MODELS_COPY.currentPrefix}
              {currentSoapLabel}
            </Text>
          )}
        </View>
      )}

      <View className="flex-row gap-2 mt-1">
        <Button
          variant="primary"
          size="sm"
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onPress={() => {
            Alert.alert(REPROCESS_MODELS_COPY.confirmTitle, REPROCESS_MODELS_COPY.confirmBody, [
              { text: REPROCESS_MODELS_COPY.cancel, style: 'cancel' },
              { text: REPROCESS_MODELS_COPY.confirm.trim(), onPress: () => mutation.mutate() },
            ]);
          }}
        >
          {REPROCESS_MODELS_COPY.confirm}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={mutation.isPending}
          onPress={() => setExpanded(false)}
        >
          {REPROCESS_MODELS_COPY.cancel}
        </Button>
      </View>
    </Card>
  );
}

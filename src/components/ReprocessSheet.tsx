import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from './ui/Text';
import { RefreshCw } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import type { OrgAiModels } from '../types';
import { REPROCESS_MODELS_COPY } from '../constants/strings';
import { trackEvent } from '../lib/analytics';
import {
  getCurrentModelLabel, getEffectiveReprocessModels, getInitialReprocessSelection,
  reconcileReprocessSelection, isReprocessSelectionValid, normalizeForForeignLanguage,
  type RecordingFailureRemedyCategory, type ReprocessSelection,
} from '../lib/aiModels';
import { friendlyErrorMessage } from '../lib/errorCopy';
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
  recordingForeignLanguage?: boolean;
  remedyCategory?: RecordingFailureRemedyCategory | null;
  remedyErrorCode?: string | null;
  onReprocessStarted?: () => void; // parent resets pollingStartedAtRef
  /** Open straight into the pickers (the detail Tools row already asked). */
  defaultExpanded?: boolean;
  /** Fires whenever the sheet closes itself (success or Cancel) so a parent can deselect its chip. */
  onDismiss?: () => void;
}

// Inline-expandable Card (mirrors ExportSheet.tsx) — NOT a modal (house pattern, no sheet lib).
export function ReprocessSheet({
  recordingId,
  models,
  canManage,
  currentTranscriptionModel,
  currentSoapModel,
  recordingForeignLanguage,
  remedyCategory,
  remedyErrorCode,
  onReprocessStarted,
  defaultExpanded,
  onDismiss,
}: ReprocessSheetProps) {
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  const selectionOptions = useMemo(() => ({ recordingForeignLanguage, remedyCategory, remedyErrorCode, currentTranscriptionModel, currentSoapModel }),
    [recordingForeignLanguage, remedyCategory, remedyErrorCode, currentTranscriptionModel, currentSoapModel]);
  const effectiveModels = useMemo(() => getEffectiveReprocessModels(models, recordingForeignLanguage),
    [models, recordingForeignLanguage]);
  const [selection, setSelection] = useState(() => getInitialReprocessSelection(models, selectionOptions));
  const resolvedSelection = reconcileReprocessSelection(models, selection, selectionOptions);
  const { transcriptionModelId, soapModel } = resolvedSelection;
  useEffect(() => {
    setSelection((previous) => reconcileReprocessSelection(models, previous, selectionOptions));
  }, [models, selectionOptions]);
  const selectionValid = isReprocessSelectionValid(effectiveModels, resolvedSelection);
  // Alert callbacks may outlive an options refresh. Recheck the latest membership at submission.
  const latest = useRef({ effectiveModels, resolvedSelection, canManage, recordingForeignLanguage });
  latest.current = { effectiveModels, resolvedSelection, canManage, recordingForeignLanguage };

  const mutation = useMutation({
    mutationFn: (submitted: ReprocessSelection) => {
      const current = latest.current;
      if (!current.canManage || !isReprocessSelectionValid(current.effectiveModels, submitted) ||
          normalizeForForeignLanguage(submitted.transcriptionModelId, current.recordingForeignLanguage) !== submitted.transcriptionModelId) {
        return Promise.reject(new ApiError(REPROCESS_MODELS_COPY.invalidModel, 400, false, undefined, 'INVALID_MODEL'));
      }
      return recordingsApi.reprocessRecording(recordingId, {
        transcriptionModelId: submitted.transcriptionModelId ?? undefined,
        soapModel: submitted.soapModel ?? undefined,
      });
    },
    onSuccess: async (updated, submitted) => {
      const { transcriptionModelId, soapModel } = submitted;
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
      onDismiss?.();
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
        error instanceof ApiError && error.code === 'INVALID_MODEL'
          ? REPROCESS_MODELS_COPY.invalidModel : friendlyErrorMessage(error)
      );
    },
  });

  if (!canManage) return null;

  const showTranscriptionPicker =
    effectiveModels.transcription.options.length > 1;
  const showSoapPicker = effectiveModels.soap.options.length > 1;
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
      <Text className="text-body-sm text-content-tertiary mb-3">
        {REPROCESS_MODELS_COPY.sheetBody}
      </Text>

      {recordingForeignLanguage && (
        <Text className="text-body-sm text-content-tertiary mb-3">
          {REPROCESS_MODELS_COPY.foreignLanguage}
        </Text>
      )}

      {(showTranscriptionPicker || remedyCategory === 'transcription') && (
        <View className="mb-3">
          <SegmentedControl
            label={REPROCESS_MODELS_COPY.transcriptionLabel}
            scrollable
            options={effectiveModels.transcription.options.map((o) => ({ label: o.label, value: o.id }))}
            value={transcriptionModelId}
            onValueChange={(v) => setSelection({ ...resolvedSelection, transcriptionModelId: normalizeForForeignLanguage(v, recordingForeignLanguage) })}
          />
          <Text className="text-caption text-content-body mt-1">
            {REPROCESS_MODELS_COPY.selectedPrefix}
            {getCurrentModelLabel(transcriptionModelId, effectiveModels.transcription)}
          </Text>
          {!!currentTranscriptionLabel && (
            <Text className="text-caption text-content-tertiary mt-1" numberOfLines={1}>
              {REPROCESS_MODELS_COPY.currentPrefix}
              {currentTranscriptionLabel}
            </Text>
          )}
        </View>
      )}

      {(showSoapPicker || remedyCategory === 'soap') && (
        <View className="mb-3">
          <SegmentedControl
            label={REPROCESS_MODELS_COPY.soapLabel}
            scrollable // 4 long provider labels wrap/truncate on narrow Android otherwise
            options={effectiveModels.soap.options.map((o) => ({ label: o.label, value: o.id }))}
            value={soapModel}
            onValueChange={(v) => setSelection({ ...resolvedSelection, soapModel: v })}
          />
          <Text className="text-caption text-content-body mt-1">
            {REPROCESS_MODELS_COPY.selectedPrefix}
            {getCurrentModelLabel(soapModel, effectiveModels.soap)}
          </Text>
          {!!currentSoapLabel && (
            <Text className="text-caption text-content-tertiary mt-1" numberOfLines={1}>
              {REPROCESS_MODELS_COPY.currentPrefix}
              {currentSoapLabel}
            </Text>
          )}
        </View>
      )}

      <View className="flex-row flex-wrap gap-2 mt-1">
        <Button
          variant="primary"
          size="sm"
          loading={mutation.isPending}
          disabled={mutation.isPending || !selectionValid}
          onPress={() => {
            if (!selectionValid) return;
            Alert.alert(REPROCESS_MODELS_COPY.confirmTitle, REPROCESS_MODELS_COPY.confirmBody, [
              { text: REPROCESS_MODELS_COPY.cancel, style: 'cancel' },
              { text: REPROCESS_MODELS_COPY.confirm, onPress: () => mutation.mutate(latest.current.resolvedSelection) },
            ]);
          }}
        >
          {REPROCESS_MODELS_COPY.confirm}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={mutation.isPending}
          onPress={() => {
            setExpanded(false);
            onDismiss?.();
          }}
        >
          {REPROCESS_MODELS_COPY.cancel}
        </Button>
      </View>
    </Card>
  );
}

import React, { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { CheckCircle, Copy, FileText, Share2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { soapNotesApi, type ExportTarget } from '../api/soapNotes';
import type { Recording, SoapNote } from '../types';
import { EXPORT_COPY } from '../constants/strings';
import { trackEvent } from '../lib/analytics';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { buildSoapHtml, buildSoapPlainText } from '../lib/soapPdf';
import { sharePdfHtml, shareText } from '../lib/share';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { useThemeColors } from '../hooks/useThemeColors';

const PIMS_TARGETS: { label: string; value: ExportTarget }[] = [
  { label: 'ezyVet', value: 'ezyvet' },
  { label: 'Cornerstone', value: 'cornerstone' },
  { label: 'AVImark', value: 'avimark' },
  { label: 'Impromed', value: 'impromed' },
  { label: 'VetMatrix', value: 'vetmatrix' },
];

export function ExportSheet({
  soapNote,
  recording,
}: {
  soapNote: SoapNote;
  recording: Recording;
}) {
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showPims, setShowPims] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const plainText = useMemo(() => buildSoapPlainText(soapNote), [soapNote]);

  const copyAll = useCallback(async () => {
    setBusyAction('copy');
    setStatus(null);
    try {
      await copyWithAutoClear(plainText);
      trackEvent({ name: 'soap_exported', props: { target: 'clipboard', recording_id: recording.id } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStatus(EXPORT_COPY.copied);
    } finally {
      setBusyAction(null);
    }
  }, [plainText, recording.id]);

  const shareAsText = useCallback(async () => {
    setBusyAction('text');
    setStatus(null);
    try {
      const shared = await shareText(plainText, 'SOAP Note');
      if (shared) {
        trackEvent({ name: 'soap_exported', props: { target: 'share_sheet', recording_id: recording.id } });
        setStatus(EXPORT_COPY.shared);
      }
    } finally {
      setBusyAction(null);
    }
  }, [plainText, recording.id]);

  const shareAsPdf = useCallback(async () => {
    setBusyAction('pdf');
    setStatus(null);
    try {
      await sharePdfHtml(buildSoapHtml(soapNote, recording), 'SOAP Note');
      trackEvent({ name: 'soap_exported', props: { target: 'pdf', recording_id: recording.id } });
      setStatus(EXPORT_COPY.shared);
    } finally {
      setBusyAction(null);
    }
  }, [soapNote, recording]);

  const markExported = useCallback(async (target: ExportTarget) => {
    setBusyAction(target);
    setStatus(null);
    try {
      await soapNotesApi.export(soapNote.id, { exportedTo: target });
      trackEvent({ name: 'soap_exported', props: { target: 'pims', recording_id: recording.id } });
      queryClient.invalidateQueries({ queryKey: ['soapNote', recording.id] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] }).catch(() => {});
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setStatus(EXPORT_COPY.marked);
    } finally {
      setBusyAction(null);
    }
  }, [queryClient, recording.id, soapNote.id]);

  return (
    <Card className="mb-4">
      <View className="flex-row items-center justify-between mb-3">
        <Text className="text-body-lg font-semibold text-content-primary">{EXPORT_COPY.title}</Text>
        {soapNote.isExported && (
          <View className="flex-row items-center rounded-full bg-brand-50 dark:bg-surface-sunken px-2 py-1">
            <CheckCircle color={colors.brand500} size={13} />
            <Text className="text-caption text-brand-700 dark:text-brand-500 ml-1">Exported</Text>
          </View>
        )}
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={busyAction === 'copy'}
          onPress={() => { copyAll().catch((error) => setStatus(error instanceof Error ? error.message : EXPORT_COPY.copyFailed)); }}
          icon={<Copy color={colors.contentBody} size={14} />}
        >
          {EXPORT_COPY.copyAll}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={busyAction === 'text'}
          onPress={() => { shareAsText().catch((error) => setStatus(error instanceof Error ? error.message : EXPORT_COPY.shareFailed)); }}
          icon={<Share2 color={colors.contentBody} size={14} />}
        >
          {EXPORT_COPY.shareText}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={busyAction === 'pdf'}
          onPress={() => { shareAsPdf().catch((error) => setStatus(error instanceof Error ? error.message : EXPORT_COPY.pdfFailed)); }}
          icon={<FileText color={colors.contentBody} size={14} />}
        >
          {EXPORT_COPY.sharePdf}
        </Button>
      </View>

      <View className="mt-3">
        <Button variant="ghost" size="sm" onPress={() => setShowPims((value) => !value)}>
          {EXPORT_COPY.markPims}
        </Button>
        {showPims && (
          <View className="flex-row flex-wrap gap-2 mt-2">
            {PIMS_TARGETS.map((target) => (
              <Button
                key={target.value}
                variant="secondary"
                size="sm"
                loading={busyAction === target.value}
                onPress={() => { markExported(target.value).catch((error) => setStatus(error instanceof Error ? error.message : EXPORT_COPY.markFailed)); }}
              >
                {target.label}
              </Button>
            ))}
          </View>
        )}
      </View>

      {status && <Text className="text-caption text-content-tertiary mt-2">{status}</Text>}
    </Card>
  );
}

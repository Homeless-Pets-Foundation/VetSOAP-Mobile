import React, { useCallback, useState } from 'react';
import { Linking, Share, Text, View } from 'react-native';
import { Copy, Mail, RefreshCw, Share2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { recordingsApi, type EmailDraftResult } from '../api/recordings';
import { ApiError } from '../api/client';
import { trackEvent } from '../lib/analytics';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { CLIENT_EMAIL_COPY } from '../constants/strings';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { useThemeColors } from '../hooks/useThemeColors';

const MAILTO_BODY_LIMIT = 1800;

function mailtoUrl(subject: string, body?: string): string {
  const params = [`subject=${encodeURIComponent(subject)}`];
  if (body !== undefined) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:?${params.join('&')}`;
}

function emailDraftErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : CLIENT_EMAIL_COPY.failed;
}

export function ClientEmailCard({ recordingId }: { recordingId: string }) {
  const colors = useThemeColors();
  const [draft, setDraft] = useState<EmailDraftResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const nextDraft = await recordingsApi.generateEmailDraft(recordingId, { mode: 'visit_summary' });
      setDraft(nextDraft);
      trackEvent({ name: 'email_draft_generated', props: { recording_id: recordingId } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      setStatus(emailDraftErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  const copyDraft = useCallback(async () => {
    if (!draft) return;
    try {
      await copyWithAutoClear(`${draft.subject ?? ''}\n\n${draft.body ?? ''}`);
      setStatus(CLIENT_EMAIL_COPY.copied);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      setStatus(CLIENT_EMAIL_COPY.copyFailed);
    }
  }, [draft]);

  const openMail = useCallback(async () => {
    if (!draft) return;
    const subject = draft.subject || 'Visit summary';
    const body = draft.body || '';

    try {
      if (body.length > MAILTO_BODY_LIMIT) {
        await copyWithAutoClear(body);
        await Linking.openURL(mailtoUrl(subject));
      } else {
        await Linking.openURL(mailtoUrl(subject, body));
      }
      trackEvent({ name: 'soap_exported', props: { target: 'email', recording_id: recordingId } });
      setStatus(body.length > MAILTO_BODY_LIMIT ? CLIENT_EMAIL_COPY.fallbackCopied : null);
    } catch {
      try {
        await copyWithAutoClear(body || subject);
        await Linking.openURL(mailtoUrl(subject));
        trackEvent({ name: 'soap_exported', props: { target: 'email', recording_id: recordingId } });
        setStatus(body ? CLIENT_EMAIL_COPY.bodyCopied : CLIENT_EMAIL_COPY.fallbackCopied);
      } catch {
        await copyWithAutoClear(body ? `${subject}\n\n${body}` : subject).catch(() => {});
        setStatus(CLIENT_EMAIL_COPY.fallbackCopied);
      }
    }
  }, [draft, recordingId]);

  const shareDraft = useCallback(async () => {
    if (!draft) return;
    try {
      const subject = draft.subject ?? '';
      const body = draft.body ?? '';
      const result = await Share.share({
        title: subject,
        message: `${subject}\n\n${body}`,
      });
      if (result.action === Share.sharedAction) {
        trackEvent({ name: 'soap_exported', props: { target: 'email', recording_id: recordingId } });
      }
    } catch {
      setStatus(CLIENT_EMAIL_COPY.shareFailed);
    }
  }, [draft, recordingId]);

  return (
    <Card className="mx-5 mb-4">
      <View className="flex-row items-start justify-between mb-3">
        <View className="flex-1 pr-3">
          <Text className="text-body-lg font-semibold text-content-primary">{CLIENT_EMAIL_COPY.title}</Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">{CLIENT_EMAIL_COPY.body}</Text>
        </View>
        <Button
          variant="secondary"
          size="sm"
          loading={loading}
          onPress={() => { generate().catch(() => {}); }}
          icon={draft ? <RefreshCw color={colors.contentBody} size={14} /> : <Mail color={colors.contentBody} size={14} />}
        >
          {draft ? CLIENT_EMAIL_COPY.regenerate : CLIENT_EMAIL_COPY.generate}
        </Button>
      </View>

      {draft && (
        <View className="border border-border-default rounded-input p-3 bg-surface">
          <Text className="text-body font-semibold text-content-primary mb-2">{draft.subject}</Text>
          <Text className="text-body-sm text-content-body" numberOfLines={8}>
            {draft.body}
          </Text>
          <View className="flex-row flex-wrap gap-2 mt-3">
            <Button
              variant="secondary"
              size="sm"
              onPress={() => { copyDraft().catch(() => {}); }}
              icon={<Copy color={colors.contentBody} size={14} />}
            >
              {CLIENT_EMAIL_COPY.copy}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onPress={() => { openMail().catch(() => {}); }}
              icon={<Mail color={colors.contentOnBrand} size={14} />}
            >
              {CLIENT_EMAIL_COPY.openMail}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => { shareDraft().catch(() => {}); }}
              icon={<Share2 color={colors.contentBody} size={14} />}
            >
              {CLIENT_EMAIL_COPY.share}
            </Button>
          </View>
        </View>
      )}

      {status && <Text className="text-caption text-content-tertiary mt-2">{status}</Text>}
    </Card>
  );
}

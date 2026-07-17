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
import { Toast } from './Toast';
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
  // Success feedback = transient toast (audit theme D); errors stay inline.
  const [toast, setToast] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setErrorStatus(null);
    try {
      const nextDraft = await recordingsApi.generateEmailDraft(recordingId, { mode: 'visit_summary' });
      setDraft(nextDraft);
      trackEvent({ name: 'email_draft_generated', props: { recording_id: recordingId } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      setErrorStatus(emailDraftErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  const copyDraft = useCallback(async () => {
    if (!draft) return;
    // Clear a prior action failure so a successful retry doesn't show the
    // success toast and a stale "copy failed" side by side (Codex P2, PR #143).
    setErrorStatus(null);
    try {
      await copyWithAutoClear(`${draft.subject ?? ''}\n\n${draft.body ?? ''}`);
      setToast(CLIENT_EMAIL_COPY.copied);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      setErrorStatus(CLIENT_EMAIL_COPY.copyFailed);
    }
  }, [draft]);

  const openMail = useCallback(async () => {
    if (!draft) return;
    setErrorStatus(null);
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
      if (body.length > MAILTO_BODY_LIMIT) setToast(CLIENT_EMAIL_COPY.fallbackCopied);
    } catch {
      try {
        await copyWithAutoClear(body || subject);
        await Linking.openURL(mailtoUrl(subject));
        trackEvent({ name: 'soap_exported', props: { target: 'email', recording_id: recordingId } });
        setToast(body ? CLIENT_EMAIL_COPY.bodyCopied : CLIENT_EMAIL_COPY.fallbackCopied);
      } catch {
        await copyWithAutoClear(body ? `${subject}\n\n${body}` : subject).catch(() => {});
        setToast(CLIENT_EMAIL_COPY.fallbackCopied);
      }
    }
  }, [draft, recordingId]);

  const shareDraft = useCallback(async () => {
    if (!draft) return;
    setErrorStatus(null);
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
      setErrorStatus(CLIENT_EMAIL_COPY.shareFailed);
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
          <Text className="text-body-sm text-content-body" numberOfLines={previewExpanded ? undefined : 8}>
            {draft.body}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setPreviewExpanded((value) => !value)}
            accessibilityLabel={previewExpanded ? 'Collapse email preview' : 'Show the full email'}
          >
            {previewExpanded ? 'Show less' : 'Show more'}
          </Button>
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

      {errorStatus && (
        <Text className="text-caption text-status-danger mt-2" accessibilityRole="alert">
          {errorStatus}
        </Text>
      )}
      <Toast message={toast ?? ''} visible={!!toast} onHide={() => setToast(null)} placement="inline" />
    </Card>
  );
}

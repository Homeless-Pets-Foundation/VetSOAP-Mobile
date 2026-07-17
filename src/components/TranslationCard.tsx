import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { Copy, Languages } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { recordingsApi, type TranslateResult } from '../api/recordings';
import { ApiError } from '../api/client';
import { TRANSLATION_COPY } from '../constants/strings';
import { trackEvent, type TranslationTargetLanguage } from '../lib/analytics';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { toPlainText } from '../lib/markdown';
import { MarkdownText } from './MarkdownText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Toast } from './Toast';
import { SegmentedControl } from './ui/SegmentedControl';
import { Select } from './ui/Select';
import { useThemeColors } from '../hooks/useThemeColors';

const TRANSLATION_LANGUAGE_OPTIONS = [
  { label: 'Spanish', value: 'es' },
  { label: 'French', value: 'fr' },
  { label: 'Brazilian Portuguese', value: 'pt-BR' },
  { label: 'European Portuguese', value: 'pt-PT' },
  { label: 'German', value: 'de' },
  { label: 'Japanese', value: 'ja' },
  { label: 'Korean', value: 'ko' },
  { label: 'Chinese (Simplified)', value: 'zh' },
  { label: 'Chinese (Traditional)', value: 'zh-TW' },
  { label: 'Vietnamese', value: 'vi' },
  { label: 'Arabic', value: 'ar' },
  { label: 'Russian', value: 'ru' },
  { label: 'Italian', value: 'it' },
  { label: 'Dutch', value: 'nl' },
  { label: 'Thai', value: 'th' },
  { label: 'Tagalog', value: 'tl' },
  { label: 'Hindi', value: 'hi' },
] as const;

type TranslationLanguageCode = (typeof TRANSLATION_LANGUAGE_OPTIONS)[number]['value'];
type QuickTranslationLanguageCode = 'es' | 'fr' | 'pt-BR';

const QUICK_LANGUAGE_OPTIONS = [
  { label: 'Spanish', value: 'es' },
  { label: 'French', value: 'fr' },
  { label: 'Portuguese', value: 'pt-BR' },
] as const;

function isQuickLanguage(value: TranslationLanguageCode): value is QuickTranslationLanguageCode {
  return value === 'es' || value === 'fr' || value === 'pt-BR';
}

function analyticsLanguage(value: TranslationLanguageCode): TranslationTargetLanguage {
  if (value === 'es') return 'Spanish';
  if (value === 'fr') return 'French';
  if (value === 'pt-BR') return 'Portuguese';
  return 'custom';
}

function translationErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : TRANSLATION_COPY.failed;
}

const SECTIONS = [
  ['subjective', 'Subjective'],
  ['objective', 'Objective'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
] as const;

export function TranslationCard({ recordingId }: { recordingId: string }) {
  const colors = useThemeColors();
  const [languageValue, setLanguageValue] = useState<TranslationLanguageCode>('es');
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Success feedback = transient toast (audit theme D); errors stay inline.
  const [toast, setToast] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const quickLanguageValue = isQuickLanguage(languageValue) ? languageValue : null;

  const translate = useCallback(async () => {
    setLoading(true);
    setErrorStatus(null);
    try {
      const translated = await recordingsApi.translate(recordingId, { targetLanguage: languageValue });
      setResult(translated);
      trackEvent({
        name: 'soap_translated',
        props: { recording_id: recordingId, target_language: analyticsLanguage(languageValue) },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      setErrorStatus(translationErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [languageValue, recordingId]);

  const copySection = useCallback(async (label: string, text: string) => {
    // Clear a prior action failure so a successful retry doesn't show the
    // success toast and a stale "copy failed" side by side (Codex P2, PR #143).
    setErrorStatus(null);
    try {
      await copyWithAutoClear(`${label}:\n${toPlainText(text)}`);
      setToast(TRANSLATION_COPY.copied);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      setErrorStatus(TRANSLATION_COPY.copyFailed);
    }
  }, []);

  return (
    <Card className="mx-5 mb-4">
      <View className="flex-row items-start justify-between mb-3">
        <View className="flex-1 pr-3">
          <Text className="text-body-lg font-semibold text-content-primary">{TRANSLATION_COPY.title}</Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">{TRANSLATION_COPY.body}</Text>
        </View>
        <Button
          variant="primary"
          size="sm"
          loading={loading}
          onPress={() => { translate().catch(() => {}); }}
          icon={<Languages color={colors.contentOnBrand} size={14} />}
        >
          {TRANSLATION_COPY.translate}
        </Button>
      </View>

      <SegmentedControl
        options={QUICK_LANGUAGE_OPTIONS}
        value={quickLanguageValue}
        onValueChange={(value) => {
          if (value) setLanguageValue(value);
        }}
        columns={3}
        accessibilityLabel="Quick translation language"
      />

      <Select
        className="mt-1"
        label={TRANSLATION_COPY.languagePicker}
        options={TRANSLATION_LANGUAGE_OPTIONS}
        value={languageValue}
        onValueChange={setLanguageValue}
        sheetTitle={TRANSLATION_COPY.languagePicker}
        accessibilityLabel={TRANSLATION_COPY.languagePicker}
      />

      {result && (
        <View className="mt-3 border border-border-default rounded-input overflow-hidden">
          {SECTIONS.map(([key, label]) => (
            <View key={key} className="p-3 border-b border-border-default last:border-b-0">
              <View className="flex-row items-center justify-between mb-1">
                <Text className="text-body-sm font-semibold text-content-primary">{label}</Text>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => { copySection(label, result[key]).catch(() => {}); }}
                  icon={<Copy color={colors.contentBody} size={13} />}
                >
                  {TRANSLATION_COPY.copy}
                </Button>
              </View>
              <MarkdownText text={result[key] ?? ''} />
            </View>
          ))}
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

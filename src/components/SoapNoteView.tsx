import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, Pressable, TextInput } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { Copy, Pencil, Save, X, MessageCircle, Stethoscope, ClipboardList, ListChecks, type LucideIcon } from 'lucide-react-native';
import { MarkdownText, toPlainText } from './MarkdownText';
import type { SoapNote } from '../types';
import { SOAP_SECTION_ACTIONS } from '../constants/strings';
import { trackEvent } from '../lib/analytics';
import { soapNotesApi, type SoapNoteSection } from '../api/soapNotes';
import { Button } from './ui/Button';
import { useThemeColors } from '../hooks/useThemeColors';

type SoapAccent = 'subjective' | 'objective' | 'assessment' | 'plan';

const SECTIONS: { key: SoapAccent; label: string; accent: SoapAccent; Icon: LucideIcon }[] = [
  { key: 'subjective', label: 'Subjective', accent: 'subjective', Icon: MessageCircle },
  { key: 'objective', label: 'Objective', accent: 'objective', Icon: Stethoscope },
  { key: 'assessment', label: 'Assessment', accent: 'assessment', Icon: ClipboardList },
  { key: 'plan', label: 'Plan', accent: 'plan', Icon: ListChecks },
];

// Per-section accent styling. Left border + faint bg tint reuse the soap-*
// tokens (alpha via NativeWind), so dark mode + the color guard stay happy.
const ACCENT_BORDER: Record<SoapAccent, string> = {
  subjective: 'border-l-soap-subjective',
  objective: 'border-l-soap-objective',
  assessment: 'border-l-soap-assessment',
  plan: 'border-l-soap-plan',
};
const ACCENT_TINT: Record<SoapAccent, string> = {
  subjective: 'bg-soap-subjective/5',
  objective: 'bg-soap-objective/5',
  assessment: 'bg-soap-assessment/5',
  plan: 'bg-soap-plan/5',
};

interface SoapNoteViewProps {
  soapNote: SoapNote;
  recordingId?: string;
  canEdit?: boolean;
}

function formatEditedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function CopiedToast() {
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      className="absolute top-0 right-0 bg-toast-bg px-3 py-1.5 rounded-btn z-10"
    >
      <Text className="text-caption text-toast-fg font-medium">{SOAP_SECTION_ACTIONS.copied}</Text>
    </Animated.View>
  );
}

function AccordionSection({
  sectionKey,
  label,
  accent,
  Icon,
  content,
  isEdited,
  editedAt,
  isExpanded,
  onToggle,
  recordingId,
  soapNoteId,
  canEdit,
}: {
  sectionKey: SoapNoteSection;
  label: string;
  accent: SoapAccent;
  Icon: LucideIcon;
  content: string;
  isEdited: boolean;
  editedAt: string | null;
  isExpanded: boolean;
  onToggle: () => void;
  recordingId?: string;
  soapNoteId: string;
  canEdit: boolean;
}) {
  const colors = useThemeColors();
  const [showCopied, setShowCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rotation = useSharedValue(isExpanded ? 1 : 0);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (!isEditing) setDraft(content ?? '');
  }, [content, isEditing]);

  React.useEffect(() => {
    rotation.value = withTiming(isExpanded ? 1 : 0, { duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rotation is a stable Reanimated SharedValue ref
  }, [isExpanded]);

  React.useEffect(() => {
    return () => clearTimeout(copyTimeoutRef.current);
  }, []);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 90}deg` }],
  }));

  const copySection = async () => {
    try {
      await copyWithAutoClear(toPlainText(content ?? ''));
      if (recordingId) {
        trackEvent({ name: 'soap_exported', props: { target: 'clipboard', recording_id: recordingId } });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopied(true);
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[SoapNote] copySection failed:', error);
    }
  };

  const saveSection = async () => {
    if (!recordingId) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await soapNotesApi.update(soapNoteId, { [sectionKey]: draft });
      queryClient.invalidateQueries({ queryKey: ['soapNote', recordingId] }).catch(() => {});
      trackEvent({ name: 'soap_section_edited', props: { recording_id: recordingId, section: sectionKey } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setIsEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save this section.');
    } finally {
      setIsSaving(false);
    }
  };

  const editedLabel = formatEditedAt(editedAt);
  const accentColor = {
    subjective: colors.soapSubjective,
    objective: colors.soapObjective,
    assessment: colors.soapAssessment,
    plan: colors.soapPlan,
  }[accent];

  return (
    <View className={`border border-border-default border-l-4 ${ACCENT_BORDER[accent]} rounded-input mb-3 overflow-hidden`}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        accessibilityLabel={`${label} section`}
        className={`flex-row justify-between items-center p-3 ${ACCENT_TINT[accent]}`}
      >
        <View className="flex-row items-center flex-1 pr-2">
          <Icon color={accentColor} size={16} style={{ marginRight: 8 }} />
          <Text className="text-body font-semibold text-content-primary">{label}</Text>
          {isEdited && editedLabel && (
            <View className="ml-2 rounded-full bg-surface-sunken px-2 py-0.5">
              <Text className="text-caption text-content-tertiary">Edited {editedLabel}</Text>
            </View>
          )}
        </View>
        <Animated.Text
          className="text-heading text-content-tertiary"
          style={indicatorStyle}
        >
          ›
        </Animated.Text>
      </Pressable>

      {isExpanded && (
        <Animated.View
          entering={FadeIn.duration(200)}
          className="p-3 pt-0 relative"
        >
          {showCopied && <CopiedToast />}
          {isEditing ? (
            <View className="mt-2">
              <TextInput
                value={draft}
                onChangeText={setDraft}
                multiline
                textAlignVertical="top"
                className="input-base min-h-[180px] text-body text-content-primary"
                placeholderTextColor={colors.contentTertiary}
                accessibilityLabel={`Edit ${label} section`}
              />
              {saveError && <Text className="text-caption text-status-danger mt-2">{saveError}</Text>}
              <View className="flex-row justify-end gap-2 mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    setDraft(content ?? '');
                    setSaveError(null);
                    setIsEditing(false);
                  }}
                  icon={<X color={colors.contentBody} size={14} />}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={isSaving}
                  onPress={() => { saveSection().catch(() => {}); }}
                  icon={<Save color={colors.contentOnBrand} size={14} />}
                >
                  Save
                </Button>
              </View>
            </View>
          ) : (
            <>
              <View className="mt-2">
                <MarkdownText text={content ?? ''} />
              </View>
              <View className="self-end mt-2.5 flex-row items-center gap-2">
                {canEdit && (
                  <Pressable
                    onPress={() => {
                      setDraft(content ?? '');
                      setIsEditing(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${label} section`}
                    className="flex-row items-center gap-1.5 px-4 py-1.5 rounded border border-border-strong"
                    style={{ minHeight: 44 }}
                  >
                    <Pencil color={colors.contentSecondary} size={12} style={{ flexShrink: 0 }} />
                    {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                    <Text
                      className="text-caption text-content-secondary"
                      style={{ flexShrink: 0, paddingRight: 2 }}
                    >
                      {`${SOAP_SECTION_ACTIONS.edit} `}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => { copySection().catch(() => {}); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Copy ${label} section`}
                  className="flex-row items-center gap-1.5 px-4 py-1.5 rounded border border-border-strong"
                  style={{ minHeight: 44 }}
                >
                  <Copy color={colors.contentSecondary} size={12} style={{ flexShrink: 0 }} />
                  {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                  <Text
                    className="text-caption text-content-secondary"
                    style={{ flexShrink: 0, paddingRight: 2 }}
                  >
                    {`${SOAP_SECTION_ACTIONS.copy} `}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </Animated.View>
      )}
    </View>
  );
}

export function SoapNoteView({ soapNote, recordingId, canEdit = false }: SoapNoteViewProps) {
  const colors = useThemeColors();
  const [expandedSection, setExpandedSection] = useState<string | null>('subjective');
  const [showCopiedAll, setShowCopiedAll] = useState(false);
  const copyAllTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyAllTimeoutRef.current);
  }, []);

  const copyAll = useCallback(async () => {
    try {
      const fullNote = SECTIONS.map(({ key, label }) => {
        const section = soapNote[key];
        return `${label.toUpperCase()}:\n${toPlainText(section?.content ?? '')}`;
      }).join('\n\n');

      await copyWithAutoClear(fullNote);
      if (recordingId) {
        trackEvent({ name: 'soap_exported', props: { target: 'clipboard', recording_id: recordingId } });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopiedAll(true);
      clearTimeout(copyAllTimeoutRef.current);
      copyAllTimeoutRef.current = setTimeout(() => setShowCopiedAll(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[SoapNote] copyAll failed:', error);
    }
  }, [soapNote, recordingId]);

  return (
    <View>
      <View className="flex-row justify-between items-center mb-3 relative">
        <Text
          className="text-heading font-bold text-content-primary"
          accessibilityRole="header"
        >
          SOAP Note
        </Text>
        {showCopiedAll && <CopiedToast />}
        <Pressable
          onPress={() => { copyAll().catch(() => {}); }}
          accessibilityRole="button"
          accessibilityLabel="Copy full SOAP note"
          className="bg-brand-500 px-4 py-1.5 rounded-md flex-row items-center gap-1.5 min-h-[44px]"
        >
          <Copy color={colors.contentOnBrand} size={14} style={{ flexShrink: 0 }} />
          {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
          <Text
            className="text-body-sm text-content-on-brand font-semibold"
            style={{ flexShrink: 0, paddingRight: 2 }}
          >
            {`${SOAP_SECTION_ACTIONS.copyAll} `}
          </Text>
        </Pressable>
      </View>

      {SECTIONS.map(({ key, label, accent, Icon }) => {
        const section = soapNote[key];
        if (!section) return null;

        return (
          <AccordionSection
            key={key}
            sectionKey={key}
            label={label}
            accent={accent}
            Icon={Icon}
            content={section.content}
            isEdited={section.isEdited}
            editedAt={section.editedAt}
            isExpanded={expandedSection === key}
            onToggle={() =>
              setExpandedSection((prev) => (prev === key ? null : key))
            }
            recordingId={recordingId}
            soapNoteId={soapNote.id}
            canEdit={canEdit}
          />
        );
      })}
    </View>
  );
}

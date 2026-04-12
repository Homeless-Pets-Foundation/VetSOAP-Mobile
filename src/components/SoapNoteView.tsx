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
import { copyWithAutoClear } from '../lib/secureClipboard';
import { Copy } from 'lucide-react-native';
import { Button } from './ui/Button';
import type { SoapNote } from '../types';

const SECTIONS = [
  { key: 'subjective' as const, label: 'Subjective', colorClass: 'bg-soap-subjective' },
  { key: 'objective' as const, label: 'Objective', colorClass: 'bg-soap-objective' },
  { key: 'assessment' as const, label: 'Assessment', colorClass: 'bg-soap-assessment' },
  { key: 'plan' as const, label: 'Plan', colorClass: 'bg-soap-plan' },
];

interface SoapNoteViewProps {
  soapNote: SoapNote;
  editable?: boolean;
  isSaving?: boolean;
  onSave?: (section: 'subjective' | 'objective' | 'assessment' | 'plan', content: string) => void;
  onExport?: (target: 'clipboard' | 'manual') => void;
  onRegenerate?: (section?: 'subjective' | 'objective' | 'assessment' | 'plan') => void;
  isExporting?: boolean;
  isRegenerating?: boolean;
}

function CopiedToast() {
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      className="absolute top-0 right-0 bg-stone-800 px-3 py-1.5 rounded-btn z-10"
    >
      <Text className="text-caption text-white font-medium">Copied!</Text>
    </Animated.View>
  );
}

function AccordionSection({
  sectionKey,
  label,
  colorClass,
  content,
  isExpanded,
  onToggle,
  editable = false,
  isSaving = false,
  onSave,
}: {
  sectionKey: string;
  label: string;
  colorClass: string;
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
  editable?: boolean;
  isSaving?: boolean;
  onSave?: (sectionKey: 'subjective' | 'objective' | 'assessment' | 'plan', content: string) => void;
}) {
  const [showCopied, setShowCopied] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rotation = useSharedValue(isExpanded ? 1 : 0);

  React.useEffect(() => {
    rotation.value = withTiming(isExpanded ? 1 : 0, { duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rotation is a stable Reanimated SharedValue ref
  }, [isExpanded]);

  React.useEffect(() => {
    setEditContent(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  React.useEffect(() => {
    return () => clearTimeout(copyTimeoutRef.current);
  }, []);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 90}deg` }],
  }));

  const copySection = async () => {
    try {
      await copyWithAutoClear(content ?? '');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopied(true);
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[SoapNote] copySection failed:', error);
    }
  };

  return (
    <View className="border border-stone-200 rounded-input mb-3 overflow-hidden">
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        accessibilityLabel={`${label} section`}
        className="flex-row justify-between items-center p-3 bg-stone-50"
      >
        <View className="flex-row items-center">
          <View className={`w-1 h-5 rounded-sm mr-2.5 ${colorClass}`} />
          <Text className="text-body font-semibold text-stone-900">{label}</Text>
        </View>
        <Animated.Text
          className="text-heading text-stone-400"
          style={indicatorStyle}
        >
          ›
        </Animated.Text>
      </Pressable>

      {isExpanded && (
        <Animated.View entering={FadeIn.duration(200)} className="p-3 pt-0 relative">
          {showCopied && <CopiedToast />}
          {editable ? (
            <>
              <TextInput
                value={editContent}
                onChangeText={setEditContent}
                multiline
                className="text-body text-stone-700 mt-2 leading-relaxed border border-stone-200 rounded-input p-2 min-h-[120px]"
                accessibilityLabel={`Edit ${label} section`}
                textAlignVertical="top"
              />
              <View className="flex-row justify-end gap-2 mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setEditContent(content)}
                >
                  Reset
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={isSaving}
                  onPress={() => onSave?.(sectionKey as 'subjective' | 'objective' | 'assessment' | 'plan', editContent)}
                >
                  Save
                </Button>
              </View>
            </>
          ) : (
            <Text
              className="text-body text-stone-700 mt-2 leading-relaxed"
            >
              {content ?? ''}
            </Text>
          )}
          <Pressable
            onPress={() => { copySection().catch(() => {}); }}
            accessibilityRole="button"
            accessibilityLabel={`Copy ${label} section`}
            className="self-end mt-2.5 flex-row items-center gap-1.5 px-3 py-1 rounded border border-stone-300 min-h-[44px]"
          >
            <Copy color="#57534e" size={12} />
            <Text className="text-caption text-stone-600" style={{ paddingRight: 4 }}>Copy</Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

export function SoapNoteView({
  soapNote,
  editable = false,
  isSaving = false,
  onSave,
  onExport,
  onRegenerate,
  isExporting = false,
  isRegenerating = false,
}: SoapNoteViewProps) {
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
        return `${label.toUpperCase()}:\n${section?.content ?? ''}`;
      }).join('\n\n');

      await copyWithAutoClear(fullNote);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopiedAll(true);
      clearTimeout(copyAllTimeoutRef.current);
      copyAllTimeoutRef.current = setTimeout(() => setShowCopiedAll(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[SoapNote] copyAll failed:', error);
    }
  }, [soapNote]);

  return (
    <View>
      <View className="flex-row justify-between items-center mb-3 relative">
        <Text
          className="text-heading font-bold text-stone-900"
          accessibilityRole="header"
        >
          SOAP Note
        </Text>
        {showCopiedAll && <CopiedToast />}
        <View className="flex-row gap-2 items-center">
          {onExport && (
            <Button
              variant="secondary"
              size="sm"
              loading={isExporting}
              onPress={() => onExport('manual')}
              accessibilityLabel="Mark as exported"
            >
              Export
            </Button>
          )}
          {onRegenerate && (
            <Button
              variant="secondary"
              size="sm"
              loading={isRegenerating}
              onPress={() => onRegenerate()}
              accessibilityLabel="Regenerate full SOAP note"
            >
              Regenerate
            </Button>
          )}
          <Pressable
            onPress={() => { copyAll().catch(() => {}); }}
            accessibilityRole="button"
            accessibilityLabel="Copy full SOAP note"
            className="bg-brand-500 px-3 py-1.5 rounded-md flex-row items-center gap-1.5 min-h-[44px]"
          >
            <Copy color="#fff" size={14} />
            <Text className="text-body-sm text-white font-semibold">Copy All</Text>
          </Pressable>
        </View>
      </View>

      {SECTIONS.map(({ key, label, colorClass }) => {
        const section = soapNote[key];
        if (!section) return null;

        return (
          <AccordionSection
            key={key}
            sectionKey={key}
            label={label}
            colorClass={colorClass}
            content={section.content}
            isExpanded={expandedSection === key}
            onToggle={() =>
              setExpandedSection((prev) => (prev === key ? null : key))
            }
            editable={editable}
            isSaving={isSaving}
            onSave={onSave}
          />
        );
      })}
    </View>
  );
}

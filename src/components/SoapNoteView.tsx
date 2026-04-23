import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, Pressable } from 'react-native';
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
import type { SoapNote } from '../types';
import { SOAP_SECTION_ACTIONS } from '../constants/strings';
import { trackEvent } from '../lib/analytics';

const SECTIONS = [
  { key: 'subjective' as const, label: 'Subjective', colorClass: 'bg-soap-subjective' },
  { key: 'objective' as const, label: 'Objective', colorClass: 'bg-soap-objective' },
  { key: 'assessment' as const, label: 'Assessment', colorClass: 'bg-soap-assessment' },
  { key: 'plan' as const, label: 'Plan', colorClass: 'bg-soap-plan' },
];

interface SoapNoteViewProps {
  soapNote: SoapNote;
  recordingId?: string;
}

function CopiedToast() {
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      className="absolute top-0 right-0 bg-stone-800 px-3 py-1.5 rounded-btn z-10"
    >
      <Text className="text-caption text-white font-medium">{SOAP_SECTION_ACTIONS.copied}</Text>
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
  recordingId,
}: {
  sectionKey: string;
  label: string;
  colorClass: string;
  content: string;
  isExpanded: boolean;
  onToggle: () => void;
  recordingId?: string;
}) {
  const [showCopied, setShowCopied] = useState(false);
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rotation = useSharedValue(isExpanded ? 1 : 0);

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
      await copyWithAutoClear(content ?? '');
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
        <Animated.View
          entering={FadeIn.duration(200)}
          className="p-3 pt-0 relative"
        >
          {showCopied && <CopiedToast />}
          <Text
            className="text-body text-stone-700 mt-2 leading-relaxed"
          >
            {content ?? ''}
          </Text>
          <Pressable
            onPress={() => { copySection().catch(() => {}); }}
            accessibilityRole="button"
            accessibilityLabel={`Copy ${label} section`}
            className="self-end mt-2.5 flex-row items-center gap-1.5 px-4 py-1.5 rounded border border-stone-300"
            style={{ minHeight: 44 }}
          >
            <Copy color="#57534e" size={12} style={{ flexShrink: 0 }} />
            {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
            <Text
              className="text-caption text-stone-600"
              allowFontScaling={false}
              style={{ flexShrink: 0, paddingRight: 2 }}
            >
              {`${SOAP_SECTION_ACTIONS.copy} `}
            </Text>
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

export function SoapNoteView({ soapNote, recordingId }: SoapNoteViewProps) {
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
          className="text-heading font-bold text-stone-900"
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
          <Copy color="#fff" size={14} style={{ flexShrink: 0 }} />
          {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
          <Text
            className="text-body-sm text-white font-semibold"
            allowFontScaling={false}
            style={{ flexShrink: 0, paddingRight: 2 }}
          >
            {`${SOAP_SECTION_ACTIONS.copyAll} `}
          </Text>
        </Pressable>
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
            recordingId={recordingId}
          />
        );
      })}
    </View>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Copy } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { copyWithAutoClear } from '../lib/secureClipboard';
import { useThemeColors } from '../hooks/useThemeColors';
import { TRANSCRIPT_COPY } from '../constants/strings';

interface TranscriptViewProps {
  transcript: string;
}

/**
 * Raw transcript text for a completed recording. Selectable so a vet can
 * grab a phrase without copying the whole thing; the Copy button uses the
 * auto-clearing clipboard like every other PHI copy path.
 */
export function TranscriptView({ transcript }: TranscriptViewProps) {
  const colors = useThemeColors();
  const [showCopied, setShowCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyTimeoutRef.current);
  }, []);

  const copyTranscript = async () => {
    try {
      await copyWithAutoClear(transcript ?? '');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setShowCopied(true);
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
    } catch (error) {
      if (__DEV__) console.error('[Transcript] copy failed:', error);
    }
  };

  return (
    <View className="border border-border-default rounded-input p-3 relative">
      {showCopied && (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(200)}
          className="absolute top-2 right-2 bg-toast-bg px-3 py-1.5 rounded-btn z-10"
        >
          <Text className="text-caption text-toast-fg font-medium">{TRANSCRIPT_COPY.copied}</Text>
        </Animated.View>
      )}
      <Text selectable className="text-body text-content-body leading-relaxed">
        {transcript ?? ''}
      </Text>
      <Pressable
        onPress={() => {
          copyTranscript().catch(() => {});
        }}
        accessibilityRole="button"
        accessibilityLabel="Copy transcript"
        className="self-end mt-2.5 flex-row items-center gap-1.5 px-4 py-1.5 rounded border border-border-strong"
        style={{ minHeight: 44 }}
      >
        <Copy color={colors.contentSecondary} size={12} style={{ flexShrink: 0 }} />
        {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
        <Text
          className="text-caption text-content-secondary"
          style={{ flexShrink: 0, paddingRight: 2 }}
        >
          {`${TRANSCRIPT_COPY.copy} `}
        </Text>
      </Pressable>
    </View>
  );
}

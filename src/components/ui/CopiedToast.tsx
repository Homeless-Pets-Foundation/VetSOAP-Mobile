import React, { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { Text } from './Text';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { SOAP_SECTION_ACTIONS } from '../../constants/strings';
import { CLIP_SAFE, clipSafe, cx } from './styles';

interface CopiedToastProps {
  visible: boolean;
  /** Defaults to the shared "Copied!" label. */
  label?: string;
  /** Position override — defaults to the card's top-right corner. */
  className?: string;
}

/**
 * Shared near-the-control copy confirmation. Extracted from the duplicated
 * inline mini-toasts in SoapNoteView/TranscriptView so every copy path shows
 * the same feedback (theme D of the 2026-07-17 UI/UX audit).
 *
 * Announces via AccessibilityInfo (accessibilityLiveRegion is Android-only,
 * so iOS VoiceOver users otherwise never hear that the copy succeeded).
 */
export function CopiedToast({ visible, label = SOAP_SECTION_ACTIONS.copied, className }: CopiedToastProps) {
  // Android's polite live region below already announces; doubling up made
  // TalkBack speak every confirmation twice. iOS has no live regions.
  useEffect(() => {
    if (Platform.OS === 'ios' && visible) AccessibilityInfo.announceForAccessibility(label);
  }, [visible, label]);

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      pointerEvents="none"
      className={cx('absolute top-0 right-0 bg-toast-bg px-3 py-1.5 rounded-btn z-10', className)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      {/* clipSafe + CLIP_SAFE — an absolutely-positioned toast shrink-wraps to its
          label, so Android "Bold text" has nowhere to put the overrun
          (CLAUDE.md > UI Gotchas). No numberOfLines: callers pass single-token labels
          ("Copied!"), which cannot wrap, so the prop could only add an ellipsis. */}
      <Text className="text-caption text-toast-fg font-medium" style={CLIP_SAFE}>
        {clipSafe(label)}
      </Text>
    </Animated.View>
  );
}

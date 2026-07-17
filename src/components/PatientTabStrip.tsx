import React, { useRef, useEffect } from 'react';
import { Alert, ScrollView, Pressable, View, Text } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
  FadeIn,
  FadeOut,
  LinearTransition,
} from 'react-native-reanimated';
import { Plus } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import type { PatientSlot } from '../types/multiPatient';
import { useThemeColors } from '../hooks/useThemeColors';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PatientTabStripProps {
  slots: PatientSlot[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
  onAddPatient: () => void;
}

function statusLabel(audioState: PatientSlot['audioState'], uploadStatus: PatientSlot['uploadStatus']): string {
  if (uploadStatus === 'success') return 'uploaded';
  if (uploadStatus === 'uploading') return 'uploading';
  if (audioState === 'recording') return 'recording';
  if (audioState === 'paused') return 'paused';
  if (audioState === 'stopped') return 'recorded, not submitted';
  return 'ready';
}

function StatusDot({ audioState, uploadStatus }: Pick<PatientSlot, 'audioState' | 'uploadStatus'>) {
  if (uploadStatus === 'success') {
    return (
      <View
        className="w-2 h-2 rounded-full bg-status-success-fg ml-1.5"
        accessibilityLabel="uploaded"
      />
    );
  }
  if (audioState === 'recording') {
    return <PulsingStatusDot />;
  }
  if (audioState === 'stopped') {
    // Amber, not green: a recorded-but-unsubmitted patient must not read as
    // already uploaded (matches the Home "Not Submitted" convention).
    return (
      <View
        className="w-2 h-2 rounded-full bg-status-warning-fg ml-1.5"
        accessibilityLabel="recorded, not submitted"
      />
    );
  }
  if (audioState === 'paused') {
    return (
      <View
        className="w-2 h-2 rounded-full bg-status-warning-fg ml-1.5"
        accessibilityLabel="paused"
      />
    );
  }
  return (
    <View
      className="w-2 h-2 rounded-full bg-border-strong ml-1.5"
      accessibilityLabel="ready"
    />
  );
}

function PulsingStatusDot() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => { cancelAnimation(opacity); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacity is a stable Reanimated SharedValue ref
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      className="w-2 h-2 rounded-full bg-status-danger-fg ml-1.5"
      style={style}
      accessibilityLabel="recording in progress"
    />
  );
}

function getTabLabel(slot: PatientSlot, index: number): string {
  if (slot.formData.patientName.trim()) {
    return slot.formData.patientName.trim();
  }
  return `Patient ${index + 1}`;
}

const TAB_LAYOUT_TRANSITION = LinearTransition.duration(200).easing(Easing.out(Easing.ease));

export function PatientTabStrip({ slots, activeIndex, onSelectIndex, onAddPatient }: PatientTabStripProps) {
  const colors = useThemeColors();
  const scrollRef = useRef<ScrollView>(null);
  const tabPositions = useRef<Record<number, { x: number; width: number }>>({});

  // Auto-scroll to keep active tab visible
  useEffect(() => {
    const pos = tabPositions.current[activeIndex];
    if (pos && scrollRef.current) {
      scrollRef.current.scrollTo({ x: Math.max(0, pos.x - 16), animated: true });
    }
  }, [activeIndex]);

  const handleTabPress = (index: number) => {
    Haptics.selectionAsync().catch(() => {});
    onSelectIndex(index);
  };

  const handleAddPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onAddPatient();
  };

  const handleAtMaxPress = () => {
    // ADD_SLOT silently no-ops at 10 — explain the ceiling instead.
    Alert.alert('Session Full', 'A session can hold up to 10 patients. Submit or save this session to start another.');
  };

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 4, gap: 8 }}
      accessibilityRole="tablist"
      accessibilityLabel="Patient tabs"
    >
      {slots.map((slot, index) => {
        const isActive = index === activeIndex;
        const label = getTabLabel(slot, index);
        const status = statusLabel(slot.audioState, slot.uploadStatus);

        return (
          <AnimatedPressable
            key={slot.id}
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(120)}
            layout={TAB_LAYOUT_TRANSITION}
            onPress={() => handleTabPress(index)}
            onLayout={(e) => {
              tabPositions.current[index] = {
                x: e.nativeEvent.layout.x,
                width: e.nativeEvent.layout.width,
              };
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={`${label}, ${status}`}
            accessibilityLiveRegion="polite"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            className={`px-3.5 min-h-[44px] flex-row items-center justify-center rounded-pill border ${
              isActive
                ? 'border-brand-500 bg-brand-500'
                : 'border-border-strong bg-surface-raised'
            }`}
          >
            <Text
              className={`text-body-sm font-medium shrink max-w-[180px] ${
                isActive ? 'text-content-on-brand' : 'text-content-body'
              }`}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {label}
            </Text>
            <StatusDot audioState={slot.audioState} uploadStatus={slot.uploadStatus} />
          </AnimatedPressable>
        );
      })}

      {/* Add patient button — disabled (not hidden) at max so the limit is
          explained instead of the control silently vanishing */}
      <Animated.View layout={TAB_LAYOUT_TRANSITION}>
        <Pressable
          onPress={slots.length < 10 ? handleAddPress : handleAtMaxPress}
          accessibilityRole="button"
          accessibilityLabel={slots.length < 10 ? 'Add patient' : 'Add patient — session is full'}
          // Deliberately NOT accessibilityState.disabled: the control stays
          // tappable at the max so it can explain the limit, and a disabled
          // state would make VoiceOver/TalkBack refuse to activate it.
          accessibilityHint={
            slots.length < 10
              ? undefined
              : 'A session can hold up to 10 patients. Activating explains the limit.'
          }
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className={`w-[44px] h-[44px] items-center justify-center rounded-full border border-dashed bg-surface-raised ${
            slots.length < 10 ? 'border-border-strong' : 'border-border-default opacity-50'
          }`}
        >
          <Plus color={colors.contentTertiary} size={18} />
        </Pressable>
      </Animated.View>
    </ScrollView>
  );
}

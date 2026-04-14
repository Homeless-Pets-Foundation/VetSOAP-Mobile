import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { StatusBadge } from './StatusBadge';
import type { Recording } from '../types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface RecordingCardProps {
  recording: Recording;
  localDraftSlotId?: string;
}

export const RecordingCard = React.memo(function RecordingCard({ recording, localDraftSlotId }: RecordingCardProps) {
  const router = useRouter();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const parsedDate = new Date(recording.createdAt);
  const formattedDate = isNaN(parsedDate.getTime())
    ? ''
    : parsedDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

  const description = [
    recording.species,
    recording.breed ? `${recording.breed}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');

  const clientLabel = recording.clientName?.trim();

  return (
    <AnimatedPressable
      onPress={() => {
        if (recording.status === 'draft' && localDraftSlotId) {
          router.push(`/(tabs)/record?draftSlotId=${localDraftSlotId}` as any);
        } else if (recording.id) {
          router.push(`/recordings/${recording.id}` as `/recordings/${string}`);
        }
      }}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel={`Recording from ${formattedDate || 'unknown date'}, status ${recording.status}`}
      className="card mb-2"
      style={animatedStyle}
    >
      <View className="flex-row justify-between items-center">
        <View className="flex-1 mr-3">
          <View className="flex-row items-center">
            {recording.patientId ? (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  router.push(`/patient/${recording.patientId}` as `/patient/${string}`);
                }}
                hitSlop={4}
                accessibilityRole="link"
                accessibilityLabel={`View patient history for ${recording.patientName}`}
                className="shrink"
              >
                <Text className="text-body-lg font-semibold text-brand-600" numberOfLines={1}>
                  {recording.patientName}
                </Text>
              </Pressable>
            ) : (
              <Text className="text-body-lg font-semibold text-stone-900 shrink" numberOfLines={1}>
                {recording.patientName}
              </Text>
            )}
            {clientLabel ? (
              <Text
                className="text-body-lg text-stone-500 ml-2 flex-1"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                · {clientLabel}
              </Text>
            ) : null}
          </View>
          {description ? (
            <Text
              className="text-body-sm text-stone-500 mt-0.5"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {description}
            </Text>
          ) : null}
          <Text className="text-caption text-stone-500 mt-1">
            {formattedDate}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <StatusBadge status={recording.status} />
          <ChevronRight color="#a8a29e" size={18} />
        </View>
      </View>
    </AnimatedPressable>
  );
}, (prev, next) =>
  prev.recording.id === next.recording.id &&
  prev.recording.status === next.recording.status &&
  prev.recording.patientName === next.recording.patientName &&
  prev.recording.clientName === next.recording.clientName &&
  prev.localDraftSlotId === next.localDraftSlotId
);

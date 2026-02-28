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
}

export function RecordingCard({ recording }: RecordingCardProps) {
  const router = useRouter();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const formattedDate = new Date(recording.createdAt).toLocaleDateString('en-US', {
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

  return (
    <AnimatedPressable
      onPress={() => router.push(`/(app)/recordings/${recording.id}` as any)}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel={`${recording.patientName}, ${description || 'no species'}, ${formattedDate}, status ${recording.status}`}
      className="card mb-2"
      style={animatedStyle}
    >
      <View className="flex-row justify-between items-center">
        <View className="flex-1 mr-3">
          <Text className="text-body-lg font-semibold text-stone-900">
            {recording.patientName}
          </Text>
          {description ? (
            <Text className="text-body-sm text-stone-500 mt-0.5">
              {description}
            </Text>
          ) : null}
          <Text className="text-caption text-stone-400 mt-1">
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
}

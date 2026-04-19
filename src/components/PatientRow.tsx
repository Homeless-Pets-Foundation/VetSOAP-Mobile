import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import type { Patient } from '../types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PatientRowProps {
  patient: Patient;
}

export const PatientRow = React.memo(function PatientRow({ patient }: PatientRowProps) {
  const router = useRouter();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const description = [
    patient.species,
    patient.breed ? `${patient.breed}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');

  const visitCount = patient._count?.recordings ?? 0;

  return (
    <AnimatedPressable
      onPress={() => {
        if (patient.id) {
          router.push(`/patient/${patient.id}` as `/patient/${string}`);
        }
      }}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel={`Patient ${patient.name}`}
      className="card mb-2"
      style={animatedStyle}
    >
      <View className="flex-row justify-between items-center">
        <View className="flex-1 mr-3">
          <Text className="text-body-lg font-semibold text-stone-900 shrink" numberOfLines={1}>
            {patient.name}
          </Text>
          <View className="flex-row items-center mt-0.5">
            {patient.pimsPatientId ? (
              <Text className="text-body-sm text-stone-500">
                ID: {patient.pimsPatientId}
              </Text>
            ) : null}
            {description ? (
              <Text
                className="text-body-sm text-stone-500"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {patient.pimsPatientId ? ' \u00B7 ' : ''}{description}
              </Text>
            ) : null}
          </View>
          {visitCount > 0 ? (
            <Text className="text-caption text-stone-500 mt-1">
              {visitCount} {visitCount === 1 ? 'visit' : 'visits'}
            </Text>
          ) : null}
        </View>
        <ChevronRight color="#a8a29e" size={18} />
      </View>
    </AnimatedPressable>
  );
}, (prev, next) =>
  prev.patient.id === next.patient.id &&
  prev.patient.name === next.patient.name &&
  prev.patient._count?.recordings === next.patient._count?.recordings
);

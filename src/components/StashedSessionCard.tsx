import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Archive, Trash2, Play } from 'lucide-react-native';
import type { StashedSession } from '../types/stash';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface StashedSessionCardProps {
  stash: StashedSession;
  onResume: () => void;
  onDelete: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '';
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function StashedSessionCard({ stash, onResume, onDelete }: StashedSessionCardProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onResume}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel={`Saved session for ${stash.clientName}, ${stash.patientSummary}`}
      accessibilityHint="Double-tap to resume this recording session"
      className="card mb-2"
      style={animatedStyle}
    >
      <View className="flex-row items-center gap-3">
        {/* Icon */}
        <View className="w-9 h-9 rounded-full bg-warning-50 items-center justify-center">
          <Archive color="#b45309" size={18} />
        </View>

        {/* Content */}
        <View className="flex-1">
          <Text className="text-body font-semibold text-stone-900" numberOfLines={1}>
            {stash.clientName}
          </Text>
          <Text className="text-body-sm text-stone-500 mt-0.5" numberOfLines={1}>
            {stash.patientSummary}
          </Text>
          <View className="flex-row items-center gap-2 mt-1">
            <Text className="text-caption text-stone-500">
              {formatRelativeTime(stash.stashedAt)}
            </Text>
            {stash.totalDuration > 0 && (
              <>
                <Text className="text-caption text-stone-500">{'\u00B7'}</Text>
                <Text className="text-caption text-stone-500">
                  {formatDuration(stash.totalDuration)}
                </Text>
              </>
            )}
            <Text className="text-caption text-stone-500">{'\u00B7'}</Text>
            <Text className="text-caption text-stone-500">
              {stash.patientCount} {stash.patientCount === 1 ? 'patient' : 'patients'}
            </Text>
          </View>
        </View>

        {/* Actions */}
        <View className="flex-row items-center gap-1">
          <Pressable
            onPress={onResume}
            accessibilityRole="button"
            accessibilityLabel="Resume session"
            accessibilityHint="Double-tap to restore this recording session"
            className="w-10 h-10 rounded-full bg-brand-50 items-center justify-center"
          >
            <Play color="#2563eb" size={16} fill="#2563eb" />
          </Pressable>
          <Pressable
            onPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel="Delete saved session"
            accessibilityHint="Double-tap to permanently delete this saved session and its recordings"
            className="w-10 h-10 rounded-full items-center justify-center"
            hitSlop={8}
          >
            <Trash2 color="#78716c" size={16} />
          </Pressable>
        </View>
      </View>
    </AnimatedPressable>
  );
}

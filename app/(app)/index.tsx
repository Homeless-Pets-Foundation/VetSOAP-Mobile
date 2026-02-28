import React from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Mic, ChevronRight, FileText } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../src/hooks/useAuth';
import { recordingsApi } from '../../src/api/recordings';
import { RecordingCard } from '../../src/components/RecordingCard';
import { ScreenContainer } from '../../src/components/ui/ScreenContainer';
import { SkeletonCard } from '../../src/components/ui/Skeleton';
import { Card } from '../../src/components/ui/Card';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const ctaScale = useSharedValue(1);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['recordings', 'recent'],
    queryFn: () => recordingsApi.list({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' }),
  });

  const recordings = data?.data ?? [];
  const totalRecordings = data?.pagination?.total ?? 0;
  const completedCount = recordings.filter((r) => r.status === 'completed').length;

  const ctaAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaScale.value }],
  }));

  return (
    <ScreenContainer refreshing={isRefetching} onRefresh={refetch}>
      {/* Header */}
      <Animated.View entering={FadeInDown.duration(400)} className="mb-6">
        <Text
          className="text-display font-bold text-stone-900"
          accessibilityRole="header"
        >
          Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
        </Text>
        <Text className="text-body text-stone-500 mt-1">
          Record appointments and generate SOAP notes
        </Text>
      </Animated.View>

      {/* Quick Action */}
      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push('/(app)/record');
        }}
        onPressIn={() => {
          ctaScale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
        }}
        onPressOut={() => {
          ctaScale.value = withSpring(1, { damping: 15, stiffness: 300 });
        }}
        accessibilityRole="button"
        accessibilityLabel="Record a new appointment"
        className="bg-brand-500 rounded-card p-5 mb-6 flex-row items-center shadow-card-md"
        style={ctaAnimStyle}
      >
        <View className="w-12 h-12 rounded-full bg-white/20 justify-center items-center mr-4">
          <Mic color="#fff" size={24} />
        </View>
        <View className="flex-1">
          <Text className="text-white text-heading font-bold">
            Record Appointment
          </Text>
          <Text className="text-white/80 text-body-sm mt-0.5">
            Start recording a new appointment
          </Text>
        </View>
        <ChevronRight color="rgba(255,255,255,0.6)" size={24} />
      </AnimatedPressable>

      {/* Stats */}
      <Animated.View entering={FadeInUp.duration(400).delay(100)} className="flex-row gap-3 mb-6">
        <Card className="flex-1" accessibilityLabel={`${totalRecordings} total recordings`}>
          <Text className="text-display font-bold text-brand-500">
            {totalRecordings}
          </Text>
          <Text className="text-caption text-stone-500 mt-0.5">Total Recordings</Text>
        </Card>
        <Card className="flex-1" accessibilityLabel={`${completedCount} SOAP notes ready`}>
          <Text className="text-display font-bold text-brand-500">
            {completedCount}
          </Text>
          <Text className="text-caption text-stone-500 mt-0.5">SOAP Notes Ready</Text>
        </Card>
      </Animated.View>

      {/* Recent Recordings */}
      <View className="mb-8">
        <View className="flex-row justify-between items-center mb-3">
          <Text className="section-title">Recent Recordings</Text>
          {totalRecordings > 5 && (
            <Pressable
              onPress={() => router.push('/(app)/recordings')}
              accessibilityRole="button"
              accessibilityLabel="View all recordings"
            >
              <Text className="text-body-sm text-brand-500 font-medium">View All</Text>
            </Pressable>
          )}
        </View>

        {isLoading ? (
          <View>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : recordings.length === 0 ? (
          <Card className="items-center py-6">
            <FileText color="#a8a29e" size={48} />
            <Text className="text-body text-stone-500 mt-3 text-center">
              No recordings yet. Tap "Record Appointment" to get started.
            </Text>
          </Card>
        ) : (
          recordings.map((recording) => (
            <RecordingCard key={recording.id} recording={recording} />
          ))
        )}
      </View>
    </ScreenContainer>
  );
}

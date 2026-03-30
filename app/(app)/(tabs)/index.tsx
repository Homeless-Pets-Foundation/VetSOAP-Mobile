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
import { Mic, ChevronRight, FileText, Settings } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuth } from '../../../src/hooks/useAuth';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { recordingsApi } from '../../../src/api/recordings';
import { RecordingCard } from '../../../src/components/RecordingCard';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { SkeletonCard } from '../../../src/components/ui/Skeleton';
import { Card } from '../../../src/components/ui/Card';
import { Button } from '../../../src/components/ui/Button';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { iconMd, iconLg } = useResponsive();
  const ctaScale = useSharedValue(1);

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['recordings', 'recent'],
    queryFn: () => recordingsApi.list({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' }),
    enabled: !!user,  // Don't fire until fetchUser has completed
    refetchInterval: (query) => {
      const allRecordings = query.state.data?.data;
      const hasProcessing = allRecordings?.some(
        (r) => !['completed', 'failed', 'pending_metadata'].includes(r.status)
      );
      return hasProcessing ? 10000 : false;
    },
  });

  const recordings = data?.data ?? [];
  const totalRecordings = data?.pagination?.total ?? 0;
  const processingCount = recordings.filter(
    (r) => !['completed', 'failed'].includes(r.status)
  ).length;

  const ctaAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaScale.value }],
  }));

  return (
    <ScreenContainer refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }}>
      {/* Header */}
      <Animated.View entering={FadeInDown.duration(400)} className="mb-6 flex-row items-start justify-between">
        <View className="flex-1">
          <Text
            className="text-display font-bold text-stone-900"
            accessibilityRole="header"
          >
            Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
          </Text>
          <Text className="text-body text-stone-500 mt-1">
            Record appointments and generate SOAP notes
          </Text>
        </View>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            router.push('/settings');
          }}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          className="p-2 -mr-2 mt-0.5"
          hitSlop={8}
        >
          <Settings color="#78716c" size={iconMd} />
        </Pressable>
      </Animated.View>

      {/* Quick Action */}
      <AnimatedPressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          router.push('/record');
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
          <Mic color="#fff" size={iconMd} />
        </View>
        <View className="flex-1">
          <Text className="text-white text-heading font-bold">
            Record Appointment
          </Text>
          <Text className="text-white/80 text-body-sm mt-0.5">
            Start recording a new appointment
          </Text>
        </View>
        <ChevronRight color="rgba(255,255,255,0.6)" size={iconMd} />
      </AnimatedPressable>

      {/* Stats */}
      <Animated.View entering={FadeInUp.duration(400).delay(100)} className="flex-row gap-3 mb-6">
        <Card className="flex-1" accessibilityLabel={`${totalRecordings} total recordings`}>
          <Text className="text-display font-bold text-brand-500">
            {totalRecordings}
          </Text>
          <Text className="text-caption text-stone-500 mt-0.5">Total Recordings</Text>
        </Card>
        <Card className="flex-1" accessibilityLabel={`${processingCount > 0 ? processingCount + ' processing' : 'All complete'}`}>
          <Text className={`text-display font-bold ${processingCount > 0 ? 'text-warning-500' : 'text-success-500'}`}>
            {processingCount > 0 ? processingCount : '\u2713'}
          </Text>
          <Text className="text-caption text-stone-500 mt-0.5">
            {processingCount > 0 ? 'Processing' : 'All Complete'}
          </Text>
        </Card>
      </Animated.View>

      {/* Recent Recordings */}
      <View className="mb-8">
        <View className="flex-row justify-between items-center mb-3">
          <Text className="section-title">Recent Recordings</Text>
          {totalRecordings > 5 && (
            <Pressable
              onPress={() => router.push('/recordings')}
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
        ) : isError ? (
          <Card className="items-center py-6">
            <FileText color="#dc2626" size={iconLg} />
            <Text className="text-body text-stone-600 mt-3 text-center">
              Could not load recordings.
            </Text>
            <View className="mt-3">
              <Button variant="secondary" size="sm" onPress={() => { refetch().catch(() => {}); }}>
                Retry
              </Button>
            </View>
          </Card>
        ) : recordings.length === 0 ? (
          <Card className="items-center py-6">
            <FileText color="#a8a29e" size={iconLg} />
            <Text className="text-body text-stone-500 mt-3 text-center">
              No recordings yet. Tap &quot;Record Appointment&quot; to get started.
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

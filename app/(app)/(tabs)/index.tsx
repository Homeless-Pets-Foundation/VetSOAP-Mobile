import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Alert, View, Text, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Mic, ChevronRight, FileText, Settings, ShieldAlert, Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthDeviceRegistration, useAuthUser } from '../../../src/hooks/useAuth';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../src/hooks/useThemeColors';
import { useDeviceCapacity } from '../../../src/hooks/useDeviceCapacity';
import { useLocalDraftRecordings } from '../../../src/hooks/useLocalDraftRecordings';
import { useRetryableInitialLoadError } from '../../../src/hooks/useRetryableInitialLoadError';
import { recordingsApi } from '../../../src/api/recordings';
import { patientsApi } from '../../../src/api/patients';
import { mergeDraftRecordings } from '../../../src/lib/draftRecordings';
import { measurePhase } from '../../../src/lib/monitoring';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../src/lib/recordingPermissions';
import { RecordingCard } from '../../../src/components/RecordingCard';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { SkeletonCard } from '../../../src/components/ui/Skeleton';
import { Card } from '../../../src/components/ui/Card';
import { Button } from '../../../src/components/ui/Button';
import { Banner } from '../../../src/components/ui/Banner';
import { ProviderIssueBanner } from '../../../src/components/ProviderIssueBanner';
import { DurableRecoveryBanner } from '../../../src/components/DurableRecoveryBanner';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthUser();
  const colors = useThemeColors();
  const { iconMd, iconLg } = useResponsive();
  const ctaScale = useSharedValue(1);
  const isTabFocused = useIsFocused();
  const { capacity } = useDeviceCapacity();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock;

  // Parallel fetch — useQueries fires both requests at once instead of letting
  // React Query serialize independent useQuery calls. Saves 100-300 ms on cold
  // start over slow LTE.
  const [recordingsQuery, draftsQuery] = useQueries({
    queries: [
      {
        queryKey: ['recordings', 'recent'],
        queryFn: () => recordingsApi.list({ limit: 5, sortBy: 'submittedAt', sortOrder: 'desc' }),
        enabled: canLoadServerData,
        refetchInterval: (query: { state: { data?: Awaited<ReturnType<typeof recordingsApi.list>> } }) => {
          if (!isTabFocused) return false;
          const allRecordings = query.state.data?.data;
          const hasProcessing = allRecordings?.some(
            (r) => !['completed', 'failed', 'pending_metadata'].includes(r.status)
          );
          return hasProcessing ? 10000 : false;
        },
      },
      {
        queryKey: ['recordings', 'drafts', 'recent'],
        queryFn: () => recordingsApi.list({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc', status: 'draft' as const }),
        enabled: canLoadServerData,
      },
    ],
  });

  const { data, error, isLoading, isError, refetch, isRefetching } = recordingsQuery;
  const {
    data: draftData,
    error: draftError,
    isError: isDraftError,
    refetch: refetchDrafts,
  } = draftsQuery;
  const recordings = useMemo(() => data?.data ?? [], [data?.data]);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const {
    localDrafts,
    draftResumeMap,
    refreshLocalDrafts,
    isStale: areLocalDraftsStale,
  } = useLocalDraftRecordings();
  const areLocalDraftsStaleRef = useRef(areLocalDraftsStale);

  useEffect(() => {
    areLocalDraftsStaleRef.current = areLocalDraftsStale;
  }, [areLocalDraftsStale]);

  useRetryableInitialLoadError({
    screen: 'home',
    source: 'recordings',
    retryKey: 'recent',
    enabled: canLoadServerData,
    isError,
    error,
    hasData: !!data,
    refetch,
  });
  useRetryableInitialLoadError({
    screen: 'home',
    source: 'drafts',
    retryKey: 'recent-drafts',
    enabled: canLoadServerData,
    isError: isDraftError,
    error: draftError,
    hasData: !!draftData,
    refetch: refetchDrafts,
  });
  const drafts = useMemo(() => {
    if (!user) return [];
    return mergeDraftRecordings(localDrafts, draftData?.data ?? [], user.id, user.organizationId);
  }, [draftData?.data, localDrafts, user]);
  const recentPatientRecording = useMemo(
    () => recordings.find((r) => r.patientId && r.status === 'completed') ?? recordings.find((r) => r.patientId),
    [recordings]
  );
  const recentPatientId = recentPatientRecording?.patientId ?? null;
  const { data: recentPatient } = useQuery({
    queryKey: ['patient', recentPatientId],
    queryFn: () => patientsApi.get(recentPatientId!),
    enabled: canLoadServerData && !!recentPatientId,
    staleTime: 5 * 60 * 1000,
  });
  const recentPatientSummary = recentPatient?.aiHistorySummary?.trim() ?? '';
  const showRecentPatientSummary = recentPatientSummary.length > 0;

  useEffect(() => {
    setSummaryExpanded(false);
  }, [recentPatientId]);

  const totalRecordings = data?.pagination?.total ?? 0;
  const processingCount = recordings.filter(
    (r) => !['completed', 'failed'].includes(r.status)
  ).length;
  // "All Complete" must not show while un-submitted drafts exist (audit
  // defect: ✓ next to a "Not Submitted" list reads as a contradiction).
  // Server total can exceed the merged 5-item list; show the larger count.
  const draftCount = Math.max(drafts.length, draftData?.pagination?.total ?? 0);

  const ctaAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaScale.value }],
  }));

  const handleRefresh = useCallback(() => {
    if (canLoadServerData) {
      refetch().catch(() => {});
      refetchDrafts().catch(() => {});
    }
    refreshLocalDrafts({ forceReconcile: true });
  }, [canLoadServerData, refetch, refetchDrafts, refreshLocalDrafts]);

  const handleRecordPress = useCallback(() => {
    if (!canRecordAppointments(user?.role)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(RECORD_APPOINTMENT_PERMISSION_TITLE, RECORD_APPOINTMENT_PERMISSION_MESSAGE);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    router.push('/record');
  }, [router, user?.role]);

  const handleFocusRefresh = useCallback(() => {
    const staleServerSourceCount =
      Number(canLoadServerData && recordingsQuery.isStale) +
      Number(canLoadServerData && draftsQuery.isStale);
    const localDraftsStale = areLocalDraftsStaleRef.current;
    measurePhase('home_focus_refresh', {
      recordings_stale: canLoadServerData && recordingsQuery.isStale,
      server_drafts_stale: canLoadServerData && draftsQuery.isStale,
      local_drafts_stale: localDraftsStale,
      local_drafts_refreshed: true,
      skipped: false,
      count: staleServerSourceCount + 1,
    }, () => {
      if (canLoadServerData && recordingsQuery.isStale) {
        refetch().catch(() => {});
      }
      if (canLoadServerData && draftsQuery.isStale) {
        refetchDrafts().catch(() => {});
      }
      refreshLocalDrafts();
    });
  }, [
    canLoadServerData,
    draftsQuery.isStale,
    recordingsQuery.isStale,
    refetch,
    refetchDrafts,
    refreshLocalDrafts,
  ]);

  useFocusEffect(handleFocusRefresh);

  return (
    <ScreenContainer refreshing={isRefetching} onRefresh={handleRefresh}>
      {/* Header */}
      <View className="mb-6 flex-row items-start justify-between">
        <View className="flex-1">
          <Text
            className="text-display font-bold text-content-primary"
            accessibilityRole="header"
          >
            Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
          </Text>
          <Text className="text-body text-content-tertiary mt-1">
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
          <Settings color={colors.contentTertiary} size={iconMd} />
        </Pressable>
      </View>

      {/* Durable crash-recovery banner (renders only when recordings recovered) */}
      <DurableRecoveryBanner />

      {/* Device limit warning */}
      {capacity && (capacity.isAtLimit || capacity.isNearLimit) ? (
        <View className="mb-4">
          <Banner
            variant={capacity.isAtLimit ? 'error' : 'warning'}
            icon={ShieldAlert}
            message={
              capacity.isAtLimit
                ? `Device limit reached (${capacity.count}/${capacity.limit}). Remove a device to add a new one.`
                : `${capacity.count} of ${capacity.limit} devices in use. Manage your devices to free a slot.`
            }
            cta={{
              label: 'Manage',
              onPress: () => {
                Haptics.selectionAsync().catch(() => {});
                router.push('/devices' as never);
              },
            }}
          />
        </View>
      ) : null}

      <ProviderIssueBanner location="home" />

      {/* Quick Action — hero CTA. Gradient + glow for premium depth; the
          gradient takes raw color values (not Tailwind classes) so stops pull
          from useThemeColors (dark-mode aware, dodges the color guard). */}
      <AnimatedPressable
        onPress={handleRecordPress}
        onPressIn={() => {
          ctaScale.value = withSpring(0.98, { damping: 15, stiffness: 300 });
        }}
        onPressOut={() => {
          ctaScale.value = withSpring(1, { damping: 15, stiffness: 300 });
        }}
        accessibilityRole="button"
        accessibilityLabel="Record a new appointment"
        className="rounded-card mb-6 shadow-glow"
        style={ctaAnimStyle}
      >
        <LinearGradient
          colors={[colors.brand500, colors.brand600]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ borderRadius: 14, padding: 20, flexDirection: 'row', alignItems: 'center' }}
        >
          <View className="w-12 h-12 rounded-full bg-content-on-brand/20 justify-center items-center mr-4">
            <Mic color={colors.contentOnBrand} size={iconMd} />
          </View>
          <View className="flex-1">
            <Text className="text-content-on-brand text-heading font-bold">
              Record Appointment
            </Text>
            <Text className="text-content-on-brand/80 text-body-sm mt-0.5">
              Start recording a new appointment
            </Text>
          </View>
          <ChevronRight color={colors.contentOnBrand} size={iconMd} opacity={0.6} />
        </LinearGradient>
      </AnimatedPressable>

      {showRecentPatientSummary ? (
        <View className="mb-6">
          <Card className="border-brand-100 dark:border-border-default">
            <View className="flex-row items-start">
              <View className="w-10 h-10 rounded-full bg-brand-50 dark:bg-surface-sunken justify-center items-center mr-3">
                <Sparkles color={colors.brand500} size={iconMd} />
              </View>
              <View className="flex-1">
                <Text className="text-caption text-brand-600 font-semibold uppercase">
                  Recent patient
                </Text>
                <Text className="text-body-lg font-semibold text-content-primary mt-0.5" numberOfLines={1}>
                  {recentPatient?.name ?? recentPatientRecording?.patientName ?? 'Patient'}
                </Text>
                <Text
                  className="text-body-sm text-content-secondary mt-2"
                  numberOfLines={summaryExpanded ? undefined : 2}
                >
                  {recentPatientSummary}
                </Text>
                {recentPatientSummary.length > 120 ? (
                  <Pressable
                    onPress={() => {
                      Haptics.selectionAsync().catch(() => {});
                      setSummaryExpanded((expanded) => !expanded);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={summaryExpanded ? 'Collapse recent patient summary' : 'Read recent patient summary'}
                    className="self-start mt-2"
                    hitSlop={8}
                  >
                    <Text className="text-body-sm text-brand-600 font-semibold">
                      {summaryExpanded ? 'Show less' : 'Read more'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </Card>
        </View>
      ) : null}

      {/* Stats */}
      <View className="flex-row gap-3 mb-6">
        <Card className="flex-1" accessibilityLabel={`${totalRecordings} total recordings`}>
          <Text className="text-display font-bold text-brand-500">
            {totalRecordings}
          </Text>
          <Text className="text-caption text-content-tertiary mt-0.5">Total Recordings</Text>
        </Card>
        <Card
          className="flex-1"
          accessibilityLabel={
            processingCount > 0
              ? `${processingCount} processing`
              : draftCount > 0
                ? `${draftCount} not submitted`
                : 'All complete'
          }
        >
          <Text
            className={`text-display font-bold ${
              processingCount > 0
                ? 'text-warning-500'
                : draftCount > 0
                  ? 'text-warning-500'
                  : 'text-success-500'
            }`}
          >
            {processingCount > 0 ? processingCount : draftCount > 0 ? draftCount : '\u2713'}
          </Text>
          <Text className="text-caption text-content-tertiary mt-0.5">
            {processingCount > 0 ? 'Processing' : draftCount > 0 ? 'Not Submitted' : 'All Complete'}
          </Text>
        </Card>
      </View>

      {/* Recent Recordings */}
      {drafts.length > 0 ? (
        <View className="mb-6">
          <View className="flex-row justify-between items-center mb-3">
            <Text className="section-title">Not Submitted</Text>
          </View>
          {drafts.map((recording) => (
            <View key={recording.id}>
              <RecordingCard recording={recording} localDraftSlotId={draftResumeMap[recording.id]} />
            </View>
          ))}
        </View>
      ) : null}

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
            <FileText color={colors.danger600} size={iconLg} />
            <Text className="text-body text-content-secondary mt-3 text-center">
              Could not load recordings.
            </Text>
            {error ? (
              <Text className="text-caption text-content-tertiary mt-2 text-center px-4" selectable>
                [{error.name ?? 'Error'}{(error as { status?: number })?.status ? ` ${(error as { status?: number }).status}` : ''}] {error.message}
              </Text>
            ) : null}
            <View className="mt-3">
              <Button variant="secondary" size="sm" onPress={() => { refetch().catch(() => {}); }}>
                Retry
              </Button>
            </View>
          </Card>
        ) : recordings.length === 0 ? (
          <Card className="items-center py-8">
            <View className="w-16 h-16 rounded-full bg-brand-50 dark:bg-surface-sunken justify-center items-center mb-4">
              <Mic color={colors.brand500} size={iconLg} />
            </View>
            <Text className="text-body-lg font-semibold text-content-primary text-center">
              Your patients are waiting
            </Text>
            <Text className="text-body-sm text-content-tertiary mt-1.5 text-center">
              Tap &quot;Record Appointment&quot; to start your first SOAP note.
            </Text>
          </Card>
        ) : (
          recordings.map((recording) => (
            <View key={recording.id}>
              <RecordingCard recording={recording} localDraftSlotId={draftResumeMap[recording.id]} />
            </View>
          ))
        )}
      </View>
    </ScreenContainer>
  );
}

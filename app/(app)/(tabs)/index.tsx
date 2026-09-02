import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Alert, View, Pressable, Image, type ScrollView } from 'react-native';
import { Text } from '../../../src/components/ui/Text';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Mic, ChevronRight, FileText, LifeBuoy, Settings, ShieldAlert, Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAuthDeviceRegistration, useAuthUser } from '../../../src/hooks/useAuth';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../src/hooks/useThemeColors';
import { useDeviceCapacity } from '../../../src/hooks/useDeviceCapacity';
import { useLocalDraftRecordings } from '../../../src/hooks/useLocalDraftRecordings';
import { useRetryableInitialLoadError } from '../../../src/hooks/useRetryableInitialLoadError';
import { recordingsApi } from '../../../src/api/recordings';
import { patientsApi } from '../../../src/api/patients';
import {
  qualityAnalyticsApi,
  shouldFetchQualityAnalytics,
} from '../../../src/api/qualityAnalytics';
import { mergeDraftRecordings } from '../../../src/lib/draftRecordings';
import { measurePhase } from '../../../src/lib/monitoring';
import { friendlyErrorMessage, technicalErrorDetails } from '../../../src/lib/errorCopy';
import { copyWithAutoClear } from '../../../src/lib/secureClipboard';
import { ERROR_COPY, HOME_COPY, SUPPORT_RECOVERY_BANNER_COPY } from '../../../src/constants/strings';
import { deriveRecentStatusPill } from '../../../src/lib/homeRecordingStatus';
import { CLIP_SAFE, clipSafe, HIT_SLOP } from '../../../src/components/ui/styles';
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
import { Badge } from '../../../src/components/ui/Badge';
import { ProviderIssueBannerContent, useActiveProviderIssue } from '../../../src/components/ProviderIssueBanner';
import { useDurableRecoveries } from '../../../src/hooks/useDurableRecoveries';
import { DurableRecoveryBanner } from '../../../src/components/DurableRecoveryBanner';
import { QualityAnalyticsCard } from '../../../src/components/QualityAnalyticsCard';
import { useAttentionFeed, useAttentionImpression } from '../../../src/hooks/useAttentionFeed';
import {
  AttentionFeedSection,
  homeAttentionHasContent,
} from '../../../src/components/AttentionFeedSection';
import { useSupportRecoveryVaultSummary } from '../../../src/hooks/useSupportRecoveryVault';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Floor between processing-completion-driven quality dashboard refetches. The
 * recent-recordings list polls every 10s while anything is processing, so a
 * batch finishing together would otherwise fire several dashboard requests in
 * quick succession on top of Home's existing fan-out.
 */
const QUALITY_REFETCH_MIN_INTERVAL_MS = 30_000;

export default function HomeScreen() {
  const router = useRouter();
  const user = useAuthUser();
  const colors = useThemeColors();
  const { scale, iconMd, iconLg } = useResponsive();
  const ctaScale = useSharedValue(1);
  // Re-pressing the focused Home tab scrolls back to the top. The tab layout's
  // own `tabPress` listener only fires haptics and never preventDefaults Home.
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const isTabFocused = useIsFocused();
  const { capacity } = useDeviceCapacity();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const durableRecoveries = useDurableRecoveries();
  const activeProviderIssue = useActiveProviderIssue();
  const supportRecovery = useSupportRecoveryVaultSummary();
  const attentionFeed = useAttentionFeed({ focused: isTabFocused });
  const showAttentionSection = homeAttentionHasContent(attentionFeed);
  // Depend on the STABLE refresh functions, never the hook result objects: an
  // unstable useFocusEffect callback re-fires on every render (refetch storm).
  const refreshAttention = attentionFeed.refresh;
  const refreshSupportRecovery = supportRecovery.refresh;
  useAttentionImpression('home', attentionFeed, isTabFocused && showAttentionSection);
  const [bannersExpanded, setBannersExpanded] = useState(false);
  // Priority order (WP30): recovery > support-staff recovery vault > device
  // limit > provider issue. Recovery of preserved clinical work outranks data
  // hygiene, which is why the vault banner lives HERE and never in the
  // lower-priority attention feed (no double-counting). The two global thin
  // strips (device registration, offline) live in (app)/_layout.
  const showSupportRecoveryBanner =
    supportRecovery.state === 'unknown' ||
    (supportRecovery.state === 'known' && supportRecovery.count > 0);
  const activeBannerKeys = useMemo(() => {
    const keys: ('recovery' | 'supportRecovery' | 'deviceLimit' | 'providerIssue')[] = [];
    if (durableRecoveries.length > 0) keys.push('recovery');
    if (showSupportRecoveryBanner) keys.push('supportRecovery');
    if (capacity && (capacity.isAtLimit || capacity.isNearLimit)) keys.push('deviceLimit');
    if (activeProviderIssue) keys.push('providerIssue');
    return keys;
  }, [durableRecoveries.length, showSupportRecoveryBanner, capacity, activeProviderIssue]);
  const visibleBannerKeys = bannersExpanded ? activeBannerKeys : activeBannerKeys.slice(0, 1);
  const hiddenBannerCount = activeBannerKeys.length - visibleBannerKeys.length;
  const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock;
  const canFetchQualityAnalytics = shouldFetchQualityAnalytics(
    user,
    deviceRegistrationPending,
    !!deviceRegistrationBlock
  );

  // Parallel fetch — useQueries fires both requests at once instead of letting
  // React Query serialize independent useQuery calls. Saves 100-300 ms on cold
  // start over slow LTE.
  const [recordingsQuery, draftsQuery] = useQueries({
    queries: [
      {
        queryKey: ['recordings', 'recent'],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          recordingsApi.list({ limit: 5, sortBy: 'submittedAt', sortOrder: 'desc', signal }),
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
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          recordingsApi.list({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc', status: 'draft' as const, signal }),
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
  const qualityQuery = useQuery({
    queryKey: ['dashboard', 'quality', user?.organizationId, user?.id, user?.role],
    queryFn: ({ signal }) => qualityAnalyticsApi.getDashboardQuality({ signal }),
    enabled: canFetchQualityAnalytics,
  });
  const {
    data: qualityData,
    isError: isQualityError,
    isLoading: isQualityLoading,
    isStale: isQualityStale,
    refetch: refetchQuality,
  } = qualityQuery;
  const recordings = useMemo(() => data?.data ?? [], [data?.data]);
  const processingRecordingIds = useMemo(() => {
    return new Set(
      recordings
        .filter((r) => !['completed', 'failed', 'pending_metadata'].includes(r.status))
        .map((r) => r.id)
    );
  }, [recordings]);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const {
    localDrafts,
    draftResumeMap,
    refreshLocalDrafts,
    isStale: areLocalDraftsStale,
  } = useLocalDraftRecordings();
  const areLocalDraftsStaleRef = useRef(areLocalDraftsStale);
  const processingRecordingIdsRef = useRef<Set<string>>(new Set());
  const lastQualityRefetchAtRef = useRef(0);
  const trailingQualityRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRecordingIds = useMemo(
    () => new Set(recordings.map((r) => r.id)),
    [recordings]
  );

  useEffect(() => {
    areLocalDraftsStaleRef.current = areLocalDraftsStale;
  }, [areLocalDraftsStale]);

  // SOLE entry point for refreshing the quality dashboard. Every path — the
  // completion watcher below, focus refresh, pull-to-refresh, and the card's own
  // retry button — must go through here, because a trailing timer armed by one
  // path would otherwise fire moments after another path had already refetched,
  // recreating the duplicate dashboard request this throttle exists to prevent.
  const runQualityRefetch = useCallback(() => {
    if (trailingQualityRefetchRef.current) {
      clearTimeout(trailingQualityRefetchRef.current);
      trailingQualityRefetchRef.current = null;
    }
    lastQualityRefetchAtRef.current = Date.now();
    return refetchQuality();
  }, [refetchQuality]);

  useEffect(() => {
    // A row that was processing counts as finished only if it is STILL in the
    // list and has left the processing set — i.e. it genuinely reached a
    // terminal status. An id that merely vanished proves nothing: this list is
    // the top 5, so ordinary churn pushes rows out of the window, and the old
    // "absent means completed" test fired a redundant dashboard fetch every
    // time that happened. Production Sentry showed two /api/organization/dashboard
    // requests ~8s apart in a single window from exactly this.
    const finishedProcessing = [...processingRecordingIdsRef.current].some(
      (id) => visibleRecordingIds.has(id) && !processingRecordingIds.has(id)
    );
    processingRecordingIdsRef.current = processingRecordingIds;
    if (!canFetchQualityAnalytics || !finishedProcessing) return;

    const sinceLast = Date.now() - lastQualityRefetchAtRef.current;
    if (sinceLast >= QUALITY_REFETCH_MIN_INTERVAL_MS) {
      runQualityRefetch().catch(() => {});
      return;
    }

    // Inside the throttle window. The completion must be DEFERRED, not dropped:
    // the id has already been removed from `processingRecordingIdsRef` above, so
    // nothing would ever retry it and the quality summary would keep showing
    // pre-completion numbers until something else happened to refresh it.
    // One trailing timer covers every completion that lands in the window, and
    // any other refresh path cancels it via `runQualityRefetch`.
    if (trailingQualityRefetchRef.current) return;
    trailingQualityRefetchRef.current = setTimeout(() => {
      trailingQualityRefetchRef.current = null;
      runQualityRefetch().catch(() => {});
    }, QUALITY_REFETCH_MIN_INTERVAL_MS - sinceLast);
  }, [
    canFetchQualityAnalytics,
    processingRecordingIds,
    visibleRecordingIds,
    runQualityRefetch,
  ]);

  // Never leave a trailing refetch armed past unmount.
  useEffect(
    () => () => {
      if (trailingQualityRefetchRef.current) {
        clearTimeout(trailingQualityRefetchRef.current);
        trailingQualityRefetchRef.current = null;
      }
    },
    []
  );

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
  // Server total can exceed the merged 5-item list; show the larger count.
  const draftCount = Math.max(drafts.length, draftData?.pagination?.total ?? 0);
  // One worst-first pill in the Recent Recordings header replaces the two stat
  // tiles: "✓ All Complete" never counted `failed`, so it rendered beside failed
  // rows, and "Total Recordings" was a vanity number (home layout reorg, 2026-09-02).
  const statusPill = useMemo(
    () => deriveRecentStatusPill({ recordings, draftCount }),
    [recordings, draftCount]
  );
  const statusPillLabel =
    statusPill.kind === 'failed'
      ? HOME_COPY.statusPill.failed(statusPill.count)
      : statusPill.kind === 'processing'
        ? HOME_COPY.statusPill.processing(statusPill.count)
        : statusPill.kind === 'not_submitted'
          ? HOME_COPY.statusPill.notSubmitted(statusPill.count)
          : HOME_COPY.statusPill.allComplete;

  const ctaAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaScale.value }],
  }));

  const handleRefresh = useCallback(() => {
    if (canLoadServerData) {
      refetch().catch(() => {});
      refetchDrafts().catch(() => {});
    }
    if (canFetchQualityAnalytics) {
      runQualityRefetch().catch(() => {});
    }
    refreshLocalDrafts({ forceReconcile: true });
    // Void wrappers — pull-to-refresh must never receive a Promise (rule 2).
    refreshAttention();
    refreshSupportRecovery();
  }, [
    canFetchQualityAnalytics,
    canLoadServerData,
    refetch,
    refetchDrafts,
    runQualityRefetch,
    refreshAttention,
    refreshLocalDrafts,
    refreshSupportRecovery,
  ]);

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
    const qualityStale = canFetchQualityAnalytics && isQualityStale;
    const staleServerSourceCount =
      Number(canLoadServerData && recordingsQuery.isStale) +
      Number(canLoadServerData && draftsQuery.isStale) +
      Number(qualityStale);
    const localDraftsStale = areLocalDraftsStaleRef.current;
    measurePhase('home_focus_refresh', {
      recordings_stale: canLoadServerData && recordingsQuery.isStale,
      server_drafts_stale: canLoadServerData && draftsQuery.isStale,
      quality_stale: qualityStale,
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
      if (qualityStale) {
        runQualityRefetch().catch(() => {});
      }
      refreshLocalDrafts();
      refreshSupportRecovery();
    });
  }, [
    canFetchQualityAnalytics,
    canLoadServerData,
    draftsQuery.isStale,
    isQualityStale,
    recordingsQuery.isStale,
    refetch,
    refetchDrafts,
    runQualityRefetch,
    refreshLocalDrafts,
    refreshSupportRecovery,
  ]);

  useFocusEffect(handleFocusRefresh);

  return (
    <ScreenContainer ref={scrollRef} refreshing={isRefetching} onRefresh={handleRefresh}>
      {/* Header — one row (wordmark · greeting · gear) plus a caption. The old
          three-line stack spent ~12% of the first viewport before any content
          (home layout reorg, 2026-09-02). */}
      <View className="mb-4">
        <View className="flex-row items-center">
          <Image
            source={require('../../../assets/logo-wordmark.png')}
            style={{ width: Math.min(scale(104), 132), aspectRatio: 600 / 139, flexShrink: 0 }}
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel="Captivet"
          />
          {/* flex-1 — a row child; without real width Android "Bold text" drops
              the name after "Welcome," (CLAUDE.md > UI Gotchas). */}
          <Text
            className="text-heading font-bold text-content-primary flex-1 ml-3"
            numberOfLines={1}
            accessibilityRole="header"
          >
            Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
          </Text>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              router.push('/settings');
            }}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            className="p-2 -mr-2"
            hitSlop={8}
          >
            <Settings color={colors.contentTertiary} size={iconMd} />
          </Pressable>
        </View>
        {/* The practice name is the tenant confirmation on a shared clinic
            tablet; the static tagline is the fallback until /auth/me lands. */}
        <Text className="text-caption text-content-tertiary mt-1" numberOfLines={1}>
          {user?.organizationName || 'Record appointments and generate SOAP notes'}
        </Text>
      </View>

      {/* In-page alerts, one at a time by priority (recovery > device limit >
          provider issue) with a "+N more" expander — five uncoordinated
          banners used to push the hero Record CTA below the fold (WP30). */}
      {visibleBannerKeys.includes('recovery') && <DurableRecoveryBanner />}

      {visibleBannerKeys.includes('supportRecovery') ? (
        <View className="mb-4">
          <Banner
            variant={supportRecovery.state === 'unknown' ? 'warning' : 'info'}
            icon={LifeBuoy}
            message={
              supportRecovery.state === 'unknown'
                ? SUPPORT_RECOVERY_BANNER_COPY.unknownMessage
                : SUPPORT_RECOVERY_BANNER_COPY.message(supportRecovery.count)
            }
            cta={
              supportRecovery.state === 'unknown'
                ? {
                    label: SUPPORT_RECOVERY_BANNER_COPY.retry,
                    onPress: () => {
                      Haptics.selectionAsync().catch(() => {});
                      supportRecovery.refresh();
                    },
                  }
                : {
                    label: SUPPORT_RECOVERY_BANNER_COPY.cta,
                    onPress: () => {
                      Haptics.selectionAsync().catch(() => {});
                      router.push('/recording-recovery' as never);
                    },
                  }
            }
          />
        </View>
      ) : null}

      {visibleBannerKeys.includes('deviceLimit') && capacity ? (
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

      {visibleBannerKeys.includes('providerIssue') && (
        <ProviderIssueBannerContent location="home" issue={activeProviderIssue} />
      )}

      {hiddenBannerCount > 0 && (
        <Pressable
          onPress={() => setBannersExpanded(true)}
          accessibilityRole="button"
          accessibilityLabel={`Show ${hiddenBannerCount} more alert${hiddenBannerCount > 1 ? 's' : ''}`}
          className="mb-4 rounded-xl border border-border-default bg-surface-raised px-4 py-2.5 items-center"
        >
          {/* w-full — the Pressable is items-center, so the label shrink-wraps and
              Android "Bold text" drops "alerts", leaving "+3 more" (CLAUDE.md >
              UI Gotchas). accessibilityLabel above stays unpadded. */}
          <Text className="text-body-sm font-medium text-content-secondary text-center w-full">
            {`+${hiddenBannerCount} more alert${hiddenBannerCount > 1 ? 's' : ''}`}
          </Text>
        </Pressable>
      )}

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

      {/* NEEDS ATTENTION \u2014 directly under the Record CTA: the CTA is the one
          thing every visit starts with, so it stays inside the first viewport
          (the section used to push it to the fold \u2014 home layout reorg,
          2026-09-02); below the banner stack because those banners are about the
          app being broken (data loss, device blocked), which outranks data
          hygiene. Never gates Home: it renders its own bounded state and Home
          stays usable if its queries or a native local read hang (rule 24). */}
      {showAttentionSection ? <AttentionFeedSection feed={attentionFeed} /> : null}

      {/* Recent Recordings */}
      {drafts.length > 0 ? (
        <View className="mb-6">
          <View className="flex-row justify-between items-center mb-3">
            {/* flex-1 — sole child of a justify-between row, so it shrink-wraps.
                "Not Submitted" losing its second word inverts the meaning of the
                section heading over un-uploaded work (CLAUDE.md > UI Gotchas). */}
            <Text className="section-title flex-1" numberOfLines={1}>Not Submitted</Text>
          </View>
          {drafts.map((recording) => (
            <View key={recording.id}>
              <RecordingCard recording={recording} localDraftSlotId={draftResumeMap[recording.id]} />
            </View>
          ))}
        </View>
      ) : null}

      <View className="mb-8">
        <View className="mb-3">
          <View className="flex-row justify-between items-center">
            {/* flex-1 — the "View All" sibling already carries headroom; this header did
                not, so Bold text dropped "Recordings" (CLAUDE.md > UI Gotchas). */}
            <Text className="section-title flex-1 mr-2" numberOfLines={1}>Recent Recordings</Text>
            {totalRecordings > 5 && (
              <Pressable
                onPress={() => router.push('/recordings')}
                accessibilityRole="link"
                accessibilityLabel="View all recordings"
                hitSlop={HIT_SLOP}
                style={{ minHeight: 32, justifyContent: 'center' }}
              >
                {/* Trailing space + flexShrink:0 — Android under-measures short Text in flex-rows and clips the last glyph; do NOT remove. */}
                <Text className="text-body-sm text-brand-500 font-medium" style={CLIP_SAFE}>
                  {clipSafe('View All')}
                </Text>
              </Pressable>
            )}
          </View>
          {/* Status pill on its own row: beside the title it squeezed "Recent
              Recordings" into "Recent Recordi…" at 1.3× font scale. The flex-row
              wrapper keeps the Badge shrink-wrapped (it bakes in clipSafe +
              CLIP_SAFE + numberOfLines={1}) instead of stretching full width. */}
          {!isLoading ? (
            <View className="flex-row mt-1.5">
              <Badge variant={statusPill.variant} accessibilityLabel={statusPillLabel}>
                {statusPillLabel}
              </Badge>
            </View>
          ) : null}
        </View>

        {isLoading ? (
          <View>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : isError && recordings.length === 0 ? (
          // Only replace the list with the error card when there is NO cached
          // data. A persisted list hydrated offline keeps isError=true after
          // the background refetch fails; showing the error card then would
          // hide the usable cache on the default landing screen (Codex P2,
          // PR #143).
          <Card className="items-center py-6">
            <FileText color={colors.danger600} size={iconLg} />
            <Text className="text-body text-content-secondary mt-3 text-center">
              Could not load recordings.
            </Text>
            {error ? (
              <Text className="text-caption text-content-tertiary mt-2 text-center px-4">
                {friendlyErrorMessage(error, 'load')}
              </Text>
            ) : null}
            <View className="mt-3 flex-row gap-2">
              <Button variant="secondary" size="sm" onPress={handleRefresh}>
                Retry
              </Button>
              {error ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    // Raw detail goes to the clipboard for support, never on screen.
                    copyWithAutoClear(technicalErrorDetails(error)).catch(() => {});
                  }}
                >
                  {ERROR_COPY.copyDetails}
                </Button>
              ) : null}
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
              <RecordingCard
                recording={recording}
                localDraftSlotId={draftResumeMap[recording.id]}
                hideStatusBadge={recording.status === 'completed'}
              />
            </View>
          ))
        )}
      </View>

      {/* Recent patient — an AI history summary is context, not work, so it sits
          below the recordings it was derived from (home layout reorg, 2026-09-02). */}
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

      {canFetchQualityAnalytics ? (
        <View className="mb-8">
          <QualityAnalyticsCard
            data={qualityData}
            isLoading={isQualityLoading}
            isError={isQualityError}
            refetch={runQualityRefetch}
            role={user?.role}
          />
        </View>
      ) : null}
    </ScreenContainer>
  );
}

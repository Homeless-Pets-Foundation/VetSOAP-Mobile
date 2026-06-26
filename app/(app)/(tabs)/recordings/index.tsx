import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Alert, View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { recordingsApi } from '../../../../src/api/recordings';
import {
  mergeDraftRecordings,
  sortRecordingsByCreatedAt,
} from '../../../../src/lib/draftRecordings';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../../src/lib/recordingPermissions';
import { useAuthUser } from '../../../../src/hooks/useAuth';
import { useLocalDraftRecordings } from '../../../../src/hooks/useLocalDraftRecordings';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { RecordingCard } from '../../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { EmptyState } from '../../../../src/components/ui/EmptyState';
import { Select } from '../../../../src/components/ui/Select';
import { getRecordingReviewStatus } from '../../../../src/lib/recordingReview';
import { measurePhase } from '../../../../src/lib/monitoring';

const PAGE_SIZE = 20;
const FLATLIST_CONTENT_STYLE = { paddingHorizontal: 20, paddingBottom: 20 } as const;
const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Not Submitted' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
] as const;
const NEEDS_REVIEW_STATUS_FILTER_OPTION = { value: 'needs_review', label: 'Needs Review' } as const;

type StatusFilterValue =
  | typeof STATUS_FILTER_OPTIONS[number]['value']
  | typeof NEEDS_REVIEW_STATUS_FILTER_OPTION['value'];

export default function RecordingsListScreen() {
  const router = useRouter();
  const user = useAuthUser();
  const colors = useThemeColors();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<StatusFilterValue>('all');
  const isTabFocused = useIsFocused();
  const shouldLoadRecordings = !!user && selectedStatusFilter !== 'draft';
  const shouldLoadDrafts = !!user && (selectedStatusFilter === 'all' || selectedStatusFilter === 'draft');
  const serverStatusFilter =
    selectedStatusFilter === 'failed' || selectedStatusFilter === 'completed'
      ? selectedStatusFilter
      : selectedStatusFilter === 'needs_review'
        ? 'completed'
        : undefined;
  const reviewStatusFilter = selectedStatusFilter === 'needs_review' ? 'needs_review' : undefined;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data,
    error,
    isLoading,
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isStale,
  } = useInfiniteQuery({
    queryKey: ['recordings', 'list', debouncedSearch, serverStatusFilter ?? 'all', reviewStatusFilter ?? 'any', 'desc'],
    queryFn: ({ pageParam = 1 }) =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        ...(serverStatusFilter ? { status: serverStatusFilter } : {}),
        ...(reviewStatusFilter ? { reviewStatus: reviewStatusFilter } : {}),
      }),
    initialPageParam: 1,
    enabled: shouldLoadRecordings,
    getNextPageParam: (lastPage) => {
      if (!lastPage.pagination) return undefined;
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
    refetchInterval: (query) => {
      // Pause polling when the tab is not focused — other mounted tabs
      // (home, detail) would otherwise compound into the same rate-limit budget.
      if (!isTabFocused || serverStatusFilter) return false;
      const allRecordings = query.state.data?.pages.flatMap((p) => p.data);
      const hasProcessing = allRecordings?.some(
        (r) => !['completed', 'failed', 'pending_metadata'].includes(r.status)
      );
      return hasProcessing ? 10000 : false;
    },
  });

  const recordings = useMemo(
    () => sortRecordingsByCreatedAt(data?.pages.flatMap((page) => page.data) ?? [], 'desc'),
    [data]
  );
  const hasReviewStatusInLoadedRecordings = useMemo(
    () => recordings.some((recording) => getRecordingReviewStatus(recording) !== null),
    [recordings]
  );
  const statusFilterOptions = useMemo(
    () => (
      hasReviewStatusInLoadedRecordings || selectedStatusFilter === 'needs_review'
        ? [
            STATUS_FILTER_OPTIONS[0],
            STATUS_FILTER_OPTIONS[1],
            NEEDS_REVIEW_STATUS_FILTER_OPTION,
            STATUS_FILTER_OPTIONS[2],
            STATUS_FILTER_OPTIONS[3],
          ]
        : STATUS_FILTER_OPTIONS
    ),
    [hasReviewStatusInLoadedRecordings, selectedStatusFilter]
  );
  const activeStatusFilterLabel = statusFilterOptions.find(
    (option) => option.value === selectedStatusFilter
  )?.label ?? 'All';

  const {
    data: draftData,
    error: draftError,
    isLoading: isDraftLoading,
    isError: isDraftError,
    refetch: refetchDrafts,
    isRefetching: isDraftRefetching,
    isStale: isDraftStale,
  } = useQuery({
    queryKey: ['recordings', 'drafts', 'list', debouncedSearch, 'desc'],
    queryFn: () =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        status: 'draft',
        page: 1,
        limit: PAGE_SIZE,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
    enabled: shouldLoadDrafts,
  });

  const {
    localDrafts,
    draftResumeMap,
    refreshLocalDrafts,
    isStale: areLocalDraftsStale,
  } = useLocalDraftRecordings();
  const filteredLocalDrafts = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return localDrafts;
    return localDrafts.filter((draft) =>
      [draft.formData.patientName, draft.formData.clientName]
        .some((value) => value?.toLowerCase().includes(query))
    );
  }, [localDrafts, debouncedSearch]);
  const mergedDrafts = useMemo(() => {
    if (!user) return [];
    return mergeDraftRecordings(
      filteredLocalDrafts,
      draftData?.data ?? [],
      user.id,
      user.organizationId,
      'desc'
    );
  }, [draftData?.data, filteredLocalDrafts, user]);
  const displayRecordings = useMemo(() => {
    if (selectedStatusFilter === 'draft') return mergedDrafts;
    if (selectedStatusFilter === 'needs_review') {
      return recordings.filter((recording) => getRecordingReviewStatus(recording) === 'needs_review');
    }
    if (selectedStatusFilter === 'all') {
      const combined = new Map<string, (typeof recordings)[number]>();

      for (const recording of mergedDrafts) {
        combined.set(recording.id, recording);
      }
      for (const recording of recordings) {
        combined.set(recording.id, recording);
      }

      return sortRecordingsByCreatedAt(Array.from(combined.values()), 'desc');
    }
    return recordings;
  }, [mergedDrafts, recordings, selectedStatusFilter]);
  const keyExtractor = useCallback((item: { id: string }) => item.id, []);
  const handleRefresh = useCallback(() => {
    if (shouldLoadRecordings) {
      refetch().catch(() => {});
    }
    if (shouldLoadDrafts) {
      refetchDrafts().catch(() => {});
    }
    refreshLocalDrafts({ forceReconcile: true });
  }, [refetch, refetchDrafts, refreshLocalDrafts, shouldLoadDrafts, shouldLoadRecordings]);

  const handleFocusRefresh = useCallback(() => {
    const shouldRefetchRecordings = shouldLoadRecordings && isStale;
    const shouldRefetchDrafts = shouldLoadDrafts && isDraftStale;
    const shouldRefetchLocalDrafts = shouldLoadDrafts && areLocalDraftsStale;
    const staleSourceCount =
      Number(shouldRefetchRecordings) +
      Number(shouldRefetchDrafts) +
      Number(shouldRefetchLocalDrafts);
    measurePhase('records_focus_refresh', {
      recordings_stale: shouldRefetchRecordings,
      server_drafts_stale: shouldRefetchDrafts,
      local_drafts_stale: shouldRefetchLocalDrafts,
      skipped: staleSourceCount === 0,
      count: staleSourceCount,
    }, () => {
      if (shouldRefetchRecordings) {
        refetch().catch(() => {});
      }
      if (shouldRefetchDrafts) {
        refetchDrafts().catch(() => {});
      }
      if (shouldRefetchLocalDrafts) {
        refreshLocalDrafts();
      }
    });
  }, [
    areLocalDraftsStale,
    isDraftStale,
    isStale,
    refetch,
    refetchDrafts,
    refreshLocalDrafts,
    shouldLoadDrafts,
    shouldLoadRecordings,
  ]);

  useFocusEffect(handleFocusRefresh);

  const onEndReached = useCallback(() => {
    if (shouldLoadRecordings && hasNextPage && !isFetchingNextPage) {
      fetchNextPage().catch(() => {});
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, shouldLoadRecordings]);

  const handleRecordPress = useCallback(() => {
    if (!canRecordAppointments(user?.role)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(RECORD_APPOINTMENT_PERMISSION_TITLE, RECORD_APPOINTMENT_PERMISSION_MESSAGE);
      return;
    }

    router.push('/record');
  }, [router, user?.role]);

  const isListLoading = selectedStatusFilter === 'draft'
    ? isDraftLoading
    : selectedStatusFilter === 'all'
      ? isLoading || isDraftLoading
      : isLoading;
  const isListError = selectedStatusFilter === 'draft' ? isDraftError : isError;
  const listError = selectedStatusFilter === 'draft' ? draftError : error;
  const isListRefetching = selectedStatusFilter === 'draft'
    ? isDraftRefetching
    : selectedStatusFilter === 'all'
      ? isRefetching || isDraftRefetching
      : isRefetching;
  const emptyMessage = debouncedSearch
    ? selectedStatusFilter === 'all'
      ? 'No recordings match your search.'
      : 'No recordings match your search and filter.'
    : selectedStatusFilter === 'all'
      ? 'No recordings yet.'
      : selectedStatusFilter === 'needs_review'
        ? 'No recordings need review.'
      : 'No recordings match this filter.';

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
      <View className="px-5 pt-5 pb-0">
        <Text
          className="text-display font-bold text-content-primary mb-4"
          accessibilityRole="header"
        >
          Recordings
        </Text>

        <View className="flex-row items-center gap-2 mb-4">
          {/* Search */}
          <View
            className={`flex-1 flex-row items-center bg-surface-raised border rounded-input px-3 ${
              isFocused ? 'border-brand-500' : 'border-border-strong'
            }`}
          >
            <Search color={colors.contentTertiary} size={iconSm} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Search by patient name..."
              placeholderTextColor={colors.contentTertiary}
              accessibilityLabel="Search recordings by patient name"
              className="flex-1 p-3 text-body text-content-primary"
            />
          </View>

          <Select
            options={statusFilterOptions}
            value={selectedStatusFilter}
            onValueChange={(value) => setSelectedStatusFilter(value)}
            placeholder="Status"
            accessibilityLabel={`Filter recordings by status. Current filter ${activeStatusFilterLabel}`}
            sheetTitle="Filter by status"
            className="w-[150px]"
            fieldClassName={selectedStatusFilter !== 'all' ? 'border-brand-500 bg-brand-50 dark:bg-surface-sunken' : ''}
          />
        </View>
      </View>

      <FlatList
        data={displayRecordings}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => (
          <RecordingCard recording={item} localDraftSlotId={draftResumeMap[item.id]} />
        )}
        contentContainerStyle={FLATLIST_CONTENT_STYLE}
        refreshControl={<RefreshControl refreshing={isListRefetching} onRefresh={handleRefresh} />}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.8}
        removeClippedSubviews={true}
        maxToRenderPerBatch={5}
        windowSize={7}
        initialNumToRender={8}
        ListFooterComponent={
          shouldLoadRecordings && isFetchingNextPage ? (
            <View className="py-4 items-center">
              <ActivityIndicator size="small" color={colors.brand500} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isListLoading ? (
            <View>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </View>
          ) : isListError ? (
            <EmptyState
              icon={Search}
              iconColor={colors.danger600}
              iconSize={iconLg}
              description="Could not load recordings."
              details={
                listError ? (
                  <Text className="text-caption text-content-tertiary text-center px-4" selectable>
                    [{listError.name ?? 'Error'}{(listError as { status?: number })?.status ? ` ${(listError as { status?: number }).status}` : ''}] {listError.message}
                  </Text>
                ) : undefined
              }
              action={{
                label: 'Retry',
                variant: 'secondary',
                onPress: handleRefresh,
              }}
            />
          ) : (
            (() => {
              // True empty (no search/filter) gets warm brand-toned copy; a
              // filtered/search miss keeps the neutral Search affordance.
              const isTrueEmpty = !debouncedSearch && selectedStatusFilter === 'all';
              return (
                <EmptyState
                  icon={isTrueEmpty ? Mic : Search}
                  iconColor={isTrueEmpty ? colors.brand500 : undefined}
                  iconSize={iconLg}
                  title={isTrueEmpty ? 'Your patients are waiting' : undefined}
                  description={isTrueEmpty ? 'Tap Record to start your first SOAP note.' : emptyMessage}
                  action={isTrueEmpty ? {
                    label: 'Record Appointment',
                    onPress: handleRecordPress,
                  } : undefined}
                />
              );
            })()
          )
        }
      />
      </View>
    </SafeAreaView>
  );
}

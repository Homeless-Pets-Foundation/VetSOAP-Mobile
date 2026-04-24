import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { Search } from 'lucide-react-native';
import { recordingsApi } from '../../../../src/api/recordings';
import { ApiError } from '../../../../src/api/client';
import { draftStorage } from '../../../../src/lib/draftStorage';
import {
  buildDraftResumeMap,
  mergeDraftRecordings,
  sortRecordingsByCreatedAt,
} from '../../../../src/lib/draftRecordings';
import { useAuth } from '../../../../src/hooks/useAuth';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { RecordingCard } from '../../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { EmptyState } from '../../../../src/components/ui/EmptyState';
import { Select } from '../../../../src/components/ui/Select';

const PAGE_SIZE = 20;
const FLATLIST_CONTENT_STYLE = { paddingHorizontal: 20, paddingBottom: 20 } as const;
const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Not Submitted' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
] as const;

type StatusFilterValue = typeof STATUS_FILTER_OPTIONS[number]['value'];

export default function RecordingsListScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<StatusFilterValue>('all');
  const isInitialMountRef = useRef(true);
  const isTabFocused = useIsFocused();
  const shouldLoadRecordings = !!user && selectedStatusFilter !== 'draft';
  const shouldLoadDrafts = !!user && (selectedStatusFilter === 'all' || selectedStatusFilter === 'draft');
  const serverStatusFilter = selectedStatusFilter === 'failed' || selectedStatusFilter === 'completed'
    ? selectedStatusFilter
    : undefined;
  const activeStatusFilterLabel = STATUS_FILTER_OPTIONS.find(
    (option) => option.value === selectedStatusFilter
  )?.label ?? 'All';

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
  } = useInfiniteQuery({
    queryKey: ['recordings', 'list', debouncedSearch, serverStatusFilter ?? 'all', 'desc'],
    queryFn: ({ pageParam = 1 }) =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        ...(serverStatusFilter ? { status: serverStatusFilter } : {}),
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

  const {
    data: draftData,
    error: draftError,
    isLoading: isDraftLoading,
    isError: isDraftError,
    refetch: refetchDrafts,
    isRefetching: isDraftRefetching,
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

  const [localDrafts, setLocalDrafts] = useState<Awaited<ReturnType<typeof draftStorage.listDrafts>>>([]);
  const refreshLocalDrafts = useCallback(() => {
    draftStorage
      .reconcileMissingServerDrafts(async (serverDraftId) => {
        try {
          const recording = await recordingsApi.get(serverDraftId);
          return recording.status === 'draft' ? 'present' : 'unknown';
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            return 'missing';
          }
          return 'unknown';
        }
      })
      .then(() => draftStorage.listDrafts())
      .then(setLocalDrafts)
      .catch(() => {
        setLocalDrafts([]);
      });
  }, []);

  const draftResumeMap = useMemo(
    () => buildDraftResumeMap(localDrafts),
    [localDrafts]
  );
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
    refreshLocalDrafts();
  }, [refetch, refetchDrafts, refreshLocalDrafts, shouldLoadDrafts, shouldLoadRecordings]);

  // Refresh on every screen focus — required so drafts created or deleted on
  // another device reconcile before this list renders from cached data.
  useFocusEffect(handleRefresh);

  const onEndReached = useCallback(() => {
    if (shouldLoadRecordings && hasNextPage && !isFetchingNextPage) {
      fetchNextPage().catch(() => {});
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, shouldLoadRecordings]);

  // Disable entry animations after initial data load
  useEffect(() => {
    if ((data || draftData) && isInitialMountRef.current) {
      isInitialMountRef.current = false;
    }
  }, [data, draftData]);

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
      : 'No recordings match this filter.';

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
      <View className="px-5 pt-5 pb-0">
        <Text
          className="text-display font-bold text-stone-900 mb-4"
          accessibilityRole="header"
        >
          Recordings
        </Text>

        <View className="flex-row items-center gap-2 mb-4">
          {/* Search */}
          <View
            className={`flex-1 flex-row items-center bg-white border rounded-input px-3 ${
              isFocused ? 'border-brand-500' : 'border-stone-300'
            }`}
          >
            <Search color="#78716c" size={iconSm} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Search by patient name..."
              placeholderTextColor="#78716c"
              accessibilityLabel="Search recordings by patient name"
              className="flex-1 p-3 text-body text-stone-900"
            />
          </View>

          <Select
            options={STATUS_FILTER_OPTIONS}
            value={selectedStatusFilter}
            onValueChange={(value) => setSelectedStatusFilter(value)}
            placeholder="Status"
            accessibilityLabel={`Filter recordings by status. Current filter ${activeStatusFilterLabel}`}
            sheetTitle="Filter by status"
            className="w-[150px]"
            fieldClassName={selectedStatusFilter !== 'all' ? 'border-brand-500 bg-brand-50' : ''}
          />
        </View>
      </View>

      <FlatList
        data={displayRecordings}
        keyExtractor={keyExtractor}
        renderItem={({ item, index }) => {
          if (isInitialMountRef.current && index < 3) {
            return (
              <Animated.View entering={FadeInRight.delay(index * 50).duration(250)}>
                <RecordingCard recording={item} localDraftSlotId={draftResumeMap[item.id]} />
              </Animated.View>
            );
          }
          return <RecordingCard recording={item} localDraftSlotId={draftResumeMap[item.id]} />;
        }}
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
              <ActivityIndicator size="small" color="#0d8775" />
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
              iconColor="#dc2626"
              iconSize={iconLg}
              description="Could not load recordings."
              details={
                listError ? (
                  <Text className="text-caption text-stone-500 text-center px-4" selectable>
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
            <EmptyState
              icon={Search}
              iconSize={iconLg}
              description={emptyMessage}
              action={!debouncedSearch && selectedStatusFilter === 'all' ? {
                label: 'Record Appointment',
                onPress: () => router.push('/record'),
              } : undefined}
            />
          )
        }
      />
      </View>
    </SafeAreaView>
  );
}

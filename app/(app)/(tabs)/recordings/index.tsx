import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Alert, View, Text, TextInput, FlatList, Platform, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { Search, Mic, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { recordingsApi } from '../../../../src/api/recordings';
import {
  mergeDraftRecordings,
  sortRecordingsBySubmittedAt,
} from '../../../../src/lib/draftRecordings';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../../src/lib/recordingPermissions';
import { useAuthDeviceRegistration, useAuthUser } from '../../../../src/hooks/useAuth';
import { useLocalDraftRecordings } from '../../../../src/hooks/useLocalDraftRecordings';
import { useRetryableInitialLoadError } from '../../../../src/hooks/useRetryableInitialLoadError';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { RecordingCard } from '../../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { EmptyState } from '../../../../src/components/ui/EmptyState';
import { Select } from '../../../../src/components/ui/Select';
import { getRecordingReviewStatus } from '../../../../src/lib/recordingReview';
import { displayPatientName } from '../../../../src/lib/recordingDisplay';
import { StatusBadge } from '../../../../src/components/StatusBadge';
import { RECORDINGS_LIST_COPY, SUBMITTED_BANNER_COPY } from '../../../../src/constants/strings';
import { PERSIST_GC_TIME_MS } from '../../../../src/lib/queryPersistence';
import { measurePhase } from '../../../../src/lib/monitoring';
import type { Recording } from '../../../../src/types';

const PAGE_SIZE = 20;
const MAX_SUBMITTED_IDS = 10;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function normalizeSubmittedIdsParam(submittedIdsParam: string | string[] | undefined): string[] {
  const raw = Array.isArray(submittedIdsParam) ? submittedIdsParam[0] : submittedIdsParam;
  if (!raw) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw.split(',')) {
    const id = value.trim().toLowerCase();
    if (!UUID_REGEX.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SUBMITTED_IDS) break;
  }
  return ids;
}

function recordingMatchesStatusFilter(recording: Recording, selectedStatusFilter: StatusFilterValue): boolean {
  if (selectedStatusFilter === 'all') return true;
  if (selectedStatusFilter === 'draft') return recording.status === 'draft';
  if (selectedStatusFilter === 'needs_review') {
    return getRecordingReviewStatus(recording) === 'needs_review';
  }
  return recording.status === selectedStatusFilter;
}

function recordingMatchesSearch(recording: Recording, searchQuery: string): boolean {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return [recording.patientName, recording.clientName].some((value) =>
    value?.toLowerCase().includes(query)
  );
}

export default function RecordingsListScreen() {
  const router = useRouter();
  const { submittedIds: submittedIdsParam } = useLocalSearchParams<{ submittedIds?: string | string[] }>();
  const user = useAuthUser();
  const colors = useThemeColors();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<StatusFilterValue>('all');
  const isTabFocused = useIsFocused();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock;
  const shouldLoadRecordings = canLoadServerData && selectedStatusFilter !== 'draft';
  const shouldLoadDrafts = canLoadServerData && (selectedStatusFilter === 'all' || selectedStatusFilter === 'draft');
  const serverStatusFilter =
    selectedStatusFilter === 'failed' || selectedStatusFilter === 'completed'
      ? selectedStatusFilter
      : selectedStatusFilter === 'needs_review'
        ? 'completed'
        : undefined;
  const reviewStatusFilter = selectedStatusFilter === 'needs_review' ? 'needs_review' : undefined;
  const submittedIds = useMemo(() => normalizeSubmittedIdsParam(submittedIdsParam), [submittedIdsParam]);
  const submittedIdSet = useMemo(() => new Set(submittedIds), [submittedIds]);

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
    queryKey: ['recordings', 'list', debouncedSearch, serverStatusFilter ?? 'all', reviewStatusFilter ?? 'any', 'submittedAt-desc'],
    // Survives into the persisted offline snapshot (WP28).
    gcTime: PERSIST_GC_TIME_MS,
    queryFn: ({ pageParam = 1 }) =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'submittedAt',
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
    () => sortRecordingsBySubmittedAt(data?.pages.flatMap((page) => page.data) ?? [], 'desc'),
    [data]
  );
  const listedRecordingIds = useMemo(() => new Set(recordings.map((r) => r.id)), [recordings]);
  const submittedRecordingQueries = useQueries({
    queries: submittedIds.map((id) => ({
      queryKey: ['recording', id],
      queryFn: () => recordingsApi.get(id),
      enabled: canLoadServerData && submittedIds.length > 0,
      staleTime: 0,
      refetchOnMount: 'always' as const,
      // When a search/status filter excludes a submitted id from the polled
      // list, this detail query becomes the banner's only data source — and
      // a fetch-once query would freeze it at Uploading/Transcribing. Poll
      // while it's still processing AND the list doesn't cover it; the list's
      // own 10s polling is authoritative otherwise (Codex P2, PR #143).
      refetchInterval: (query: { state: { data?: { id?: string; status?: string } } }) => {
        if (!isTabFocused) return false;
        const rec = query.state.data;
        if (!rec?.id || listedRecordingIds.has(rec.id)) return false;
        const processing = !['completed', 'failed', 'pending_metadata'].includes(rec.status ?? '');
        return processing ? 10000 : false;
      },
    })),
  });
  const submittedRecordingsById = useMemo(() => {
    const map = new Map<string, (typeof recordings)[number]>();
    for (const recording of recordings) {
      if (submittedIdSet.has(recording.id) && !map.has(recording.id)) {
        map.set(recording.id, recording);
      }
    }
    for (const query of submittedRecordingQueries) {
      const recording = query.data;
      // Fallback ONLY for ids the polled list doesn't contain yet: the list
      // refetches processing recordings every 10s while these detail queries
      // fetch once on mount, so letting the detail result win froze banner
      // rows at their initial Uploading/Transcribing state (Codex P2, PR #143).
      if (recording?.id && submittedIdSet.has(recording.id) && !map.has(recording.id)) {
        map.set(recording.id, recording);
      }
    }
    return map;
  }, [recordings, submittedIdSet, submittedRecordingQueries]);
  // Always offer Needs Review: gating it on the loaded pages made the filter
  // menu's contents shift as pagination progressed (an option a vet saw
  // yesterday could vanish today).
  const statusFilterOptions = useMemo(
    () => [
      STATUS_FILTER_OPTIONS[0],
      STATUS_FILTER_OPTIONS[1],
      NEEDS_REVIEW_STATUS_FILTER_OPTION,
      STATUS_FILTER_OPTIONS[2],
      STATUS_FILTER_OPTIONS[3],
    ],
    []
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
  const areLocalDraftsStaleRef = useRef(areLocalDraftsStale);

  useEffect(() => {
    areLocalDraftsStaleRef.current = areLocalDraftsStale;
  }, [areLocalDraftsStale]);

  const recordingsRetryKey = [
    debouncedSearch || 'none',
    serverStatusFilter ?? 'all',
    reviewStatusFilter ?? 'any',
  ].join(':');
  const draftsRetryKey = [debouncedSearch || 'none', 'draft'].join(':');

  useRetryableInitialLoadError({
    screen: 'records',
    source: 'recordings',
    retryKey: recordingsRetryKey,
    enabled: shouldLoadRecordings,
    isError,
    error,
    hasData: (data?.pages.length ?? 0) > 0,
    refetch,
  });
  useRetryableInitialLoadError({
    screen: 'records',
    source: 'drafts',
    retryKey: draftsRetryKey,
    enabled: shouldLoadDrafts,
    isError: isDraftError,
    error: draftError,
    hasData: !!draftData,
    refetch: refetchDrafts,
  });
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
    const pinSubmitted = (items: Recording[]): Recording[] => {
      if (submittedIds.length === 0 || selectedStatusFilter === 'draft') return items;
      const pinned = submittedIds
        .map((id) => submittedRecordingsById.get(id))
        .filter((recording): recording is Recording =>
          !!recording &&
          recordingMatchesStatusFilter(recording, selectedStatusFilter) &&
          recordingMatchesSearch(recording, debouncedSearch)
        );
      if (pinned.length === 0) return items;
      const rest = items.filter((recording) => !submittedIdSet.has(recording.id));
      return [...pinned, ...rest];
    };

    if (selectedStatusFilter === 'draft') return mergedDrafts;
    if (selectedStatusFilter === 'needs_review') {
      return pinSubmitted(recordings.filter((recording) => getRecordingReviewStatus(recording) === 'needs_review'));
    }
    if (selectedStatusFilter === 'all') {
      const combined = new Map<string, (typeof recordings)[number]>();

      for (const recording of mergedDrafts) {
        combined.set(recording.id, recording);
      }
      for (const recording of recordings) {
        combined.set(recording.id, recording);
      }

      return pinSubmitted(sortRecordingsBySubmittedAt(Array.from(combined.values()), 'desc'));
    }
    return pinSubmitted(recordings);
  }, [debouncedSearch, mergedDrafts, recordings, selectedStatusFilter, submittedIds, submittedIdSet, submittedRecordingsById]);
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
    const shouldRefreshLocalDrafts = shouldLoadDrafts;
    const localDraftsStale = areLocalDraftsStaleRef.current;
    const staleSourceCount =
      Number(shouldRefetchRecordings) +
      Number(shouldRefetchDrafts) +
      Number(shouldRefreshLocalDrafts);
    measurePhase('records_focus_refresh', {
      recordings_stale: shouldRefetchRecordings,
      server_drafts_stale: shouldRefetchDrafts,
      local_drafts_stale: localDraftsStale,
      local_drafts_refreshed: shouldRefreshLocalDrafts,
      skipped: !shouldRefetchRecordings && !shouldRefetchDrafts && !shouldRefreshLocalDrafts,
      count: staleSourceCount,
    }, () => {
      if (shouldRefetchRecordings) {
        refetch().catch(() => {});
      }
      if (shouldRefetchDrafts) {
        refetchDrafts().catch(() => {});
      }
      if (shouldRefreshLocalDrafts) {
        refreshLocalDrafts();
      }
    });
  }, [
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
              placeholder={RECORDINGS_LIST_COPY.searchPlaceholder}
              placeholderTextColor={colors.contentTertiary}
              accessibilityLabel={RECORDINGS_LIST_COPY.searchAccessibilityLabel}
              className="flex-1 p-3 text-body text-content-primary"
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            {/* Android has no clearButtonMode — provide an explicit clear-X. */}
            {Platform.OS === 'android' && search.length > 0 && (
              <Pressable
                onPress={() => setSearch('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={10}
              >
                <X color={colors.contentTertiary} size={iconSm} />
              </Pressable>
            )}
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
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <RecordingCard
            recording={item}
            localDraftSlotId={draftResumeMap[item.id]}
            highlighted={submittedIdSet.has(item.id)}
          />
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
        ListHeaderComponent={
          submittedIds.length > 0 && selectedStatusFilter !== 'draft' ? (
            <View
              className="mb-3 p-3 rounded-lg bg-brand-50 border border-brand-200 dark:bg-surface-sunken"
              accessibilityRole="summary"
            >
              <Text className="text-body-sm font-semibold text-brand-700 dark:text-brand-500">
                {SUBMITTED_BANNER_COPY.title(submittedIds.length)}
              </Text>
              {/* Per-recording rows: patient name + live processing status —
                  the old constant "N of N submitted" + raw UUID list could
                  never show partial progress and meant nothing to a vet. */}
              {submittedIds.map((submittedId) => {
                const submittedRecording = submittedRecordingsById.get(submittedId);
                return (
                  <View key={submittedId} className="flex-row items-center justify-between mt-1.5">
                    <Text
                      className="text-body-sm text-content-body flex-1 mr-2"
                      numberOfLines={1}
                    >
                      {submittedRecording
                        ? displayPatientName(submittedRecording)
                        : SUBMITTED_BANNER_COPY.loadingRow}
                    </Text>
                    {submittedRecording ? <StatusBadge status={submittedRecording.status} /> : null}
                  </View>
                );
              })}
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

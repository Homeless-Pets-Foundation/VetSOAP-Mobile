import { RecordingDatesSheet } from '../../../../src/components/RecordingDatesSheet';
import { Button } from '../../../../src/components/ui/Button';
import { activityBounds, matchesActivityRange, localDateKey, type DateFilter } from '../../../../src/lib/recordingHistory';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Alert,
  View,
  SectionList,
  Platform,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Text, TextInput } from '../../../../src/components/ui/Text';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { Search, Mic, X, AlertCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { recordingsApi } from '../../../../src/api/recordings';
import {
  mergeDraftRecordings,
  sortRecordingsBySubmittedAt,
} from '../../../../src/lib/draftRecordings';
import { savedSessionIdForDraft } from '../../../../src/lib/draftLocation';
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
import { displayPatientName } from '../../../../src/lib/recordingDisplay';
import {
  groupRecordingsByDate,
  type RecordingDateSection,
} from '../../../../src/lib/recordingDateGroups';
import { StatusBadge } from '../../../../src/components/StatusBadge';
import { ATTENTION_FEED_COPY, RECORDINGS_LIST_COPY, SUBMITTED_BANNER_COPY, RECORDING_HISTORY_COPY as HISTORY_COPY } from '../../../../src/constants/strings';
import { PERSIST_GC_TIME_MS } from '../../../../src/lib/queryPersistence';
import { measurePhase } from '../../../../src/lib/monitoring';
import type { Recording } from '../../../../src/types';
import { CLIP_SAFE, clipSafe } from '../../../../src/components/ui/styles';

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
// NOTE: there is deliberately no "Needs Review" option. Connect has no
// recording review column/route and ignores the mobile-only `reviewStatus`
// query parameter, so the old chip could never return results. Discovery now
// lives on the Needs Attention screen (header link below).
type StatusFilterValue = typeof STATUS_FILTER_OPTIONS[number]['value'];

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
  return recording.status === selectedStatusFilter;
}

function recordingMatchesSearch(recording: Recording, searchQuery: string): boolean {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  return [recording.patientName, recording.clientName, recording.pimsPatientId].some((value) =>
    value?.toLowerCase().includes(query)
  );
}

export default function RecordingsListScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { submittedIds: submittedIdsParam, status: statusParam } = useLocalSearchParams<{
    submittedIds?: string | string[];
    status?: string;
  }>();
  const user = useAuthUser();
  const colors = useThemeColors();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  /** Bumped on focus so the date grouping re-evaluates "today" after midnight. */
  const [nowTick, setNowTick] = useState(0);
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<StatusFilterValue>('all');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [dateFilter, setDateFilter] = useState<DateFilter>({ preset: 'all' });
  const [datesOpen, setDatesOpen] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh calendar boundaries on focus/day rollover
  const historyNow = useMemo(() => Date.now(), [nowTick]);
  const bounds = useMemo(() => activityBounds(dateFilter, historyNow), [dateFilter, historyNow]);
  useEffect(() => {
    setSearch(''); setDebouncedSearch(''); setSelectedStatusFilter('all');
    setSortOrder('desc'); setDateFilter({ preset: 'all' }); setDatesOpen(false);
  }, [user?.id]);
  useEffect(() => {
    let day = localDateKey(new Date());
    const timer = setInterval(() => {
      const next = localDateKey(new Date());
      if (day !== next) { day = next; setNowTick((tick) => tick + 1); }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  // `?status=draft` (the Record tab's 30-day Review, attention links) opens the
  // list on Not Submitted. One-shot: applied, then cleared in place (setParams,
  // not a navigation), and dropped when the vet leaves the TAB — this screen
  // stays mounted, so without that a later ordinary visit stayed pinned to
  // Not Submitted. Tab-level blur (the parent), not this screen's: opening a
  // draft's detail pushes onto this stack and must keep the filter for the
  // way back. A filter the vet picks themselves is never reset.
  const filterFromLinkRef = useRef(false);
  useEffect(() => {
    if (statusParam !== 'draft') return;
    filterFromLinkRef.current = true;
    setSelectedStatusFilter('draft');
    router.setParams({ status: undefined });
  }, [statusParam, router]);
  useEffect(() => {
    const tabNavigation = navigation.getParent() ?? navigation;
    return tabNavigation.addListener('blur', () => {
      if (!filterFromLinkRef.current) return;
      filterFromLinkRef.current = false;
      setSelectedStatusFilter('all');
    });
  }, [navigation]);
  const isTabFocused = useIsFocused();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock;
  const shouldLoadRecordings = canLoadServerData && selectedStatusFilter !== 'draft';
  const shouldLoadDrafts = canLoadServerData && (selectedStatusFilter === 'all' || selectedStatusFilter === 'draft');
  const serverStatusFilter =
    selectedStatusFilter === 'failed' || selectedStatusFilter === 'completed'
      ? selectedStatusFilter
      : undefined;
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
    queryKey: ['recordings', 'list', debouncedSearch, serverStatusFilter ?? 'all', `activityAt-${sortOrder}`, bounds.activityFrom, bounds.activityBefore, user?.id],
    // Survives into the persisted offline snapshot (WP28).
    gcTime: PERSIST_GC_TIME_MS,
    queryFn: ({ pageParam = 1, signal }) =>
      recordingsApi.list({
        signal,
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'activityAt',
        sortOrder,
        ...bounds,
        ...(serverStatusFilter ? { status: serverStatusFilter } : {}),
      }),
    initialPageParam: 1,
    enabled: shouldLoadRecordings,
    // Unsubscribed while another tab is showing: invalidation marks it stale
    // instead of re-pulling every loaded page behind that tab, and refocusing
    // refetches it once.
    subscribed: isTabFocused,
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
    () => sortRecordingsBySubmittedAt(data?.pages.flatMap((page) => page.data) ?? [], sortOrder),
    [data, sortOrder]
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
  const statusFilterOptions = useMemo(() => [...STATUS_FILTER_OPTIONS], []);
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
    fetchNextPage: fetchNextDraftPage,
    hasNextPage: hasNextDraftPage,
    isFetchingNextPage: isFetchingNextDraftPage,
  } = useInfiniteQuery({
    queryKey: ['recordings', 'drafts', 'list', debouncedSearch, `activityAt-${sortOrder}`, bounds.activityFrom, bounds.activityBefore, user?.id],
    queryFn: ({ signal, pageParam = 1 }) =>
      recordingsApi.list({
        signal,
        search: debouncedSearch || undefined,
        status: 'draft',
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'activityAt',
        sortOrder,
        ...bounds,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.pagination;
      return pagination && pagination.page < pagination.totalPages ? pagination.page + 1 : undefined;
    },
    enabled: shouldLoadDrafts,
    subscribed: isTabFocused,
  });

  const {
    localDrafts,
    isLoading: isLocalDraftLoading,
    isError: isLocalDraftError,
    draftResumeMap,
    savedSessionDraftMap,
    refreshLocalDrafts,
    isStale: areLocalDraftsStale,
  } = useLocalDraftRecordings();
  const areLocalDraftsStaleRef = useRef(areLocalDraftsStale);

  useEffect(() => {
    areLocalDraftsStaleRef.current = areLocalDraftsStale;
  }, [areLocalDraftsStale]);

  const recordingsRetryKey = [debouncedSearch || 'none', serverStatusFilter ?? 'all', sortOrder, bounds.activityFrom, bounds.activityBefore].join(':');
  const draftsRetryKey = [debouncedSearch || 'none', 'draft', sortOrder, bounds.activityFrom, bounds.activityBefore].join(':');

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
    return localDrafts.filter((draft) => {
      if (query && ![draft.formData.patientName, draft.formData.clientName, draft.formData.pimsPatientId]
        .some((value) => value?.toLowerCase().includes(query))) return false;
      return matchesActivityRange({ submittedAt: null, createdAt: draft.savedAt } as Recording, bounds);
    });
  }, [localDrafts, debouncedSearch, bounds]);
  const mergedDrafts = useMemo(() => {
    if (!user) return [];
    return mergeDraftRecordings(
      filteredLocalDrafts,
      draftData?.pages.flatMap((page) => page.data) ?? [],
      user.id,
      user.organizationId,
      sortOrder
    );
  }, [draftData, filteredLocalDrafts, user, sortOrder]);
  const displayRecordings = useMemo(() => {
    const pinSubmitted = (items: Recording[]): Recording[] => {
      if (submittedIds.length === 0 || selectedStatusFilter === 'draft') return items;
      const pinned = submittedIds
        .map((id) => submittedRecordingsById.get(id))
        .filter((recording): recording is Recording =>
          !!recording &&
          recordingMatchesStatusFilter(recording, selectedStatusFilter) &&
          recordingMatchesSearch(recording, debouncedSearch) &&
          matchesActivityRange(recording, bounds)
        );
      if (pinned.length === 0) return items;
      const rest = items.filter((recording) => !submittedIdSet.has(recording.id));
      return [...pinned, ...rest];
    };

    if (selectedStatusFilter === 'draft') return sortRecordingsBySubmittedAt(mergedDrafts, sortOrder);
    if (selectedStatusFilter === 'all') {
      const combined = new Map<string, (typeof recordings)[number]>();

      for (const recording of mergedDrafts) {
        combined.set(recording.id, recording);
      }
      for (const recording of recordings) {
        combined.set(recording.id, recording);
      }

      return pinSubmitted(sortRecordingsBySubmittedAt(Array.from(combined.values()), sortOrder));
    }
    return pinSubmitted(recordings);
  }, [debouncedSearch, mergedDrafts, recordings, selectedStatusFilter, submittedIds, submittedIdSet, submittedRecordingsById, sortOrder, bounds]);
  // Regroup sorted rows on focus/day rollover, with fresh submissions in their own section.
  const dateSections = useMemo(
    // Keep highlighted submissions separate from the ordinary date groups.
    () => groupRecordingsByDate(displayRecordings, Date.now(), submittedIds, sortOrder),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowTick is the midnight/refocus trigger
    [displayRecordings, nowTick, submittedIds, sortOrder]
  );
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
    setNowTick((tick) => tick + 1);
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
      // Join, never abort: refocusing resubscribes both queries, which already
      // starts the stale refetch this would otherwise cancel and repeat.
      if (shouldRefetchRecordings) {
        refetch({ cancelRefetch: false }).catch(() => {});
      }
      if (shouldRefetchDrafts) {
        refetchDrafts({ cancelRefetch: false }).catch(() => {});
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
    if (shouldLoadDrafts && hasNextDraftPage && !isFetchingNextDraftPage) {
      fetchNextDraftPage().catch(() => {});
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, shouldLoadRecordings,
    fetchNextDraftPage, hasNextDraftPage, isFetchingNextDraftPage, shouldLoadDrafts]);

  const handleRecordPress = useCallback(() => {
    if (!canRecordAppointments(user?.role)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(RECORD_APPOINTMENT_PERMISSION_TITLE, RECORD_APPOINTMENT_PERMISSION_MESSAGE);
      return;
    }

    router.push('/record');
  }, [router, user?.role]);

  const isListLoading = selectedStatusFilter === 'draft'
    ? isDraftLoading || isLocalDraftLoading
    : selectedStatusFilter === 'all'
      ? isLoading || isDraftLoading || isLocalDraftLoading
      : isLoading;
  const isListError = !canLoadServerData ||
    (shouldLoadRecordings && isError) || (shouldLoadDrafts && (isDraftError || isLocalDraftError));
  const partialResults = displayRecordings.length > 0 && isListError;
  const listError = (shouldLoadRecordings && error) || (shouldLoadDrafts && draftError) || null;
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
        <View className="flex-row items-center justify-between mb-4">
          <Text
            className="text-display font-bold text-content-primary flex-1"
            accessibilityRole="header"
          >
            Recordings
          </Text>
          {/* Navigation entry, not a status filter: the feed combines status,
              metadata, quality, and device-local signals. */}
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              router.push('/recordings/attention' as never);
            }}
            accessibilityRole="link"
            accessibilityLabel={ATTENTION_FEED_COPY.openScreenAccessibilityLabel}
            hitSlop={10}
            className="flex-row items-center ml-3"
            style={{ minHeight: 44 }}
          >
            <AlertCircle color={colors.brand500} size={iconSm} style={{ marginRight: 4, flexShrink: 0 }} />
            {/* Trailing space + flexShrink:0 — Android under-measures short Text in flex-rows and clips the last glyph; do NOT remove. */}
            <Text
              className="text-body-sm text-brand-500 font-medium"
              style={CLIP_SAFE}
            >
              {clipSafe(ATTENTION_FEED_COPY.sectionTitle)}
            </Text>
          </Pressable>
        </View>

        <View className="gap-3 mb-4">
          {/* Search */}
          <View
            className={`w-full flex-row items-center bg-surface-raised border rounded-input px-3 ${
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
            onValueChange={(value) => {
              filterFromLinkRef.current = false;
              setSelectedStatusFilter(value);
            }}
            placeholder="Status"
            accessibilityLabel={`Filter recordings by status. Current filter ${activeStatusFilterLabel}`}
            sheetTitle="Filter by status"
            className="w-full"
            fieldClassName={selectedStatusFilter !== 'all' ? 'border-brand-500 bg-brand-50 dark:bg-surface-sunken' : ''}
          />
          <View className="flex-row flex-wrap gap-2">
            <Select options={[{ label: HISTORY_COPY.newest, value: 'desc' }, { label: HISTORY_COPY.oldest, value: 'asc' }]}
              value={sortOrder} onValueChange={setSortOrder} sheetTitle="Order recordings" accessibilityLabel="Order recordings" className="grow" />
            <Button variant="secondary" onPress={() => setDatesOpen(true)}>{HISTORY_COPY.dates}</Button>
          </View>
          {dateFilter.preset !== 'all' ? (
            <View>
              <Text className="text-body-sm text-content-secondary">{dateFilter.preset === 'custom'
                ? `${dateFilter.from} – ${dateFilter.through}` : HISTORY_COPY.presets[dateFilter.preset]}</Text>
              <Button variant="ghost" size="sm" onPress={() => setDateFilter({ preset: 'all' })}>{HISTORY_COPY.clear}</Button>
            </View>
          ) : null}
        </View>
      </View>
      {partialResults ? <View className="px-5 mb-2">
        <Text accessibilityRole="alert" className="text-body-sm text-status-warning">{HISTORY_COPY.partial}</Text>
        <Button variant="ghost" size="sm" onPress={handleRefresh}>Retry</Button>
      </View> : null}

      <SectionList
        sections={dateSections}
        keyExtractor={keyExtractor}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        renderItem={({ item }) => (
          <RecordingCard
            recording={item}
            localDraftSlotId={draftResumeMap[item.id]}
            inSavedSession={!!savedSessionIdForDraft(savedSessionDraftMap, item.id)}
            highlighted={submittedIdSet.has(item.id)}
            hideStatusBadge={item.status === 'completed'}
          />
        )}
        renderSectionHeader={({ section }) => (
          <Text
            className="text-body-sm font-semibold text-content-secondary mt-3 mb-2"
            accessibilityRole="header"
          >
            {(section as unknown as RecordingDateSection).title}
          </Text>
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
          (shouldLoadRecordings && isFetchingNextPage) || (shouldLoadDrafts && isFetchingNextDraftPage) ? (
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
              description={HISTORY_COPY.unavailable}
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
              const isTrueEmpty = !debouncedSearch && selectedStatusFilter === 'all' && dateFilter.preset === 'all';
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
      <RecordingDatesSheet visible={datesOpen} value={dateFilter} onClose={() => setDatesOpen(false)}
        onApply={(filter) => { setDateFilter(filter); setDatesOpen(false); }} />
    </SafeAreaView>
  );
}

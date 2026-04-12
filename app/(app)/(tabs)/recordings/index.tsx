import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { Search } from 'lucide-react-native';
import { recordingsApi } from '../../../../src/api/recordings';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import type { RecordingStatus } from '../../../../src/types';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { RecordingCard } from '../../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { Button } from '../../../../src/components/ui/Button';

const PAGE_SIZE = 20;
const FLATLIST_CONTENT_STYLE = { paddingHorizontal: 20, paddingBottom: 20 } as const;

type StatusFilter = 'all' | RecordingStatus;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'pending_metadata', label: 'Awaiting Details' },
];

export default function RecordingsListScreen() {
  const router = useRouter();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const {
    data,
    isLoading,
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['recordings', 'list', debouncedSearch, selectedStatus],
    queryFn: ({ pageParam = 1 }) => {
      const statusParam: RecordingStatus | undefined =
        selectedStatus === 'all'
          ? undefined
          : (selectedStatus as RecordingStatus);
      return recordingsApi.list({
        search: debouncedSearch || undefined,
        status: statusParam,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (!lastPage.pagination) return undefined;
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
    refetchInterval: (query) => {
      const allRecordings = query.state.data?.pages.flatMap((p) => p.data);
      const hasProcessing = allRecordings?.some(
        (r) => !['completed', 'failed', 'pending_metadata'].includes(r.status)
      );
      return hasProcessing ? 10000 : false;
    },
  });

  const recordings = useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data]
  );

  const keyExtractor = useCallback((item: { id: string }) => item.id, []);

  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage().catch(() => {});
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Disable entry animations after initial data load
  useEffect(() => {
    if (data && isInitialMountRef.current) {
      isInitialMountRef.current = false;
    }
  }, [data]);

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

        {/* Status Filter Strip */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mb-3 -mx-5 px-5"
          contentContainerStyle={{ gap: 8 }}
        >
          {STATUS_FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => {
                setSelectedStatus(f.key);
                Haptics.selectionAsync().catch(() => {});
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedStatus === f.key }}
              accessibilityLabel={`Filter by ${f.label}`}
              className={`px-4 py-2 rounded-full border ${
                selectedStatus === f.key
                  ? 'bg-brand-500 border-brand-500'
                  : 'bg-white border-stone-300'
              }`}
            >
              <Text
                className={`text-body-sm font-medium ${
                  selectedStatus === f.key ? 'text-white' : 'text-stone-700'
                }`}
              >
                {f.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* Search */}
        <View
          className={`flex-row items-center bg-white border rounded-input px-3 mb-4 ${
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
      </View>

      <FlatList
        data={recordings}
        keyExtractor={keyExtractor}
        renderItem={({ item, index }) => {
          if (isInitialMountRef.current && index < 3) {
            return (
              <Animated.View entering={FadeInRight.delay(index * 50).duration(250)}>
                <RecordingCard recording={item} />
              </Animated.View>
            );
          }
          return <RecordingCard recording={item} />;
        }}
        contentContainerStyle={FLATLIST_CONTENT_STYLE}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }} />}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.8}
        removeClippedSubviews={true}
        maxToRenderPerBatch={5}
        windowSize={7}
        initialNumToRender={8}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="py-4 items-center">
              <ActivityIndicator size="small" color="#0d8775" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <View>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </View>
          ) : isError ? (
            <View className="py-10 items-center">
              <Search color="#dc2626" size={iconLg} />
              <Text className="text-body text-stone-600 mt-3 text-center">
                Could not load recordings.
              </Text>
              <View className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => { refetch().catch(() => {}); }}
                >
                  Retry
                </Button>
              </View>
            </View>
          ) : (
            <View className="py-10 items-center">
              <Search color="#78716c" size={iconLg} />
              <Text className="text-body text-stone-500 mt-3 text-center">
                {search ? 'No recordings match your search.' : 'No recordings yet.'}
              </Text>
              {!search && (
                <View className="mt-4">
                  <Button
                    variant="primary"
                    onPress={() => router.push('/record')}
                    accessibilityLabel="Start recording an appointment"
                  >
                    Record Appointment
                  </Button>
                </View>
              )}
            </View>
          )
        }
      />
      </View>
    </SafeAreaView>
  );
}

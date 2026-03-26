import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { Search } from 'lucide-react-native';
import { recordingsApi } from '../../../src/api/recordings';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../src/components/ui/ScreenContainer';
import { RecordingCard } from '../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../src/components/ui/Skeleton';
import { Button } from '../../../src/components/ui/Button';

const PAGE_SIZE = 20;

export default function RecordingsListScreen() {
  const router = useRouter();
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
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
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['recordings', 'list', debouncedSearch],
    queryFn: ({ pageParam = 1 }) =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (!lastPage.pagination) return undefined;
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
    refetchInterval: (query) => {
      const allRecordings = query.state.data?.pages.flatMap((p) => p.data);
      const hasProcessing = allRecordings?.some(
        (r) => !['completed', 'failed'].includes(r.status)
      );
      return hasProcessing ? 10000 : false;
    },
  });

  const recordings = data?.pages.flatMap((page) => page.data) ?? [];

  // Disable entry animations after initial data load
  useEffect(() => {
    if (data && isInitialMountRef.current) {
      isInitialMountRef.current = false;
    }
  }, [data]);

  return (
    <SafeAreaView className="screen" style={{ alignItems: 'center' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
      <View className="px-5 pt-5 pb-0">
        <Text
          className="text-display font-bold text-stone-900 mb-4"
          accessibilityRole="header"
        >
          Recordings
        </Text>

        {/* Search */}
        <View
          className={`flex-row items-center bg-white border rounded-input px-3 mb-4 ${
            isFocused ? 'border-brand-500' : 'border-stone-300'
          }`}
        >
          <Search color="#a8a29e" size={iconSm} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder="Search by patient name..."
            placeholderTextColor="#a8a29e"
            accessibilityLabel="Search recordings by patient name"
            className="flex-1 p-3 text-body text-stone-900"
          />
        </View>
      </View>

      <FlatList
        data={recordings}
        keyExtractor={(item) => item.id}
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
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }} />}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage().catch(() => {});
          }
        }}
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
          ) : (
            <View className="py-10 items-center">
              <Search color="#a8a29e" size={iconLg} />
              <Text className="text-body text-stone-500 mt-3 text-center">
                {search ? 'No recordings match your search.' : 'No recordings yet.'}
              </Text>
              {!search && (
                <View className="mt-4">
                  <Button
                    variant="primary"
                    onPress={() => router.push('/(app)/record')}
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

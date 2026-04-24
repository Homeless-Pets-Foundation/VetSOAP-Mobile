import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useInfiniteQuery } from '@tanstack/react-query';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { User } from 'lucide-react-native';
import { patientsApi } from '../../../../src/api/patients';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { PatientRow } from '../../../../src/components/PatientRow';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { EmptyState } from '../../../../src/components/ui/EmptyState';

const PAGE_SIZE = 20;
const FLATLIST_CONTENT_STYLE = { paddingHorizontal: 20, paddingBottom: 20 } as const;

export default function PatientListScreen() {
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
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['patients', 'list', debouncedSearch],
    queryFn: ({ pageParam = 1 }) =>
      patientsApi.list({
        search: debouncedSearch || undefined,
        page: pageParam,
        limit: PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (!lastPage.pagination) return undefined;
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
  });

  const patients = useMemo(() => {
    // Dedupe by id — offset pagination can repeat a row across pages when the
    // underlying set shifts between fetches (e.g. a patient is updated and
    // moves in sort order). Without this, FlatList emits duplicate keys.
    const seen = new Set<string>();
    return (data?.pages.flatMap((page) => page.data) ?? []).filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [data]);

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
            Patients
          </Text>

          {/* Search */}
          <View
            className={`flex-row items-center bg-white border rounded-input px-3 mb-4 ${
              isFocused ? 'border-brand-500' : 'border-stone-300'
            }`}
          >
            <User color="#78716c" size={iconSm} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Search by patient name..."
              placeholderTextColor="#78716c"
              accessibilityLabel="Search patients by name"
              className="flex-1 p-3 text-body text-stone-900"
            />
          </View>
        </View>

        <FlatList
          data={patients}
          keyExtractor={keyExtractor}
          renderItem={({ item, index }) => {
            if (isInitialMountRef.current && index < 3) {
              return (
                <Animated.View entering={FadeInRight.delay(index * 50).duration(250)}>
                  <PatientRow patient={item} />
                </Animated.View>
              );
            }
            return <PatientRow patient={item} />;
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
              </View>
            ) : isError ? (
              <EmptyState
                icon={User}
                iconColor="#dc2626"
                iconSize={iconLg}
                description="Could not load patients."
                action={{
                  label: 'Retry',
                  variant: 'secondary',
                  onPress: () => {
                    refetch().catch(() => {});
                  },
                }}
              />
            ) : (
              <EmptyState
                icon={User}
                iconSize={iconLg}
                description={search ? 'No patients match your search.' : 'No patients yet.'}
              />
            )
          }
        />
      </View>
    </SafeAreaView>
  );
}

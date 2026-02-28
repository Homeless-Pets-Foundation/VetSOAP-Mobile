import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { Search } from 'lucide-react-native';
import { recordingsApi } from '../../../src/api/recordings';
import { RecordingCard } from '../../../src/components/RecordingCard';
import { SkeletonCard } from '../../../src/components/ui/Skeleton';
import { Button } from '../../../src/components/ui/Button';

export default function RecordingsListScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [isFocused, setIsFocused] = useState(false);
  const isFetchingNextPageRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['recordings', 'list', debouncedSearch, page],
    queryFn: () =>
      recordingsApi.list({
        search: debouncedSearch || undefined,
        page,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
  });

  useEffect(() => {
    isFetchingNextPageRef.current = false;
  }, [data]);

  const recordings = data?.data ?? [];
  const hasMore = data?.pagination ? page < data.pagination.totalPages : false;

  return (
    <SafeAreaView className="screen">
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
          <Search color="#a8a29e" size={18} />
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
          if (index < 10) {
            return (
              <Animated.View entering={FadeInRight.delay(index * 50).duration(300)}>
                <RecordingCard recording={item} />
              </Animated.View>
            );
          }
          return <RecordingCard recording={item} />;
        }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        onEndReached={() => {
          if (hasMore && !isFetchingNextPageRef.current) {
            isFetchingNextPageRef.current = true;
            setPage((p) => p + 1);
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          hasMore ? (
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
              <Search color="#a8a29e" size={48} />
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
    </SafeAreaView>
  );
}

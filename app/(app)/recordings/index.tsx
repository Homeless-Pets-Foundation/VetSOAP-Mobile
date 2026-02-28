import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react-native';
import { recordingsApi } from '../../../src/api/recordings';
import { RecordingCard } from '../../../src/components/RecordingCard';

export default function RecordingsListScreen() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['recordings', 'list', search, page],
    queryFn: () =>
      recordingsApi.list({
        search: search || undefined,
        page,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      }),
  });

  const recordings = data?.data ?? [];
  const hasMore = data?.pagination ? page < data.pagination.totalPages : false;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <View style={{ padding: 20, paddingBottom: 0 }}>
        <Text style={{ fontSize: 24, fontWeight: '700', color: '#1c1917', marginBottom: 16 }}>
          Recordings
        </Text>

        {/* Search */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: '#fff',
            borderWidth: 1,
            borderColor: '#d6d3d1',
            borderRadius: 10,
            paddingHorizontal: 12,
            marginBottom: 16,
          }}
        >
          <Search color="#a8a29e" size={18} />
          <TextInput
            value={search}
            onChangeText={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by patient name..."
            placeholderTextColor="#a8a29e"
            style={{
              flex: 1,
              padding: 12,
              fontSize: 15,
              color: '#1c1917',
            }}
          />
        </View>
      </View>

      <FlatList
        data={recordings}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <RecordingCard recording={item} />}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        onEndReached={() => {
          if (hasMore) setPage((p) => p + 1);
        }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          isLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: '#a8a29e' }}>Loading recordings...</Text>
            </View>
          ) : (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: '#78716c', fontSize: 14 }}>
                {search ? 'No recordings match your search.' : 'No recordings yet.'}
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

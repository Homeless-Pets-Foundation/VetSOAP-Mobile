import React from 'react';
import { View, Text, Pressable, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Mic, ChevronRight } from 'lucide-react-native';
import { useAuth } from '../../src/hooks/useAuth';
import { recordingsApi } from '../../src/api/recordings';
import { RecordingCard } from '../../src/components/RecordingCard';

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['recordings', 'recent'],
    queryFn: () => recordingsApi.list({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' }),
  });

  const recordings = data?.data ?? [];
  const totalRecordings = data?.pagination?.total ?? 0;
  const completedCount = recordings.filter((r) => r.status === 'completed').length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <ScrollView
        style={{ flex: 1, padding: 20 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Header */}
        <View style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 24, fontWeight: '700', color: '#1c1917' }}>
            Welcome{user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}
          </Text>
          <Text style={{ fontSize: 14, color: '#78716c', marginTop: 4 }}>
            Record appointments and generate SOAP notes
          </Text>
        </View>

        {/* Quick Action */}
        <Pressable
          onPress={() => router.push('/(app)/record')}
          style={({ pressed }) => ({
            backgroundColor: pressed ? '#0bb89a' : '#0d8775',
            borderRadius: 16,
            padding: 20,
            marginBottom: 24,
            flexDirection: 'row',
            alignItems: 'center',
          })}
        >
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: 'rgba(255,255,255,0.2)',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 16,
            }}
          >
            <Mic color="#fff" size={24} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
              Record Appointment
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 2 }}>
              Start recording a new appointment
            </Text>
          </View>
          <ChevronRight color="rgba(255,255,255,0.6)" size={24} />
        </Pressable>

        {/* Stats */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
          <View
            style={{
              flex: 1,
              backgroundColor: '#fff',
              borderRadius: 12,
              padding: 16,
              borderWidth: 1,
              borderColor: '#e7e5e4',
            }}
          >
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#0d8775' }}>
              {totalRecordings}
            </Text>
            <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }}>Total Recordings</Text>
          </View>
          <View
            style={{
              flex: 1,
              backgroundColor: '#fff',
              borderRadius: 12,
              padding: 16,
              borderWidth: 1,
              borderColor: '#e7e5e4',
            }}
          >
            <Text style={{ fontSize: 24, fontWeight: '700', color: '#0d8775' }}>
              {completedCount}
            </Text>
            <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }}>SOAP Notes Ready</Text>
          </View>
        </View>

        {/* Recent Recordings */}
        <View style={{ marginBottom: 32 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '600', color: '#1c1917' }}>
              Recent Recordings
            </Text>
            {totalRecordings > 5 && (
              <Pressable onPress={() => router.push('/(app)/recordings')}>
                <Text style={{ fontSize: 13, color: '#0d8775', fontWeight: '500' }}>
                  View All
                </Text>
              </Pressable>
            )}
          </View>

          {isLoading ? (
            <View style={{ padding: 20, alignItems: 'center' }}>
              <Text style={{ color: '#a8a29e' }}>Loading...</Text>
            </View>
          ) : recordings.length === 0 ? (
            <View
              style={{
                padding: 24,
                alignItems: 'center',
                backgroundColor: '#fff',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: '#e7e5e4',
              }}
            >
              <Text style={{ color: '#78716c', fontSize: 14 }}>
                No recordings yet. Tap "Record Appointment" to get started.
              </Text>
            </View>
          ) : (
            recordings.map((recording) => (
              <RecordingCard key={recording.id} recording={recording} />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

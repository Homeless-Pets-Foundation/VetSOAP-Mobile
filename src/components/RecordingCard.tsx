import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBadge } from './StatusBadge';
import type { Recording } from '../types';

interface RecordingCardProps {
  recording: Recording;
}

export function RecordingCard({ recording }: RecordingCardProps) {
  const router = useRouter();

  const formattedDate = new Date(recording.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <Pressable
      onPress={() => router.push(`/(app)/recordings/${recording.id}` as any)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? '#f5f5f4' : '#ffffff',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: '#e7e5e4',
        marginBottom: 8,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917' }}>
            {recording.patientName}
          </Text>
          {recording.species && (
            <Text style={{ fontSize: 13, color: '#78716c', marginTop: 2 }}>
              {recording.species}
              {recording.breed ? ` · ${recording.breed}` : ''}
            </Text>
          )}
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 4 }}>
            {formattedDate}
          </Text>
        </View>
        <StatusBadge status={recording.status} />
      </View>
    </Pressable>
  );
}

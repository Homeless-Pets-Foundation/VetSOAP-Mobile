import React from 'react';
import { View, Text } from 'react-native';
import type { RecordingStatus } from '../types';

const STATUS_CONFIG: Record<RecordingStatus, { label: string; bg: string; text: string }> = {
  uploading: { label: 'Uploading', bg: '#dbeafe', text: '#1d4ed8' },
  uploaded: { label: 'Uploaded', bg: '#e0e7ff', text: '#4338ca' },
  transcribing: { label: 'Transcribing', bg: '#fef3c7', text: '#92400e' },
  transcribed: { label: 'Transcribed', bg: '#fde68a', text: '#78350f' },
  generating: { label: 'Generating', bg: '#d1fae5', text: '#065f46' },
  completed: { label: 'Completed', bg: '#d1fae5', text: '#065f46' },
  failed: { label: 'Failed', bg: '#fee2e2', text: '#991b1b' },
};

interface StatusBadgeProps {
  status: RecordingStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.uploading;

  return (
    <View
      style={{
        backgroundColor: config.bg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 12,
      }}
    >
      <Text style={{ color: config.text, fontSize: 12, fontWeight: '600' }}>
        {config.label}
      </Text>
    </View>
  );
}

import React from 'react';
import { View, Text } from 'react-native';
import { Trash2, Play } from 'lucide-react-native';
import type { StashedSession } from '../types/stash';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { IconButton } from './ui/IconButton';
import { useThemeColors } from '../hooks/useThemeColors';

interface StashedSessionCardProps {
  stash: StashedSession;
  onResume: () => void;
  onDelete: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '';
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function StashedSessionCard({ stash, onResume, onDelete }: StashedSessionCardProps) {
  const colors = useThemeColors();
  const metaParts: string[] = [];
  const relTime = formatRelativeTime(stash.stashedAt);
  if (relTime) metaParts.push(relTime);
  if (stash.totalDuration > 0) metaParts.push(formatDuration(stash.totalDuration));
  metaParts.push(`${stash.patientCount} ${stash.patientCount === 1 ? 'patient' : 'patients'}`);

  return (
    <Card className="mb-2">
      {/* Header row: title + delete */}
      <View className="flex-row items-start justify-between mb-2">
        <View className="flex-1 mr-3">
          <Text className="text-body font-semibold text-content-primary" numberOfLines={1}>
            {stash.patientSummary}
          </Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">
            {metaParts.join('  \u00B7  ')}
          </Text>
        </View>
        <IconButton
          icon={<Trash2 color={colors.contentTertiary} size={16} />}
          label="Delete saved session"
          onPress={onDelete}
          accessibilityHint="Double-tap to permanently delete this saved session and its recordings"
          size="sm"
          className="-mr-1 -mt-1"
        />
      </View>

      {/* Resume button */}
      <Button
        variant="secondary"
        size="sm"
        onPress={onResume}
        icon={<Play color={colors.brand500} size={14} fill={colors.brand500} />}
        accessibilityLabel={`Resume session for ${stash.clientName}, ${stash.patientSummary}`}
        accessibilityHint="Double-tap to resume this recording session"
      >
        Resume Session
      </Button>
    </Card>
  );
}

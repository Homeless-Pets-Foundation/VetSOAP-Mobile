import React from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { FileClock, ChevronRight } from 'lucide-react-native';
import { useDurableRecoveries } from '../hooks/useDurableRecoveries';
import { useThemeColors } from '../hooks/useThemeColors';

/**
 * Persistent recovery affordance shown on Home + Record when the launch scan
 * surfaced recoverable durable recordings. Taps route to the recovery screen.
 * Renders nothing when there is nothing to recover (flag-off default).
 */
export function DurableRecoveryBanner() {
  const router = useRouter();
  const colors = useThemeColors();
  const recoveries = useDurableRecoveries();
  if (recoveries.length === 0) return null;

  const label =
    recoveries.length === 1
      ? 'Captivet recovered an unsaved recording'
      : `Captivet recovered ${recoveries.length} unsaved recordings`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push('/durable-recovery' as never)}
      className="mb-4 flex-row items-center gap-3 rounded-xl border border-brand-300 bg-brand-50 dark:bg-surface-sunken dark:border-border-default px-4 py-3"
    >
      <FileClock size={20} color={colors.brand500} />
      <Text className="flex-1 text-content-body font-medium">{label}</Text>
      <ChevronRight size={18} color={colors.contentTertiary} />
    </Pressable>
  );
}

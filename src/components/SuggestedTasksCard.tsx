import React from 'react';
import { Alert, Text, View } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import { SUGGESTED_TASKS_COPY } from '../constants/strings';
import { trackEvent } from '../lib/analytics';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { useThemeColors } from '../hooks/useThemeColors';
import { groupRecordingTasks } from '../lib/recordingTasks';
import type { RecordingTask, RecordingTaskType } from '../types';

function groupHeading(type: RecordingTaskType): string {
  return type === 'billing'
    ? SUGGESTED_TASKS_COPY.chargesHeading
    : SUGGESTED_TASKS_COPY.followUpHeading;
}

function resolvedLabel(status: RecordingTask['status']): string | null {
  if (status === 'accepted') return SUGGESTED_TASKS_COPY.accepted;
  if (status === 'dismissed') return SUGGESTED_TASKS_COPY.dismissed;
  if (status === 'done') return SUGGESTED_TASKS_COPY.done;
  return null;
}

interface SuggestedTasksCardProps {
  recordingId: string;
  tasks: RecordingTask[];
  canManage: boolean;
}

export function SuggestedTasksCard({ recordingId, tasks, canManage }: SuggestedTasksCardProps) {
  const colors = useThemeColors();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (vars: { taskId: string; status: 'accepted' | 'dismissed'; type: RecordingTaskType }) =>
      recordingsApi.updateRecordingTaskStatus(recordingId, vars.taskId, vars.status),
    onSuccess: (_updated, vars) => {
      trackEvent({ name: 'suggested_task_resolved', props: { action: vars.status, type: vars.type } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Return the invalidation promise so the mutation stays pending (buttons
      // stay disabled) until the refetched list replaces the stale 'suggested'
      // row — otherwise a slow refetch would re-enable the buttons and allow a
      // second conflicting PATCH (e.g. Accept then Dismiss) before the UI updates.
      return queryClient
        .invalidateQueries({ queryKey: ['recordingTasks', recordingId] })
        .catch(() => {});
    },
    onError: (error: unknown, vars) => {
      if (error instanceof ApiError && error.code === 'MFA_REQUIRED') return;
      Alert.alert(
        SUGGESTED_TASKS_COPY.title,
        vars.status === 'accepted'
          ? SUGGESTED_TASKS_COPY.acceptFailed
          : SUGGESTED_TASKS_COPY.dismissFailed
      );
    },
  });

  const groups = groupRecordingTasks(tasks);
  if (groups.length === 0) return null;

  const resolve = (task: RecordingTask, status: 'accepted' | 'dismissed') => {
    mutation.mutate({ taskId: task.id, status, type: task.type });
  };

  const isBusy = (taskId: string) => mutation.isPending && mutation.variables?.taskId === taskId;

  return (
    <Card className="mx-5 mb-4">
      <View className="flex-row items-start mb-3">
        <Sparkles color={colors.brand500} size={18} />
        <View className="flex-1 ml-2">
          <Text className="text-body-lg font-semibold text-content-primary">
            {SUGGESTED_TASKS_COPY.title}
          </Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">
            {SUGGESTED_TASKS_COPY.subtitle}
          </Text>
        </View>
      </View>

      {groups.map((group) => (
        <View key={group.type} className="mt-1">
          <Text className="text-caption font-semibold text-content-tertiary uppercase mb-1">
            {groupHeading(group.type)}
          </Text>
          <View className="border border-border-default rounded-input overflow-hidden">
            {group.tasks.map((task) => {
              const resolved = resolvedLabel(task.status);
              const showActions = canManage && task.status === 'suggested';
              return (
                <View
                  key={task.id}
                  className="p-3 border-b border-border-default last:border-b-0"
                >
                  <View className="flex-row items-start justify-between">
                    <Text
                      className={`text-body-sm font-semibold flex-1 pr-2 ${
                        resolved ? 'text-content-tertiary' : 'text-content-primary'
                      }`}
                    >
                      {task.title}
                    </Text>
                    {showActions ? (
                      <View className="flex-row gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={isBusy(task.id) && mutation.variables?.status === 'dismissed'}
                          disabled={mutation.isPending}
                          onPress={() => resolve(task, 'dismissed')}
                        >
                          {SUGGESTED_TASKS_COPY.dismiss}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={isBusy(task.id) && mutation.variables?.status === 'accepted'}
                          disabled={mutation.isPending}
                          onPress={() => resolve(task, 'accepted')}
                        >
                          {SUGGESTED_TASKS_COPY.accept}
                        </Button>
                      </View>
                    ) : resolved ? (
                      <Text
                        className="text-caption text-content-tertiary ml-2"
                        // flexShrink:0 + paddingRight stops Android clipping the last glyph of single-word status labels ("Accepted"/"Dismissed") next to the flex-1 title
                        style={{ flexShrink: 0, paddingRight: 2 }}
                      >
                        {resolved}
                      </Text>
                    ) : null}
                  </View>
                  {task.detail ? (
                    <Text
                      className={`text-body-sm mt-1 ${
                        resolved ? 'text-content-tertiary' : 'text-content-body'
                      }`}
                    >
                      {task.detail}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </Card>
  );
}

import React from 'react';
import { ActivityIndicator, Text, View, type DimensionValue } from 'react-native';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Users,
} from 'lucide-react-native';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { useThemeColors } from '../hooks/useThemeColors';
import { QUALITY_ANALYTICS_COPY } from '../constants/strings';
import type {
  DashboardQualityEnvelope,
  QualityBreakdownSummary,
  QualityProviderSummary,
  QualitySummary,
} from '../api/qualityAnalytics';

interface QualityAnalyticsCardProps {
  data?: DashboardQualityEnvelope;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0 min';
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

function formatLastRecordingAt(value: Date | null): string {
  if (!value) return QUALITY_ANALYTICS_COPY.noRecordings;
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return QUALITY_ANALYTICS_COPY.noRecordings;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hasActivity(summary: QualitySummary): boolean {
  return (
    summary.completedRecordings > 0 ||
    summary.failedUploadAttempts > 0 ||
    summary.silentAudioEvents > 0 ||
    summary.reprocessCount > 0 ||
    summary.soapEditedCount > 0 ||
    summary.missingMetadataCount > 0
  );
}

function issueLabels(summary: QualitySummary): string[] {
  const labels: string[] = [];
  if ((summary.missingMetadataRate ?? 0) >= 0.2) labels.push(QUALITY_ANALYTICS_COPY.metrics.missingDetails);
  if ((summary.reprocessRate ?? 0) >= 0.2) labels.push(QUALITY_ANALYTICS_COPY.metrics.reprocessRate);
  if ((summary.soapEditRate ?? 0) >= 0.5) labels.push(QUALITY_ANALYTICS_COPY.metrics.soapEditRate);
  return labels.slice(0, 2);
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <View className="w-1/2 pr-3 mb-3">
      <Text className="text-caption text-content-tertiary" numberOfLines={2}>
        {label}
      </Text>
      <Text className="text-body font-semibold text-content-primary mt-0.5" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function SummaryBlock({ title, summary }: { title: string; summary: QualitySummary }) {
  const c = QUALITY_ANALYTICS_COPY.metrics;
  return (
    <View className="mb-4">
      <Text className="text-body-sm font-semibold text-content-secondary mb-3">{title}</Text>
      <View className="flex-row flex-wrap">
        <Metric label={c.completed} value={summary.completedRecordings} />
        <Metric label={c.averageLength} value={formatDuration(summary.averageRecordingLengthSeconds)} />
        <Metric label={c.uploadIssues} value={summary.failedUploadAttempts} />
        <Metric label={c.silentAudio} value={summary.silentAudioEvents} />
        <Metric label={c.reprocessRate} value={formatRate(summary.reprocessRate)} />
        <Metric label={c.soapEditRate} value={formatRate(summary.soapEditRate)} />
        <Metric label={c.missingDetails} value={formatRate(summary.missingMetadataRate)} />
        <Metric
          label={c.p90Processing}
          value={
            summary.processingLatencyP90Seconds === null
              ? 'n/a'
              : formatDuration(summary.processingLatencyP90Seconds)
          }
        />
      </View>
    </View>
  );
}

function BreakdownRow({ item, maxCompleted }: { item: QualityBreakdownSummary; maxCompleted: number }) {
  const colors = useThemeColors();
  const barWidth: DimensionValue =
    maxCompleted > 0 && item.completedRecordings > 0
      ? `${Math.max(8, Math.round((item.completedRecordings / maxCompleted) * 100))}%`
      : '0%';
  const badges = issueLabels(item);

  return (
    <View className="border-t border-border-default py-3">
      <View className="flex-row items-start justify-between">
        <Text className="text-body-sm font-semibold text-content-primary flex-1 pr-2" numberOfLines={2}>
          {item.label}
        </Text>
        <Text className="text-caption font-semibold text-content-secondary ml-2" numberOfLines={1}>
          {item.completedRecordings} rec
        </Text>
      </View>
      <View className="h-1.5 rounded-full bg-surface-sunken overflow-hidden mt-2">
        <View className="h-full rounded-full" style={{ width: barWidth, backgroundColor: colors.brand500 }} />
      </View>
      <View className="flex-row flex-wrap mt-3">
        <Metric label={QUALITY_ANALYTICS_COPY.metrics.averageLength} value={formatDuration(item.averageRecordingLengthSeconds)} />
        <Metric label={QUALITY_ANALYTICS_COPY.metrics.reprocessRate} value={formatRate(item.reprocessRate)} />
        <Metric label={QUALITY_ANALYTICS_COPY.metrics.soapEditRate} value={formatRate(item.soapEditRate)} />
        <Metric
          label={QUALITY_ANALYTICS_COPY.metrics.p90Processing}
          value={item.processingLatencyP90Seconds === null ? 'n/a' : formatDuration(item.processingLatencyP90Seconds)}
        />
      </View>
      {badges.length ? (
        <View className="flex-row flex-wrap mt-1">
          {badges.map((badge) => (
            <Text key={badge} className="text-caption text-warning-500 mr-2 mb-1">
              {badge}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function BreakdownSection({ title, items }: { title: string; items: QualityBreakdownSummary[] }) {
  const colors = useThemeColors();
  if (!items.length) return null;
  const maxCompleted = Math.max(...items.map((item) => item.completedRecordings), 0);

  return (
    <View className="mb-4">
      <View className="flex-row items-center mb-1">
        <Clock3 color={colors.contentTertiary} size={14} />
        <Text className="text-body-sm font-semibold text-content-secondary ml-1">
          {title}
        </Text>
      </View>
      {items.slice(0, 5).map((item) => (
        <BreakdownRow key={`${title}:${item.key}`} item={item} maxCompleted={maxCompleted} />
      ))}
    </View>
  );
}

function ProviderRow({ provider }: { provider: QualityProviderSummary }) {
  const colors = useThemeColors();
  const issueCount =
    provider.failedUploadAttempts + provider.silentAudioEvents + provider.missingMetadataCount;

  return (
    <View className="flex-row items-center border-t border-border-default py-3">
      <View className="w-8 h-8 rounded-full bg-surface-sunken justify-center items-center mr-3">
        <Users color={colors.brand500} size={16} />
      </View>
      <View className="flex-1">
        <Text className="text-body-sm font-semibold text-content-primary" numberOfLines={1}>
          {provider.fullName}
        </Text>
        <Text className="text-caption text-content-tertiary" numberOfLines={1}>
          {provider.role} · {formatLastRecordingAt(provider.lastRecordingAt)}
        </Text>
      </View>
      <View className="items-end ml-3">
        <Text className="text-body-sm font-semibold text-content-primary">
          {provider.completedRecordings}
        </Text>
        <Text className={issueCount > 0 ? 'text-caption text-warning-500' : 'text-caption text-content-tertiary'}>
          {issueCount} issue{issueCount === 1 ? '' : 's'}
        </Text>
      </View>
    </View>
  );
}

export function QualityAnalyticsCard({
  data,
  isLoading,
  isError,
  refetch,
}: QualityAnalyticsCardProps) {
  const colors = useThemeColors();
  const quality = data?.quality ?? null;
  const hasData =
    quality &&
    ((quality.org ? hasActivity(quality.org) : false) ||
      hasActivity(quality.me) ||
      (quality.byAppointmentType?.some(hasActivity) ?? false) ||
      (quality.byModel?.some(hasActivity) ?? false) ||
      (quality.byProvider?.some(hasActivity) ?? false));

  return (
    <Card accessibilityLabel={QUALITY_ANALYTICS_COPY.title}>
      <View className="flex-row items-center mb-4">
        <View className="w-10 h-10 rounded-full bg-brand-50 dark:bg-surface-sunken justify-center items-center mr-3">
          <BarChart3 color={colors.brand500} size={20} />
        </View>
        <View className="flex-1">
          <Text className="text-heading font-bold text-content-primary">
            {QUALITY_ANALYTICS_COPY.title}
          </Text>
          <Text className="text-caption text-content-tertiary">
            {QUALITY_ANALYTICS_COPY.subtitle}
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View className="items-center py-5">
          <ActivityIndicator color={colors.brand500} />
        </View>
      ) : isError || !quality ? (
        <View className="items-center py-4">
          <AlertTriangle color={colors.warning600} size={24} />
          <Text className="text-body-sm text-content-secondary text-center mt-2">
            {QUALITY_ANALYTICS_COPY.unavailable}
          </Text>
          <View className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw color={colors.brand500} size={14} />}
              onPress={() => {
                refetch().catch(() => {});
              }}
            >
              {QUALITY_ANALYTICS_COPY.retry}
            </Button>
          </View>
        </View>
      ) : !hasData ? (
        <View className="items-center py-4">
          <CheckCircle2 color={colors.success600} size={24} />
          <Text className="text-body-sm text-content-secondary text-center mt-2">
            {QUALITY_ANALYTICS_COPY.empty}
          </Text>
        </View>
      ) : (
        <View>
          {quality.org && <SummaryBlock title={QUALITY_ANALYTICS_COPY.org} summary={quality.org} />}
          <SummaryBlock title={QUALITY_ANALYTICS_COPY.you} summary={quality.me} />
          {quality.byAppointmentType?.length ? (
            <BreakdownSection
              title={QUALITY_ANALYTICS_COPY.appointmentTypes}
              items={quality.byAppointmentType}
            />
          ) : null}
          {quality.byModel?.length ? (
            <BreakdownSection title={QUALITY_ANALYTICS_COPY.models} items={quality.byModel} />
          ) : null}
          {quality.byProvider?.length ? (
            <View>
              <View className="flex-row items-center mb-1">
                <Clock3 color={colors.contentTertiary} size={14} />
                <Text className="text-body-sm font-semibold text-content-secondary ml-1">
                  {QUALITY_ANALYTICS_COPY.providers}
                </Text>
              </View>
              {quality.byProvider.slice(0, 5).map((provider) => (
                <ProviderRow key={provider.userId} provider={provider} />
              ))}
            </View>
          ) : null}
        </View>
      )}
    </Card>
  );
}

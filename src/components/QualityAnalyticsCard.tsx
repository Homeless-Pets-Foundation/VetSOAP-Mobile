import React, { useState } from 'react';
import { ActivityIndicator, View, type DimensionValue } from 'react-native';
import { Text } from './ui/Text';
import { AlertTriangle, BarChart3, CheckCircle2, RefreshCw, Users } from 'lucide-react-native';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Collapsible } from './ui/Collapsible';
import { SegmentedControl } from './ui/SegmentedControl';
import { useThemeColors } from '../hooks/useThemeColors';
import { QUALITY_ANALYTICS_COPY } from '../constants/strings';
import {
  breakdownIssueAlerts,
  hasActivity,
  qualityHeadline,
  showsModelBreakdown,
  visibleBreakdownItems,
} from '../api/qualityAnalytics';
import type {
  DashboardQualityEnvelope,
  QualityBreakdownSummary,
  QualityHeadline,
  QualityIssueAlert,
  QualityProviderSummary,
  QualitySummary,
} from '../api/qualityAnalytics';

interface QualityAnalyticsCardProps {
  data?: DashboardQualityEnvelope;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
  /** Gates the Models breakdown (AI model ids) to owner/admin. */
  role?: string | null;
}

type QualityScope = 'org' | 'me';

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

// Exhaustive switch on purpose: a fourth QualityIssueAlert kind must fail
// typecheck ("lacks ending return statement"), not silently render nothing.
function formatIssueAlert(alert: QualityIssueAlert): string {
  const c = QUALITY_ANALYTICS_COPY.issues;
  switch (alert.kind) {
    case 'missingDetails':
      return c.missingDetails.replace('{pct}', String(alert.pct));
    case 'soapEdited':
      return c.soapEdited.replace('{pct}', String(alert.pct));
    case 'reprocessed':
      return (alert.count === 1 ? c.reprocessedOnce : c.reprocessedMany).replace(
        '{count}',
        String(alert.count)
      );
  }
}

/** The collapsed header's one line: "500 completed · 29% missing details · 7 min to 90%". */
function formatHeadline(headline: QualityHeadline | null): string {
  if (!headline) return QUALITY_ANALYTICS_COPY.empty;
  const c = QUALITY_ANALYTICS_COPY.headline;
  const parts = [c.completed(headline.completed)];
  if (headline.missingDetailsPct !== null) parts.push(c.missingDetails(headline.missingDetailsPct));
  if (headline.p90Seconds !== null) parts.push(c.p90(formatDuration(headline.p90Seconds)));
  return parts.join(' · ');
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

function SummaryBlock({ summary }: { summary: QualitySummary }) {
  const c = QUALITY_ANALYTICS_COPY.metrics;
  return (
    <View className="mb-4">
      <View className="flex-row flex-wrap">
        <Metric label={c.completed} value={summary.completedRecordings} />
        <Metric label={c.averageLength} value={formatDuration(summary.averageRecordingLengthSeconds)} />
        <Metric label={c.uploadIssues} value={summary.failedUploadAttempts} />
        <Metric label={c.silentAudio} value={summary.silentAudioEvents} />
        <Metric label={c.reprocesses} value={summary.reprocessCount} />
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

/**
 * The seven count tiles of one breakdown group. These are the surface that makes
 * a retained low-completion group meaningful: `visibleBreakdownItems` keeps a
 * group on any one of these counts alone (see hasDisplayableIssueCounts), so
 * without a tile for each the row would render as the empty "0 rec / n/a
 * everywhere" shell. `Awaiting details` is the raw count; the rate under the
 * same idea lives in SummaryBlock under a different label on purpose.
 */
function MetricGrid({ item }: { item: QualitySummary }) {
  return (
    <View className="flex-row flex-wrap mt-3">
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.averageLength} value={formatDuration(item.averageRecordingLengthSeconds)} />
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.missingDetailsCount} value={item.missingMetadataCount} />
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.uploadIssues} value={item.failedUploadAttempts} />
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.silentAudio} value={item.silentAudioEvents} />
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.reprocesses} value={item.reprocessCount} />
      <Metric label={QUALITY_ANALYTICS_COPY.metrics.soapEditRate} value={formatRate(item.soapEditRate)} />
      <Metric
        label={QUALITY_ANALYTICS_COPY.metrics.p90Processing}
        value={item.processingLatencyP90Seconds === null ? 'n/a' : formatDuration(item.processingLatencyP90Seconds)}
      />
    </View>
  );
}

/**
 * One row per alert, never a flex-wrap bag of unconstrained <Text>: Android
 * under-measures an unconstrained Text in a wrapping row and clips the overflow
 * with no ellipsis. `flex-1` gives it a real width constraint, and no
 * numberOfLines means a sentence needing three lines at 1.3x font scale gets
 * three lines instead of an ellipsis.
 */
function AlertLines({ alerts }: { alerts: QualityIssueAlert[] }) {
  const colors = useThemeColors();
  if (!alerts.length) return null;
  return (
    <View className="mt-2">
      {alerts.map((alert) => (
        <View key={alert.kind} className="flex-row items-start mt-1">
          <View className="mr-1.5 mt-0.5" style={{ flexShrink: 0 }}>
            <AlertTriangle color={colors.statusWarningFg} size={12} />
          </View>
          <Text className="text-caption text-status-warning flex-1">{formatIssueAlert(alert)}</Text>
        </View>
      ))}
    </View>
  );
}

/** Collapsed: label · N rec · alert count · bar. Expanded: + the seven tiles and alert sentences. */
function BreakdownRow({
  item,
  maxCompleted,
  expanded,
  onToggle,
}: {
  item: QualityBreakdownSummary;
  maxCompleted: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colors = useThemeColors();
  const barWidth: DimensionValue =
    maxCompleted > 0 && item.completedRecordings > 0
      ? `${Math.max(8, Math.round((item.completedRecordings / maxCompleted) * 100))}%`
      : '0%';
  const alerts = breakdownIssueAlerts(item);
  const label = item.label.trim() || QUALITY_ANALYTICS_COPY.unlabeledGroup;

  return (
    <View className="border-t border-border-default py-3">
      <Collapsible
        compact
        expanded={expanded}
        onToggle={onToggle}
        title={label}
        badge={`${item.completedRecordings} rec`}
        accessibilityLabel={`${label}. ${item.completedRecordings} rec${
          alerts.length ? `. ${QUALITY_ANALYTICS_COPY.alertCount(alerts.length)}` : ''
        }`}
        belowHeader={
          <View className="flex-row items-center mt-2">
            <View className="flex-1 h-1.5 rounded-full bg-surface-sunken overflow-hidden">
              <View className="h-full rounded-full" style={{ width: barWidth, backgroundColor: colors.brand500 }} />
            </View>
            {/* The count pill only while collapsed — expanded, the sentences below say more. */}
            {alerts.length && !expanded ? (
              <View className="ml-2" style={{ flexShrink: 0 }}>
                <Badge variant="warning">{QUALITY_ANALYTICS_COPY.alertCount(alerts.length)}</Badge>
              </View>
            ) : null}
          </View>
        }
      >
        <MetricGrid item={item} />
        <AlertLines alerts={alerts} />
      </Collapsible>
    </View>
  );
}

function BreakdownSection({ title, items }: { title: string; items: QualityBreakdownSummary[] }) {
  const colors = useThemeColors();
  // One open row per section; state lives here so collapsing the card (which
  // unmounts this section) resets every row for free.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Filter + sort + cap all live in visibleBreakdownItems; when nothing clears
  // the minimum the whole section disappears, header included (intended).
  const visibleItems = visibleBreakdownItems(items);
  if (!visibleItems.length) return null;
  // Scale bars to what is on screen, not to a group that got filtered out.
  const maxCompleted = Math.max(...visibleItems.map((item) => item.completedRecordings), 0);

  return (
    <View className="mb-4">
      <View className="flex-row items-center mb-1">
        <BarChart3 color={colors.contentTertiary} size={14} />
        <Text className="text-body-sm font-semibold text-content-secondary ml-1">
          {title}
        </Text>
      </View>
      {visibleItems.map((item) => (
        <BreakdownRow
          key={`${title}:${item.key}`}
          item={item}
          maxCompleted={maxCompleted}
          expanded={expandedKey === item.key}
          onToggle={() => setExpandedKey((current) => (current === item.key ? null : item.key))}
        />
      ))}
    </View>
  );
}

function ProviderRow({
  provider,
  expanded,
  onToggle,
}: {
  provider: QualityProviderSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colors = useThemeColors();
  const issueCount =
    provider.failedUploadAttempts + provider.silentAudioEvents + provider.missingMetadataCount;
  const issues = `${issueCount} issue${issueCount === 1 ? '' : 's'}`;

  return (
    <View className="border-t border-border-default py-3">
      <Collapsible
        compact
        expanded={expanded}
        onToggle={onToggle}
        leading={
          <View className="w-8 h-8 rounded-full bg-surface-sunken justify-center items-center">
            <Users color={colors.brand500} size={16} />
          </View>
        }
        title={provider.fullName}
        headline={`${provider.role} · ${formatLastRecordingAt(provider.lastRecordingAt)} · ${issues}`}
        badge={`${provider.completedRecordings} rec`}
        accessibilityLabel={`${provider.fullName}. ${provider.role}. ${provider.completedRecordings} rec. ${issues}`}
      >
        <MetricGrid item={provider} />
      </Collapsible>
    </View>
  );
}

export function QualityAnalyticsCard({
  data,
  isLoading,
  isError,
  refetch,
  role,
}: QualityAnalyticsCardProps) {
  const colors = useThemeColors();
  // Collapsed on every mount, never persisted: Home stays mounted across tab
  // switches, so a choice lasts the session, and a persisted "expanded" would
  // defeat the short-Home default on the next cold start (home layout reorg,
  // 2026-09-02 — this card was ~4.5 of Home's 7 viewports).
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState<QualityScope>('org');
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const quality = data?.quality ?? null;
  const hasData =
    quality &&
    ((quality.org ? hasActivity(quality.org) : false) ||
      hasActivity(quality.me) ||
      (quality.byAppointmentType?.some(hasActivity) ?? false) ||
      (quality.byModel?.some(hasActivity) ?? false) ||
      (quality.byProvider?.some(hasActivity) ?? false));
  const headlineText = isLoading
    ? QUALITY_ANALYTICS_COPY.subtitle
    : isError || !quality
      ? QUALITY_ANALYTICS_COPY.unavailable
      : !hasData
        ? QUALITY_ANALYTICS_COPY.empty
        : formatHeadline(qualityHeadline(quality));
  // Practice | You. Falls back to the personal summary when the server sent no
  // practice block (non-admin roles).
  const effectiveScope: QualityScope = quality?.org && scope === 'org' ? 'org' : 'me';
  const summary = quality ? (effectiveScope === 'org' && quality.org ? quality.org : quality.me) : null;

  return (
    <Card accessibilityLabel={QUALITY_ANALYTICS_COPY.title}>
      <Collapsible
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        leading={
          <View className="w-10 h-10 rounded-full bg-brand-50 dark:bg-surface-sunken justify-center items-center">
            <BarChart3 color={colors.brand500} size={20} />
          </View>
        }
        title={QUALITY_ANALYTICS_COPY.title}
        headline={headlineText}
        bodyClassName="mt-4"
      >
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
        ) : !hasData || !summary ? (
          <View className="items-center py-4">
            <CheckCircle2 color={colors.success600} size={24} />
            <Text className="text-body-sm text-content-secondary text-center mt-2">
              {QUALITY_ANALYTICS_COPY.empty}
            </Text>
          </View>
        ) : (
          <View>
            {quality.org ? (
              <View className="mb-3">
                <SegmentedControl
                  options={[
                    { label: QUALITY_ANALYTICS_COPY.org, value: 'org' },
                    { label: QUALITY_ANALYTICS_COPY.you, value: 'me' },
                  ]}
                  value={effectiveScope}
                  onValueChange={(value) => {
                    if (value) setScope(value);
                  }}
                  columns={2}
                  accessibilityLabel={QUALITY_ANALYTICS_COPY.title}
                />
              </View>
            ) : null}
            <SummaryBlock summary={summary} />
            {quality.byAppointmentType?.length ? (
              <BreakdownSection
                title={QUALITY_ANALYTICS_COPY.appointmentTypes}
                items={quality.byAppointmentType}
              />
            ) : null}
            {quality.byProvider?.length ? (
              <View className="mb-4">
                <View className="flex-row items-center mb-1">
                  <Users color={colors.contentTertiary} size={14} />
                  <Text className="text-body-sm font-semibold text-content-secondary ml-1">
                    {QUALITY_ANALYTICS_COPY.providers}
                  </Text>
                </View>
                {quality.byProvider.slice(0, 5).map((provider) => (
                  <ProviderRow
                    key={provider.userId}
                    provider={provider}
                    expanded={expandedProviderId === provider.userId}
                    onToggle={() =>
                      setExpandedProviderId((current) =>
                        current === provider.userId ? null : provider.userId
                      )
                    }
                  />
                ))}
              </View>
            ) : null}
            {showsModelBreakdown(role) && quality.byModel?.length ? (
              <BreakdownSection title={QUALITY_ANALYTICS_COPY.models} items={quality.byModel} />
            ) : null}
          </View>
        )}
      </Collapsible>
    </Card>
  );
}

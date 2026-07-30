import { z } from 'zod';
import { apiClient } from './client';

const QualityRateSchema = z.number().nonnegative().nullable();

const QualitySummarySchema = z.object({
  completedRecordings: z.number().int().nonnegative(),
  averageRecordingLengthSeconds: z.number().nonnegative(),
  failedUploadAttempts: z.number().int().nonnegative(),
  silentAudioEvents: z.number().int().nonnegative(),
  reprocessCount: z.number().int().nonnegative(),
  reprocessRate: QualityRateSchema,
  soapEditedCount: z.number().int().nonnegative(),
  soapEditRate: QualityRateSchema,
  missingMetadataCount: z.number().int().nonnegative(),
  missingMetadataRate: QualityRateSchema,
  processingLatencyAvgSeconds: z.number().nonnegative().nullable(),
  processingLatencyP50Seconds: z.number().nonnegative().nullable(),
  processingLatencyP90Seconds: z.number().nonnegative().nullable(),
});

const QualityProviderSummarySchema = QualitySummarySchema.extend({
  userId: z.string().uuid(),
  fullName: z.string(),
  role: z.string(),
  lastRecordingAt: z.coerce.date().nullable(),
});

const QualityBreakdownSummarySchema = QualitySummarySchema.extend({
  key: z.string(),
  label: z.string(),
});

const DashboardQualitySchema = z.object({
  org: QualitySummarySchema.nullable(),
  me: QualitySummarySchema,
  byAppointmentType: z.array(QualityBreakdownSummarySchema).optional().default([]),
  byModel: z.array(QualityBreakdownSummarySchema).optional().default([]),
  byProvider: z.array(QualityProviderSummarySchema).nullable().optional().default(null),
});

const DashboardQualityEnvelopeSchema = z
  .object({
    periodDays: z.literal(30),
    quality: DashboardQualitySchema.nullable().optional(),
  })
  .passthrough();

export type QualitySummary = z.infer<typeof QualitySummarySchema>;
export type QualityProviderSummary = z.infer<typeof QualityProviderSummarySchema>;
export type QualityBreakdownSummary = z.infer<typeof QualityBreakdownSummarySchema>;
export type DashboardQuality = z.infer<typeof DashboardQualitySchema>;
export type DashboardQualityEnvelope = {
  periodDays: 30;
  quality: DashboardQuality | null;
};

interface QualityAnalyticsUser {
  id: string;
  role?: string | null;
}

/**
 * Breakdown rows (Models, Appointment types) below this many completed
 * recordings are hidden: their rates are computed off a sample too small to
 * mean anything, and an all-zero group used to occupy a visible row slot.
 * Bounds `reprocessRate` only — see the accepted residual in
 * docs/plans/2026-07-29-clinic-quality-card-clipped-copy-fix-plan.md.
 */
export const QUALITY_BREAKDOWN_MIN_RECORDINGS = 5;
export const QUALITY_BREAKDOWN_MAX_ROWS = 5;
export const QUALITY_BREAKDOWN_MAX_ALERTS = 2;
export const QUALITY_MISSING_DETAILS_ALERT_RATE = 0.2;
export const QUALITY_REPROCESS_ALERT_RATE = 0.2;
export const QUALITY_SOAP_EDIT_ALERT_RATE = 0.5;

/**
 * Structured alert descriptors, deliberately not copy: this module must not
 * import the strings catalog (the test harness stubs only ./client), and the
 * derivation stays unit-testable on plain numbers.
 */
export type QualityIssueAlert =
  | { kind: 'missingDetails'; pct: number }
  | { kind: 'soapEdited'; pct: number }
  | { kind: 'reprocessed'; count: number; recordings: number };

export function hasActivity(summary: QualitySummary): boolean {
  return (
    summary.completedRecordings > 0 ||
    summary.failedUploadAttempts > 0 ||
    summary.silentAudioEvents > 0 ||
    summary.reprocessCount > 0 ||
    summary.soapEditedCount > 0 ||
    summary.missingMetadataCount > 0
  );
}

/**
 * Filter, sort and cap breakdown groups for display. The sort is load-bearing,
 * not cosmetic: `byModel` / `byAppointmentType` have no documented server
 * ordering, so the client cannot assume the top groups arrive first. Never
 * sorts the caller's array — `filter` already returns a copy.
 */
export function visibleBreakdownItems(
  items: QualityBreakdownSummary[]
): QualityBreakdownSummary[] {
  return items
    .filter((item) => item.completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS)
    .sort(
      (a, b) => b.completedRecordings - a.completedRecordings || a.label.localeCompare(b.label)
    )
    .slice(0, QUALITY_BREAKDOWN_MAX_ROWS);
}

/**
 * Alerts for one breakdown group. Every descriptor requires a non-zero
 * numerator as well as a rate over threshold: a rate at threshold with a zero
 * count is impossible for well-formed data, but without the guard the card
 * would state "20% missing patient details" or "Reprocessed 0 times across 0
 * recordings" as fact off a corrupt payload.
 */
export function breakdownIssueAlerts(summary: QualitySummary): QualityIssueAlert[] {
  const alerts: QualityIssueAlert[] = [];

  const missingRate = summary.missingMetadataRate ?? 0;
  if (missingRate >= QUALITY_MISSING_DETAILS_ALERT_RATE && summary.missingMetadataCount > 0) {
    alerts.push({ kind: 'missingDetails', pct: Math.round(missingRate * 100) });
  }

  // Counts, not a percentage: reprocessRate legitimately exceeds 1 (several
  // reprocess actions for one recording), and "200% reprocessed" reads broken.
  const reprocessRate = summary.reprocessRate ?? 0;
  if (
    reprocessRate >= QUALITY_REPROCESS_ALERT_RATE &&
    summary.reprocessCount > 0 &&
    summary.completedRecordings > 0
  ) {
    alerts.push({
      kind: 'reprocessed',
      count: summary.reprocessCount,
      recordings: summary.completedRecordings,
    });
  }

  const soapEditRate = summary.soapEditRate ?? 0;
  if (soapEditRate >= QUALITY_SOAP_EDIT_ALERT_RATE && summary.soapEditedCount > 0) {
    alerts.push({ kind: 'soapEdited', pct: Math.round(soapEditRate * 100) });
  }

  return alerts.slice(0, QUALITY_BREAKDOWN_MAX_ALERTS);
}

export function shouldFetchQualityAnalytics(
  user: QualityAnalyticsUser | null | undefined,
  deviceRegistrationPending: boolean,
  deviceRegistrationBlocked: boolean
): boolean {
  return !!user?.id && !deviceRegistrationPending && !deviceRegistrationBlocked;
}

export function parseDashboardQualityEnvelope(value: unknown): DashboardQualityEnvelope {
  const parsed = DashboardQualityEnvelopeSchema.parse(value);
  return {
    periodDays: parsed.periodDays,
    quality: parsed.quality ?? null,
  };
}

export const qualityAnalyticsApi = {
  async getDashboardQuality(): Promise<DashboardQualityEnvelope> {
    const response = await apiClient.get<unknown>('/api/organization/dashboard');
    return parseDashboardQualityEnvelope(response);
  },
};

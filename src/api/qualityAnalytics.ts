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
  // No denominator on purpose. `reprocessCount` counts audit-log reprocess
  // ACTIONS in the window, which may target recordings created before it, while
  // `completedRecordings` counts recordings created in the window
  // (docs/clinic-quality-analytics-dashboard-plan.md:75,79). Neither is the
  // number of distinct recordings reprocessed, so "6 times across 5 recordings"
  // asserted a relationship that does not exist. The row header ('N rec') and
  // the Reprocesses tile already show both numbers separately.
  | { kind: 'reprocessed'; count: number };

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
 * Count-based problems a breakdown row can actually DISPLAY, each with its own
 * metric tile. Retention keys off this rather than `hasActivity` because a row
 * is only worth rendering if it can say something true about the group.
 *
 * `missingMetadataCount` and `soapEditedCount` are deliberately excluded: the
 * row surfaces those only as rates, and rate alerts are suppressed below the
 * sample minimum, so retaining a group for them alone would re-ship the empty
 * "0 rec / n/a everywhere" row this change exists to remove.
 */
export function hasDisplayableIssueCounts(summary: QualitySummary): boolean {
  return (
    summary.failedUploadAttempts > 0 ||
    summary.silentAudioEvents > 0 ||
    summary.reprocessCount > 0
  );
}

/**
 * Filter, sort and cap breakdown groups for display.
 *
 * A group is kept when its completion sample clears the minimum OR it carries
 * count-based problems. Gating on `completedRecordings` alone hid real
 * findings: an appointment type with 20 failed uploads and zero completions is
 * exactly what an owner needs to see, and the org aggregate would report the
 * failures while the breakdown identifying the culprit disappeared.
 *
 * The sort is load-bearing, not cosmetic: `byModel` / `byAppointmentType` have
 * no documented server ordering, so the client cannot assume the top groups
 * arrive first. Never sorts the caller's array — `filter` already returns a
 * copy.
 *
 * Residual: the row cap is still applied by completion volume, so a
 * zero-completion problem group can be cut when more than
 * QUALITY_BREAKDOWN_MAX_ROWS groups qualify. Reserving slots for problem groups
 * is a product decision, not a silent default.
 */
export function visibleBreakdownItems(
  items: QualityBreakdownSummary[]
): QualityBreakdownSummary[] {
  return items
    .filter(
      (item) =>
        item.completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS ||
        hasDisplayableIssueCounts(item)
    )
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

  // Rate-based alerts additionally require a sample behind them. A group can be
  // retained on count-based problems alone (20 failed uploads, zero
  // completions), and stating "100% of notes edited" off one or two recordings
  // asserts far more than the data supports. Count-based alerts need no such
  // gate — "6 reprocesses" is true at any sample size. Groups that clear the
  // minimum are unaffected, so this changes nothing for rows that already
  // rendered.
  const rateSampleIsBigEnough =
    summary.completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS;

  const missingRate = summary.missingMetadataRate ?? 0;
  if (
    rateSampleIsBigEnough &&
    missingRate >= QUALITY_MISSING_DETAILS_ALERT_RATE &&
    summary.missingMetadataCount > 0
  ) {
    alerts.push({ kind: 'missingDetails', pct: Math.round(missingRate * 100) });
  }

  // Counts, not a percentage: reprocessRate legitimately exceeds 1 (several
  // reprocess actions for one recording), and "200% reprocessed" reads broken.
  const reprocessRate = summary.reprocessRate ?? 0;
  // `completedRecordings > 0` stays because it is the denominator of the RATE
  // that triggers this alert (null when zero, per the dashboard plan) — not
  // because the copy cites it. It no longer does.
  if (
    reprocessRate >= QUALITY_REPROCESS_ALERT_RATE &&
    summary.reprocessCount > 0 &&
    summary.completedRecordings > 0
  ) {
    alerts.push({ kind: 'reprocessed', count: summary.reprocessCount });
  }

  const soapEditRate = summary.soapEditRate ?? 0;
  if (
    rateSampleIsBigEnough &&
    soapEditRate >= QUALITY_SOAP_EDIT_ALERT_RATE &&
    summary.soapEditedCount > 0
  ) {
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

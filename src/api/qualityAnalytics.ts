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
  byProvider: z.array(QualityProviderSummarySchema).nullable(),
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

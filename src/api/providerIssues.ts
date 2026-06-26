import { z } from 'zod';
import { apiClient } from './client';

const ProviderIssueSchema = z.object({
  issueKey: z.string().min(1),
  primaryProvider: z.string().min(1),
  primaryModel: z.string().nullable(),
  fallbackProvider: z.string().nullable(),
  fallbackModel: z.string().nullable(),
  credentialScope: z.enum(['organization', 'platform', 'unknown']),
  outcome: z.enum(['fallback_success', 'fallback_failure', 'primary_failure_no_fallback']),
  errorClass: z.string().min(1),
  externalCode: z.string().nullable(),
  lastSeenAt: z.string(),
  occurrencesLast24h: z.number().int().nonnegative(),
  actionableByOrgAdmin: z.boolean(),
  recommendedAction: z.string().min(1),
  status: z.enum(['active', 'acknowledged', 'resolved']),
});

const ProviderIssuesResponseSchema = z.object({
  issues: z.array(ProviderIssueSchema),
});

const ProviderIssueAcknowledgeResponseSchema = z.object({
  acknowledged: z.literal(true),
});

export type ProviderIssue = z.infer<typeof ProviderIssueSchema>;
export type ProviderIssuesResponse = z.infer<typeof ProviderIssuesResponseSchema>;

export const providerIssuesApi = {
  async list(params: { status?: 'active' | 'all'; days?: number } = {}) {
    const response = await apiClient.get<unknown>('/api/organization/provider-issues', params);
    return ProviderIssuesResponseSchema.parse(response);
  },

  async acknowledge(issueKey: string) {
    const response = await apiClient.post<unknown>('/api/organization/provider-issues/acknowledge', {
      issueKey,
    });
    return ProviderIssueAcknowledgeResponseSchema.parse(response);
  },
};

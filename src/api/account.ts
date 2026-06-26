import { apiClient } from './client';
import type { User } from '../types';
import { z } from 'zod';

export interface UpdateMeInput {
  fullName?: string;
  avatarUrl?: string | null;
}

export interface UpdateMeResponse {
  user: User;
}

export type SubscriptionStatus = 'trial' | 'trialing' | 'active' | 'past_due' | 'canceled' | string;

export interface BillingCapabilities {
  canStartCheckout: boolean;
  canManagePortal: boolean;
  canCancelSubscription: boolean;
  canResumeSubscription: boolean;
  canEndTrial: boolean;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  seatPrice: number;
}

export interface InvoiceSummary {
  id: string;
  date: number;
  amount: number;
  status: string;
  url: string | null;
}

export interface SubscriptionInfo {
  id: string | null;
  status: SubscriptionStatus;
  billingCycle: 'monthly' | 'annual';
  cohort: string | null;
  plan: SubscriptionPlan;
  seatCount: number;
  billableAmount: number;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  cancelAtPeriodEnd: boolean;
  invoices: InvoiceSummary[];
  capabilities: BillingCapabilities;
}

export interface PortalSessionResponse {
  url: string;
}

export interface DeleteAccountResponse {
  scheduledPurgeAt?: string | null;
}

const InvoiceSummarySchema = z.object({
  id: z.string(),
  date: z.number(),
  amount: z.number(),
  status: z.string(),
  url: z.string().nullable(),
});

const BillingCapabilitiesSchema = z.object({
  canStartCheckout: z.boolean(),
  canManagePortal: z.boolean(),
  canCancelSubscription: z.boolean(),
  canResumeSubscription: z.boolean(),
  canEndTrial: z.boolean(),
});

const SubscriptionInfoSchema = z.object({
  id: z.string().nullable(),
  status: z.string(),
  billingCycle: z.enum(['monthly', 'annual']),
  cohort: z.string().nullable(),
  plan: z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    seatPrice: z.number(),
  }),
  seatCount: z.number(),
  billableAmount: z.number(),
  trialEndsAt: z.string().nullable(),
  stripeCustomerId: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  invoices: z.array(InvoiceSummarySchema),
  capabilities: BillingCapabilitiesSchema,
});

const PortalSessionResponseSchema = z.object({
  url: z.string().url(),
});

export const accountApi = {
  updateMe: (input: UpdateMeInput) => apiClient.patch<UpdateMeResponse>('/auth/me', input),
  getSubscription: async () => {
    const response = await apiClient.get<unknown>('/api/billing/subscription');
    return SubscriptionInfoSchema.parse(response);
  },
  createBillingPortalSession: async () => {
    const response = await apiClient.post<unknown>('/api/billing/portal');
    return PortalSessionResponseSchema.parse(response);
  },
  requestDeletion: (confirmation: 'DELETE') =>
    apiClient.post<DeleteAccountResponse>('/auth/delete-account', { confirmation }),
};

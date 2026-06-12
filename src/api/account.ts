import { apiClient } from './client';
import type { User } from '../types';

export interface UpdateMeInput {
  fullName?: string;
  avatarUrl?: string | null;
}

export interface UpdateMeResponse {
  user: User;
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | string;

export interface SubscriptionInfo {
  plan: string;
  status: SubscriptionStatus;
  trialEndsAt?: string | null;
  renewsAt?: string | null;
  seatsUsed?: number | null;
  seatsTotal?: number | null;
  manageUrl?: string | null;
}

export interface DeleteAccountResponse {
  scheduledPurgeAt?: string | null;
}

export const accountApi = {
  updateMe: (input: UpdateMeInput) => apiClient.patch<UpdateMeResponse>('/auth/me', input),
  getSubscription: () => apiClient.get<SubscriptionInfo>('/api/billing/subscription'),
  requestDeletion: (confirmation: 'DELETE') =>
    apiClient.post<DeleteAccountResponse>('/auth/delete-account', { confirmation }),
};

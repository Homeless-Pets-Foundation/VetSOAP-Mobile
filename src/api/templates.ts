import { apiClient } from './client';
import type { Template, PaginatedResponse } from '../types';

export interface ListTemplatesParams {
  isActive?: boolean;
  species?: string;
  appointmentType?: string;
  type?: 'soap' | 'email' | 'dental' | 'ultrasound' | 'xray';
  page?: number;
  limit?: number;
}

export const templatesApi = {
  async list(params: ListTemplatesParams = {}): Promise<PaginatedResponse<Template>> {
    const query: Record<string, string | number | undefined> = { limit: 100 };
    if (params.isActive !== undefined) query.isActive = String(params.isActive);
    if (params.species) query.species = params.species;
    if (params.appointmentType) query.appointmentType = params.appointmentType;
    if (params.type) query.type = params.type;
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;
    return apiClient.get('/api/templates', query);
  },

  async get(id: string): Promise<Template> {
    return apiClient.get(`/api/templates/${id}`);
  },
};

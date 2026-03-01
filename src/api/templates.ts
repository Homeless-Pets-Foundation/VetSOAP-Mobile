import { apiClient } from './client';
import type { Template, PaginatedResponse } from '../types';

export const templatesApi = {
  async list(params: { isActive?: boolean } = {}): Promise<PaginatedResponse<Template>> {
    const query: Record<string, string | number | undefined> = {
      limit: 100,
    };
    if (params.isActive !== undefined) {
      query.isActive = String(params.isActive);
    }
    return apiClient.get('/api/templates', query);
  },
};

import { apiClient, ApiError } from './client';
import type { Patient, UpdatePatient, PaginatedResponse, Recording } from '../types';

export interface PimsLookupResult {
  patientName: string;
  clientName: string | null;
  species: string | null;
  breed: string | null;
}

export interface ListPatientRecordingsParams {
  page?: number;
  limit?: number;
}

export const patientsApi = {
  async get(id: string): Promise<Patient> {
    return apiClient.get(`/api/patients/${id}`);
  },

  async update(id: string, data: UpdatePatient): Promise<Patient> {
    return apiClient.request(`/api/patients/${id}`, { method: 'PATCH', body: data });
  },

  async listRecordings(
    patientId: string,
    params: ListPatientRecordingsParams = {}
  ): Promise<PaginatedResponse<Recording>> {
    const queryParams: Record<string, string | number | undefined> = {};
    if (params.page !== undefined) queryParams.page = params.page;
    if (params.limit !== undefined) queryParams.limit = params.limit;
    return apiClient.get(`/api/patients/${patientId}/recordings`, queryParams);
  },

  async regenerateSummary(id: string): Promise<void> {
    await apiClient.request(`/api/patients/${id}/regenerate-summary`, { method: 'POST', body: {} });
  },

  async lookupByPimsId(pimsId: string): Promise<PimsLookupResult | null> {
    try {
      return await apiClient.get<PimsLookupResult>('/api/patients/lookup', { pimsId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
};

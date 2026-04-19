import { apiClient } from './client';
import type { SoapNote } from '../types';

export type SoapNoteSection = 'subjective' | 'objective' | 'assessment' | 'plan';

export interface UpdateSoapNotePayload {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  additionalNotes?: string | null;
}

export type ExportTarget =
  | 'clipboard'
  | 'manual'
  | 'pdf'
  | 'ezyvet'
  | 'vetmatrix'
  | 'cornerstone'
  | 'avimark'
  | 'impromed';

export interface ExportSoapNotePayload {
  exportedTo: ExportTarget;
}

export const soapNotesApi = {
  async update(id: string, payload: UpdateSoapNotePayload): Promise<SoapNote> {
    return apiClient.request(`/api/soap-notes/${id}`, {
      method: 'PATCH',
      body: payload,
    });
  },

  async export(id: string, payload: ExportSoapNotePayload): Promise<SoapNote> {
    return apiClient.request(`/api/soap-notes/${id}/export`, {
      method: 'POST',
      body: payload,
    });
  },
};

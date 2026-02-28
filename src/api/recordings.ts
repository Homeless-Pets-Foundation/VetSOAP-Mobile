import { apiClient } from './client';
import type {
  Recording,
  CreateRecording,
  PaginatedResponse,
  UploadUrlResponse,
  RecordingStatus,
} from '../types';

export interface ListRecordingsParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
  status?: RecordingStatus;
  search?: string;
}

export const recordingsApi = {
  async list(params: ListRecordingsParams = {}): Promise<PaginatedResponse<Recording>> {
    return apiClient.get('/api/recordings', params as Record<string, string | number | undefined>);
  },

  async get(id: string): Promise<Recording> {
    return apiClient.get(`/api/recordings/${id}`);
  },

  async create(data: CreateRecording): Promise<Recording> {
    return apiClient.post('/api/recordings', data);
  },

  async delete(id: string): Promise<void> {
    return apiClient.delete(`/api/recordings/${id}`);
  },

  async getUploadUrl(
    recordingId: string,
    fileName: string,
    contentType = 'audio/mp4'
  ): Promise<UploadUrlResponse> {
    return apiClient.post(`/api/recordings/${recordingId}/upload-url`, {
      fileName,
      contentType,
    });
  },

  async confirmUpload(recordingId: string, fileKey: string): Promise<Recording> {
    return apiClient.post(`/api/recordings/${recordingId}/confirm-upload`, { fileKey });
  },

  /**
   * Full upload flow: create record → get presigned URL → upload file → confirm
   */
  async createWithFile(
    data: CreateRecording,
    fileUri: string,
    contentType = 'audio/mp4'
  ): Promise<Recording> {
    // Step 1: Create recording record
    const recording = await this.create(data);

    try {
      // Step 2: Get presigned upload URL
      const { uploadUrl, fileKey } = await this.getUploadUrl(
        recording.id,
        'recording.m4a',
        contentType
      );

      // Step 3: Read local file and upload to storage
      const fileResponse = await fetch(fileUri);
      const blob = await fileResponse.blob();

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': contentType },
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file to storage');
      }

      // Step 4: Confirm upload and trigger processing
      return await this.confirmUpload(recording.id, fileKey);
    } catch (error) {
      // Clean up: delete the recording if upload failed
      await this.delete(recording.id).catch(() => {});
      throw error;
    }
  },

  async retry(id: string): Promise<Recording> {
    return apiClient.post(`/api/recordings/${id}/retry`);
  },

  async getSoapNote(recordingId: string) {
    return apiClient.get(`/api/recordings/${recordingId}/soap-note`);
  },
};

import { apiClient } from './client';
import type {
  Recording,
  CreateRecording,
  PaginatedResponse,
  UploadUrlResponse,
  RecordingStatus,
  SoapNote,
} from '../types';

const UPLOAD_TIMEOUT_MS = 300000; // 5 minutes for R2 uploads

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
    contentType = 'audio/mp4',
    fileSizeBytes?: number
  ): Promise<UploadUrlResponse> {
    return apiClient.post(`/api/recordings/${recordingId}/upload-url`, {
      fileName,
      contentType,
      ...(fileSizeBytes !== undefined && { fileSizeBytes }),
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
      // Read local file to get blob and size
      const fileResponse = await fetch(fileUri);
      const blob = await fileResponse.blob();

      // Step 2: Get presigned upload URL (include file size for server validation)
      const { uploadUrl, fileKey } = await this.getUploadUrl(
        recording.id,
        'recording.m4a',
        contentType,
        blob.size || undefined
      );

      // Step 3: Upload to R2 with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

      try {
        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: blob,
          headers: { 'Content-Type': contentType },
          signal: controller.signal,
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `Upload failed (${uploadResponse.status}): ${uploadResponse.statusText}`
          );
        }
      } finally {
        clearTimeout(timeout);
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

  async getSoapNote(recordingId: string): Promise<SoapNote> {
    return apiClient.get(`/api/recordings/${recordingId}/soap-note`);
  },
};

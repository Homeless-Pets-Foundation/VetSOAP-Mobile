import { apiClient } from './client';
import type {
  Recording,
  CreateRecording,
  PaginatedResponse,
  UploadUrlResponse,
  RecordingStatus,
  SoapNote,
} from '../types';
import {
  recordingIdSchema,
  createRecordingSchema,
  searchQuerySchema,
} from '../lib/validation';
import { validateUploadUrl } from '../lib/sslPinning';

const UPLOAD_TIMEOUT_MS = 300000; // 5 minutes for R2 uploads
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

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
    const sanitized = { ...params } as Record<string, string | number | undefined>;
    if (params.search) {
      sanitized.search = searchQuerySchema.parse(params.search);
    }
    return apiClient.get('/api/recordings', sanitized);
  },

  async get(id: string): Promise<Recording> {
    recordingIdSchema.parse(id);
    return apiClient.get(`/api/recordings/${id}`);
  },

  async create(data: CreateRecording): Promise<Recording> {
    const validated = createRecordingSchema.parse(data);
    return apiClient.post('/api/recordings', validated);
  },

  async delete(id: string): Promise<void> {
    recordingIdSchema.parse(id);
    return apiClient.delete(`/api/recordings/${id}`);
  },

  async getUploadUrl(
    recordingId: string,
    fileName: string,
    contentType = 'audio/mp4',
    fileSizeBytes?: number
  ): Promise<UploadUrlResponse> {
    recordingIdSchema.parse(recordingId);
    return apiClient.post(`/api/recordings/${recordingId}/upload-url`, {
      fileName,
      contentType,
      ...(fileSizeBytes !== undefined && { fileSizeBytes }),
    });
  },

  async confirmUpload(recordingId: string, fileKey: string): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
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
    // Step 1: Create recording record (validates data via this.create)
    const recording = await this.create(data);

    let r2UploadComplete = false;

    try {
      // Read local file to get blob and size
      const fileResponse = await fetch(fileUri);
      const blob = await fileResponse.blob();
      const fileSizeBytes =
        blob.size || Number(fileResponse.headers.get('content-length')) || undefined;

      // Enforce client-side file size limit
      if (fileSizeBytes && fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 500MB.`
        );
      }

      // Step 2: Get presigned upload URL (include file size for server validation)
      const { uploadUrl, fileKey } = await this.getUploadUrl(
        recording.id,
        'recording.m4a',
        contentType,
        fileSizeBytes
      );

      // Validate the presigned upload URL targets a trusted storage domain
      validateUploadUrl(uploadUrl);

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

      r2UploadComplete = true;

      // Step 4: Confirm upload and trigger processing
      return await this.confirmUpload(recording.id, fileKey);
    } catch (error) {
      // Only delete if the file hasn't been uploaded to R2 yet.
      // If R2 upload succeeded but confirm failed, leave the recording
      // in "uploading" state so the user can retry.
      if (!r2UploadComplete) {
        await this.delete(recording.id).catch(() => {});
      }
      throw error;
    }
  },

  async retry(id: string): Promise<Recording> {
    recordingIdSchema.parse(id);
    return apiClient.post(`/api/recordings/${id}/retry`);
  },

  async getSoapNote(recordingId: string): Promise<SoapNote> {
    recordingIdSchema.parse(recordingId);
    return apiClient.get(`/api/recordings/${recordingId}/soap-note`);
  },
};

import {
  getInfoAsync,
  createUploadTask,
  FileSystemUploadType,
} from 'expo-file-system/legacy';
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

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
]);

export interface UploadProgressEvent {
  loaded: number;
  total: number;
  percent: number;
}

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
    if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
      throw new Error(`Unsupported audio format: ${contentType}`);
    }
    return apiClient.post(`/api/recordings/${recordingId}/upload-url`, {
      fileName,
      contentType,
      ...(fileSizeBytes !== undefined && { fileSizeBytes }),
    });
  },

  async confirmUpload(
    recordingId: string,
    fileKey: string,
    opts?: { segmentKeys?: string[]; segmentCount?: number }
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.post(`/api/recordings/${recordingId}/confirm-upload`, {
      fileKey,
      ...(opts?.segmentKeys ? { segmentKeys: opts.segmentKeys, segmentCount: opts.segmentCount } : {}),
    });
  },

  /**
   * Full upload flow: create record → get presigned URL → upload file → confirm
   */
  async createWithFile(
    data: CreateRecording,
    fileUri: string,
    contentType = 'audio/mp4',
    options?: { onUploadProgress?: (event: UploadProgressEvent) => void }
  ): Promise<Recording> {
    // Step 1: Create recording record (validates data via this.create)
    const recording = await this.create(data);

    let r2UploadComplete = false;

    try {
      // Read local file info (fetch() doesn't support file:// URIs on Android)
      const fileInfo = await getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        throw new Error('Failed to read the recorded audio file. Please try recording again.');
      }
      const fileSizeBytes = fileInfo.size ?? 0;
      if (!fileSizeBytes) {
        throw new Error('The recorded audio file is empty. Please try recording again.');
      }
      // Enforce client-side file size limit
      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
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

      // Step 3: Upload to R2 using createUploadTask (supports file:// URIs + progress)
      const uploadTask = createUploadTask(
        uploadUrl,
        fileUri,
        {
          httpMethod: 'PUT',
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers: { 'Content-Type': contentType },
        },
        options?.onUploadProgress
          ? (progress) => {
              const total = progress.totalBytesExpectedToSend;
              const loaded = progress.totalBytesSent;
              options.onUploadProgress!({
                loaded,
                total,
                percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
              });
            }
          : undefined
      );

      const uploadResult = await uploadTask.uploadAsync();
      if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
        throw new Error(
          `Upload to storage failed (HTTP ${uploadResult?.status ?? 'unknown'}). Please try again.`
        );
      }

      r2UploadComplete = true;

      // Step 4: Confirm upload and trigger processing
      const confirmed = await this.confirmUpload(recording.id, fileKey);
      return confirmed;
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

  /**
   * Multi-segment upload flow: create record → upload each segment → confirm with segment keys
   */
  async createWithSegments(
    data: CreateRecording,
    segments: { uri: string; duration: number }[],
    contentType = 'audio/mp4',
    options?: { onUploadProgress?: (event: UploadProgressEvent) => void }
  ): Promise<Recording> {
    const recording = await this.create(data);
    let r2UploadComplete = false;

    try {
      const segmentKeys: string[] = [];
      const totalSegments = segments.length;

      for (let i = 0; i < totalSegments; i++) {
        const segment = segments[i];
        const segmentFileName = `recording_segment_${i}.m4a`;

        // Read local file info
        const fileInfo = await getInfoAsync(segment.uri);
        if (!fileInfo.exists) {
          throw new Error(`Failed to read audio segment ${i + 1}. Please try recording again.`);
        }
        const fileSizeBytes = fileInfo.size ?? 0;
        if (!fileSizeBytes) {
          throw new Error(`Audio segment ${i + 1} is empty. Please try recording again.`);
        }
        if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
          throw new Error(
            `Segment ${i + 1} too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 500MB.`
          );
        }

        // Get presigned URL for this segment
        const { uploadUrl, fileKey } = await this.getUploadUrl(
          recording.id,
          segmentFileName,
          contentType,
          fileSizeBytes
        );
        validateUploadUrl(uploadUrl);

        // Upload segment to R2
        const segmentProgressBase = (i / totalSegments) * 100;
        const segmentProgressRange = 100 / totalSegments;

        const uploadTask = createUploadTask(
          uploadUrl,
          segment.uri,
          {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers: { 'Content-Type': contentType },
          },
          options?.onUploadProgress
            ? (progress) => {
                const total = progress.totalBytesExpectedToSend;
                const loaded = progress.totalBytesSent;
                const segmentPercent = total > 0 ? (loaded / total) * 100 : 0;
                const overallPercent = segmentProgressBase + (segmentPercent * segmentProgressRange) / 100;
                options.onUploadProgress!({
                  loaded,
                  total,
                  percent: Math.round(overallPercent),
                });
              }
            : undefined
        );

        const uploadResult = await uploadTask.uploadAsync();
        if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
          throw new Error(
            `Upload of segment ${i + 1} failed (HTTP ${uploadResult?.status ?? 'unknown'}). Please try again.`
          );
        }

        segmentKeys.push(fileKey);
      }

      r2UploadComplete = true;

      // Confirm upload with all segment keys
      const confirmed = await this.confirmUpload(recording.id, segmentKeys[0], {
        segmentKeys,
        segmentCount: segmentKeys.length,
      });
      return confirmed;
    } catch (error) {
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

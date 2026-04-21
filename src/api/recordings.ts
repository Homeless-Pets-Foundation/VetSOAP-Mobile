import {
  getInfoAsync,
  createUploadTask,
  FileSystemUploadType,
} from 'expo-file-system/legacy';
import { apiClient, ApiError } from './client';
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
import { getIdempotencyUuid } from '../lib/random';
import type { PendingConfirm } from '../types/multiPatient';

const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB
const R2_UPLOAD_TIMEOUT_MS = 600_000; // 10 minutes per file upload

/**
 * Phase label attached to thrown Errors from the upload pipeline so callers
 * (uploadSlot) can classify the failure without fragile message matching.
 * Kept as a union string rather than an enum to stay trivially JSON-safe for
 * telemetry payloads.
 */
export type UploadPhase =
  | 'silent_check'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'unknown';

type TaggedError = Error & { uploadPhase?: UploadPhase };

function tagPhase(error: unknown, phase: UploadPhase): never {
  if (error instanceof Error) {
    (error as TaggedError).uploadPhase = phase;
    throw error;
  }
  const wrapped = new Error(String(error ?? 'Upload failed')) as TaggedError;
  wrapped.uploadPhase = phase;
  throw wrapped;
}

function phaseError(phase: UploadPhase, message: string): never {
  const err = new Error(message) as TaggedError;
  err.uploadPhase = phase;
  throw err;
}

export function getUploadPhase(error: unknown): UploadPhase {
  if (error instanceof Error && (error as TaggedError).uploadPhase) {
    return (error as TaggedError).uploadPhase!;
  }
  return 'unknown';
}

function generateIdempotencyKey(): string {
  // expo-crypto → global crypto → Math.random (per CLAUDE.md rule 26: the
  // idempotency key is the only non-security random on iOS Hermes where
  // Math.random is permitted). Centralized in src/lib/random.ts.
  return getIdempotencyUuid();
}

function extensionFromUri(uri: string, fallback = 'm4a'): string {
  const match = uri.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : fallback;
}

/**
 * Race a promise against a timeout. Rejects with a user-friendly message
 * if the timeout fires first. Callers pass `onTimeout` to cancel the native
 * work (e.g. `uploadTask.cancelAsync()`) — otherwise the task keeps running
 * after the wrapper has rejected, which caused orphaned R2 objects and
 * deleted-but-still-uploading server records.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (onTimeout) {
        try { onTimeout(); } catch { /* best-effort */ }
      }
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timeoutId); resolve(value); },
      (error) => { clearTimeout(timeoutId); reject(error); }
    );
  });
}

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

export interface TranslateResult {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface EmailDraftResult {
  subject: string;
  body: string;
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

  async create(
    data: CreateRecording,
    options?: { isDraft?: boolean }
  ): Promise<Recording> {
    const validated = createRecordingSchema.parse(data);
    const idempotencyKey = generateIdempotencyKey();
    return apiClient.post('/api/recordings', { ...validated, isDraft: options?.isDraft ?? false }, idempotencyKey);
  },

  async delete(id: string): Promise<void> {
    recordingIdSchema.parse(id);
    return apiClient.delete(`/api/recordings/${id}`);
  },

  /**
   * PATCH metadata on a recording still in `draft` status. Used by the
   * draft-save-on-finish upload flow to flush edited formData to the server
   * before confirm-upload commits the draft into processing.
   *
   * The server accepts any subset of the create fields; only sent keys are
   * updated. Returns the refreshed Recording. Server-side contract:
   *   200 — updated.
   *   400 — malformed body or cross-org templateId.
   *   403 — caller is not the recording owner and not an admin/owner.
   *   404 — recording not found in caller's org.
   *   409 `{ code: 'NOT_DRAFT' }` — recording has moved past draft.
   *
   * Callers are expected to catch ALL failures and fall back to delete +
   * fresh create, so an old server (no route → 404) or any transient issue
   * degrades to the Tier 1 behavior rather than committing stale metadata.
   */
  async updateDraftMetadata(
    recordingId: string,
    data: Partial<CreateRecording>
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.patch(`/api/recordings/${recordingId}/draft-metadata`, data);
  },

  async getUploadUrl(
    recordingId: string,
    fileName: string,
    contentType = 'audio/x-m4a',
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
    try {
      return await apiClient.post(`/api/recordings/${recordingId}/confirm-upload`, {
        fileKey,
        ...(opts?.segmentKeys ? { segmentKeys: opts.segmentKeys, segmentCount: opts.segmentCount } : {}),
      });
    } catch (error) {
      // 409 means the recording is already past 'uploading' state. This happens when the
      // client times out waiting for the confirm-upload response and retries — the first
      // request succeeded and processing already started. Fetch current state and return it
      // so the caller can poll normally rather than showing a spurious error.
      if (error instanceof ApiError && error.status === 409) {
        const current = await this.get(recordingId).catch(() => null);
        if (current && current.status !== 'uploading' && current.status !== 'failed') {
          return current;
        }
      }
      throw error;
    }
  },

  /**
   * Full upload flow: create record → get presigned URL → upload file → confirm.
   *
   * Pass `options.resume` (obtained from a previous `onR2Complete` callback)
   * to skip recording creation and R2 upload on a retry — only the confirm is
   * retried. This prevents duplicate server recordings when the first attempt
   * uploaded to R2 but failed at confirm time.
   */
  async createWithFile(
    data: CreateRecording,
    fileUri: string,
    contentType = 'audio/x-m4a',
    options?: {
      onUploadProgress?: (event: UploadProgressEvent) => void;
      onR2Complete?: (hint: PendingConfirm) => void;
      resume?: PendingConfirm;
      existingRecordingId?: string;
    }
  ): Promise<Recording> {
    // Retry path: R2 already holds the file; just re-run confirm.
    if (options?.resume) {
      const { recordingId, fileKey, segmentKeys, segmentCount } = options.resume;
      return this.confirmUpload(recordingId, fileKey, segmentKeys ? { segmentKeys, segmentCount } : undefined);
    }

    // Step 1: Create recording record (validates data via this.create) or use existing draft
    let recording: Recording;
    let isExistingRecording = false;
    if (options?.existingRecordingId) {
      // Use provided draft recording ID instead of creating a new one. If the
      // server row is gone (404) — user's form wasn't edited so the
      // draftMetadataDirty probe never ran — fall through to fresh create
      // rather than dead-end the user on local audio that still exists.
      try {
        recording = await this.get(options.existingRecordingId);
        isExistingRecording = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          if (__DEV__) console.warn('[upload] existing draft missing, creating fresh');
          try {
            recording = await this.create(data);
          } catch (createError) { tagPhase(createError, 'create_draft'); }
        } else {
          tagPhase(e, 'create_draft');
        }
      }
    } else {
      try {
        recording = await this.create(data);
      } catch (e) { tagPhase(e, 'create_draft'); }
    }

    let r2UploadComplete = false;

    try {
      // Read local file info (fetch() doesn't support file:// URIs on Android)
      const fileInfo = await getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        phaseError('silent_check', 'Failed to read the recorded audio file. Please try recording again.');
      }
      const fileSizeBytes = fileInfo.size ?? 0;
      if (!fileSizeBytes) {
        phaseError('silent_check', 'The recorded audio file is empty. Please try recording again.');
      }
      // Enforce client-side file size limit
      if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
        phaseError(
          'silent_check',
          `File too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 250MB.`
        );
      }

      // Step 2: Get presigned upload URL (include file size for server validation)
      let uploadUrl: string;
      let fileKey: string;
      let warnings: string[] | undefined;
      try {
        const resp = await this.getUploadUrl(
          recording.id,
          'recording.m4a',
          contentType,
          fileSizeBytes
        );
        uploadUrl = resp.uploadUrl;
        fileKey = resp.fileKey;
        warnings = resp.warnings;
      } catch (e) { tagPhase(e, 'presign'); }
      if (warnings?.length) {
        if (__DEV__) console.warn('[upload]', ...warnings);
      }
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

      let uploadResult;
      try {
        uploadResult = await withTimeout(
          uploadTask.uploadAsync(),
          R2_UPLOAD_TIMEOUT_MS,
          'Upload timed out. Please check your connection and try again.',
          () => { uploadTask.cancelAsync().catch(() => {}); }
        );
      } catch (e) { tagPhase(e, 'r2_put'); }
      if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
        phaseError(
          'r2_put',
          `Upload to storage failed (HTTP ${uploadResult?.status ?? 'unknown'}). Please try again.`
        );
      }

      r2UploadComplete = true;

      // Notify caller that the bytes are safe on R2 — they can now persist a
      // resume hint so a failed confirm below can be retried without creating
      // a second server recording.
      if (options?.onR2Complete) {
        try {
          options.onR2Complete({ recordingId: recording.id, fileKey });
        } catch {
          // Best-effort — caller's persistence failure shouldn't block confirm.
        }
      }

      // Step 4: Confirm upload and trigger processing
      let confirmed: Recording;
      try {
        confirmed = await this.confirmUpload(recording.id, fileKey);
      } catch (e) { tagPhase(e, 'confirm'); }
      return confirmed;
    } catch (error) {
      // Only delete if the file hasn't been uploaded to R2 yet.
      // If R2 upload succeeded but confirm failed, leave the recording
      // in "uploading" state so the user can retry.
      // Also, never delete if using an existing recording ID (draft) — let the user retry later.
      if (!r2UploadComplete && !isExistingRecording) {
        await this.delete(recording.id).catch(() => {});
      }
      throw error;
    }
  },

  /**
   * Multi-segment upload flow: create record → upload each segment → confirm with segment keys.
   *
   * See `createWithFile` for the semantics of `options.resume` and
   * `options.onR2Complete`. Resume is only supported once ALL segments have
   * been uploaded to R2 — partial resumes are not attempted because the
   * server-side tracking would get complex and the partial-failure path
   * already cleans up. For a partial failure the catch block deletes the
   * server record and the retry starts fresh.
   */
  async createWithSegments(
    data: CreateRecording,
    segments: { uri: string; duration: number }[],
    contentType = 'audio/x-m4a',
    options?: {
      onUploadProgress?: (event: UploadProgressEvent) => void;
      onR2Complete?: (hint: PendingConfirm) => void;
      resume?: PendingConfirm;
      existingRecordingId?: string;
    }
  ): Promise<Recording> {
    // Retry path: all segments already on R2, just re-run confirm.
    if (options?.resume) {
      const { recordingId, fileKey, segmentKeys, segmentCount } = options.resume;
      return this.confirmUpload(recordingId, fileKey, segmentKeys ? { segmentKeys, segmentCount } : undefined);
    }

    // Use provided draft recording ID or create a new one. If the server row
    // is gone (404) — user didn't edit the form so the draftMetadataDirty
    // probe never ran — fall through to a fresh create instead of dead-ending
    // on local audio that still exists.
    let recording: Recording;
    let isExistingRecording = false;
    if (options?.existingRecordingId) {
      try {
        recording = await this.get(options.existingRecordingId);
        isExistingRecording = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          if (__DEV__) console.warn('[upload] existing draft missing, creating fresh');
          try {
            recording = await this.create(data);
          } catch (createError) { tagPhase(createError, 'create_draft'); }
        } else {
          tagPhase(e, 'create_draft');
        }
      }
    } else {
      try {
        recording = await this.create(data);
      } catch (e) { tagPhase(e, 'create_draft'); }
    }

    let r2UploadComplete = false;
    const segmentKeys: string[] = [];
    const totalSegments = segments.length;
    let completedSegments = 0;

    try {
      for (let i = 0; i < totalSegments; i++) {
        const segment = segments[i];
        const ext = extensionFromUri(segment.uri);
        const segmentFileName = `recording_segment_${i}.${ext}`;

        // Read local file info
        const fileInfo = await getInfoAsync(segment.uri);
        if (!fileInfo.exists) {
          phaseError('silent_check', `Failed to read audio segment ${i + 1}. Please try recording again.`);
        }
        const fileSizeBytes = fileInfo.size ?? 0;
        if (!fileSizeBytes) {
          phaseError('silent_check', `Audio segment ${i + 1} is empty. Please try recording again.`);
        }
        if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
          phaseError(
            'silent_check',
            `Segment ${i + 1} too large (${Math.round(fileSizeBytes / 1024 / 1024)}MB). Maximum allowed size is 250MB.`
          );
        }

        // Get presigned URL for this segment
        let uploadUrl: string;
        let fileKey: string;
        let warnings: string[] | undefined;
        try {
          const resp = await this.getUploadUrl(
            recording.id,
            segmentFileName,
            contentType,
            fileSizeBytes
          );
          uploadUrl = resp.uploadUrl;
          fileKey = resp.fileKey;
          warnings = resp.warnings;
        } catch (e) { tagPhase(e, 'presign'); }
        if (warnings?.length) {
          if (__DEV__) console.warn(`[upload] segment ${i + 1}:`, ...warnings);
        }
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

        let uploadResult;
        try {
          uploadResult = await withTimeout(
            uploadTask.uploadAsync(),
            R2_UPLOAD_TIMEOUT_MS,
            `Upload of segment ${i + 1} timed out. Please check your connection and try again.`,
            () => { uploadTask.cancelAsync().catch(() => {}); }
          );
        } catch (e) { tagPhase(e, 'r2_put'); }
        if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
          phaseError(
            'r2_put',
            `Upload of segment ${i + 1} failed (HTTP ${uploadResult?.status ?? 'unknown'}). Please try again.`
          );
        }

        segmentKeys.push(fileKey);
        completedSegments++;
      }

      r2UploadComplete = true;

      // All segments are on R2. Let the caller persist a resume hint before we
      // attempt confirm — if confirm fails, retry will skip straight to confirm
      // rather than re-uploading every segment.
      if (options?.onR2Complete) {
        try {
          options.onR2Complete({
            recordingId: recording.id,
            fileKey: segmentKeys[0],
            segmentKeys,
            segmentCount: segmentKeys.length,
          });
        } catch {
          // Best-effort — caller's persistence failure shouldn't block confirm.
        }
      }

      // Confirm upload with all segment keys
      let confirmed: Recording;
      try {
        confirmed = await this.confirmUpload(recording.id, segmentKeys[0], {
          segmentKeys,
          segmentCount: segmentKeys.length,
        });
      } catch (e) { tagPhase(e, 'confirm'); }
      return confirmed;
    } catch (error) {
      // Only delete if R2 upload didn't complete and it's a new recording (not a draft).
      // Never delete existing draft recordings — let the user retry later.
      if (!r2UploadComplete && !isExistingRecording) {
        await this.delete(recording.id).catch(() => {});
      }
      // Enrich the error message for partial multi-segment failures, preserving
      // the phase tag so uploadSlot can still classify correctly.
      if (completedSegments > 0 && completedSegments < totalSegments && error instanceof Error) {
        const suffix = isExistingRecording
          ? ' (segments uploaded were queued for processing)'
          : ' (the recording has been removed and will need to be re-recorded.)';
        const rethrown = new Error(
          `${error.message} (${completedSegments} of ${totalSegments} segments had uploaded successfully${suffix}`
        ) as Error & { uploadPhase?: UploadPhase };
        rethrown.uploadPhase = (error as Error & { uploadPhase?: UploadPhase }).uploadPhase;
        throw rethrown;
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

  async translate(
    recordingId: string,
    opts: { targetLanguage: string }
  ): Promise<TranslateResult> {
    recordingIdSchema.parse(recordingId);
    return apiClient.post(`/api/recordings/${recordingId}/translate`, {
      targetLanguage: opts.targetLanguage,
    });
  },

  async generateEmailDraft(
    recordingId: string,
    opts: { mode: 'visit_summary' }
  ): Promise<EmailDraftResult> {
    recordingIdSchema.parse(recordingId);
    return apiClient.post(`/api/recordings/${recordingId}/email-draft`, {
      mode: opts.mode,
    });
  },
};

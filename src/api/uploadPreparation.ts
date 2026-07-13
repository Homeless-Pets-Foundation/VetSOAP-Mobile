import type { Recording } from '../types';

export interface PreparedUploadEntry {
  index: number;
  uploadUrl: string;
  fileKey: string;
  expiresAt: string;
}

export interface PrepareUploadResponse {
  outcome: 'prepared' | 'already_uploaded' | 'already_processed';
  recording: Recording;
  replacedMissingRecordingId: boolean;
  uploads?: PreparedUploadEntry[];
  warnings: string[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const RECORDING_STATUSES = new Set([
  'draft', 'uploading', 'uploaded', 'transcribing', 'transcribed',
  'generating', 'retry_scheduled', 'completed', 'failed', 'pending_metadata',
]);

function keyPattern(organizationId: string, recordingId: string, index: number, count: number): RegExp {
  const org = organizationId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = recordingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return count === 1
    ? new RegExp(`^recordings/${org}/${id}\\.[A-Za-z0-9]+$`, 'i')
    : new RegExp(`^recordings/${org}/${id}_segment_${index}\\.[A-Za-z0-9]+$`, 'i');
}

/** Pure server-envelope validation. URL trust validation remains at the caller. */
export function validatePreparedUploadEnvelope(
  raw: unknown,
  expectedFileCount: number,
  nowMs = Date.now(),
): PrepareUploadResponse {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_response');
  const value = raw as Partial<PrepareUploadResponse>;
  if (!['prepared', 'already_uploaded', 'already_processed'].includes(value.outcome ?? '')) {
    throw new Error('invalid_outcome');
  }
  if (
    !value.recording ||
    typeof value.recording !== 'object' ||
    !UUID_RE.test(value.recording.id ?? '') ||
    !UUID_RE.test(value.recording.organizationId ?? '')
  ) {
    throw new Error('invalid_recording');
  }
  if (!RECORDING_STATUSES.has(value.recording.status)) throw new Error('invalid_recording_status');
  if (
    typeof value.replacedMissingRecordingId !== 'boolean' ||
    !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')
  ) throw new Error('invalid_response');

  if (value.outcome !== 'prepared') {
    if (value.uploads !== undefined) throw new Error('unexpected_uploads');
    return value as PrepareUploadResponse;
  }
  if (!Array.isArray(value.uploads) || value.uploads.length !== expectedFileCount) {
    throw new Error('invalid_upload_count');
  }
  const keys = new Set<string>();
  for (let index = 0; index < value.uploads.length; index++) {
    const upload = value.uploads[index];
    if (
      !upload || upload.index !== index || typeof upload.uploadUrl !== 'string' || upload.uploadUrl.length === 0 ||
      typeof upload.fileKey !== 'string' ||
      !keyPattern(value.recording.organizationId, value.recording.id, index, expectedFileCount).test(upload.fileKey) ||
      typeof upload.expiresAt !== 'string' || !Number.isFinite(Date.parse(upload.expiresAt)) || Date.parse(upload.expiresAt) <= nowMs
    ) throw new Error('invalid_upload_manifest');
    if (keys.has(upload.fileKey)) throw new Error('duplicate_file_key');
    keys.add(upload.fileKey);
  }
  return value as PrepareUploadResponse;
}

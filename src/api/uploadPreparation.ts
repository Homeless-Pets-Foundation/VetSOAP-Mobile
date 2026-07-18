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

export const UPLOAD_INTENT_CONFLICT_REASONS = {
  create: [
    'existing_recording_mismatch',
    'existing_recording_completed',
    'existing_recording_committed',
    'existing_recording_not_reusable',
    'race_winner_unresolved',
  ],
  prepare: [
    'canonical_recording_mismatch',
    'prepared_manifest_mismatch',
    'committed_manifest_mismatch',
    'resume_state_changed',
    'save_state_changed',
    'transition_state_changed',
  ],
  confirm: [
    'stored_manifest_invalid',
    'confirmed_manifest_mismatch',
    'completed_audio_mismatch',
    'committed_audio_mismatch',
    'saved_audio_state_changed',
    'commit_state_changed',
  ],
  recovery: [
    'source_missing',
    'source_ambiguous',
    'source_changed',
    'replacement_key_conflict',
  ],
} as const;

export type UploadIntentConflictStage = keyof typeof UPLOAD_INTENT_CONFLICT_REASONS;
export type UploadIntentConflictReason =
  (typeof UPLOAD_INTENT_CONFLICT_REASONS)[UploadIntentConflictStage][number];

export interface UploadIntentConflictDetails {
  stage: UploadIntentConflictStage;
  reason: UploadIntentConflictReason;
  recoveryAction: 'inspect';
}

export type UploadIntentRecoveryResponse =
  | { outcome: 'already_uploaded'; recording: Recording }
  | { outcome: 'already_processed'; recording: Recording }
  | { outcome: 'restart_available'; conflict: UploadIntentConflictDetails }
  | { outcome: 'unresolved'; conflict: UploadIntentConflictDetails }
  | {
      outcome: 'prepared';
      recording: Recording;
      replacedRecordingId: string | null;
      uploads: PreparedUploadEntry[];
      warnings: string[];
    };

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

function validateRecording(raw: unknown): Recording {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !UUID_RE.test((raw as Recording).id ?? '') ||
    !UUID_RE.test((raw as Recording).organizationId ?? '') ||
    !RECORDING_STATUSES.has((raw as Recording).status)
  ) {
    throw new Error('invalid_recording');
  }
  return raw as Recording;
}

export function validateUploadIntentConflictDetails(raw: unknown): UploadIntentConflictDetails {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_upload_conflict');
  const value = raw as Partial<UploadIntentConflictDetails>;
  if (
    typeof value.stage !== 'string' ||
    !Object.prototype.hasOwnProperty.call(UPLOAD_INTENT_CONFLICT_REASONS, value.stage) ||
    typeof value.reason !== 'string' ||
    value.recoveryAction !== 'inspect'
  ) {
    throw new Error('invalid_upload_conflict');
  }
  const allowed = UPLOAD_INTENT_CONFLICT_REASONS[value.stage as UploadIntentConflictStage] as readonly string[];
  if (!allowed.includes(value.reason)) throw new Error('invalid_upload_conflict');
  return value as UploadIntentConflictDetails;
}

function validatePreparedEntries(
  raw: unknown,
  recording: Recording,
  expectedFileCount: number,
): PreparedUploadEntry[] {
  if (!Array.isArray(raw) || raw.length !== expectedFileCount) throw new Error('invalid_upload_count');
  const keys = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const upload = raw[index] as PreparedUploadEntry | undefined;
    if (
      !upload || upload.index !== index || typeof upload.uploadUrl !== 'string' || upload.uploadUrl.length === 0 ||
      typeof upload.fileKey !== 'string' ||
      !keyPattern(recording.organizationId, recording.id, index, expectedFileCount).test(upload.fileKey) ||
      typeof upload.expiresAt !== 'string' || !Number.isFinite(Date.parse(upload.expiresAt))
    ) throw new Error('invalid_upload_manifest');
    if (keys.has(upload.fileKey)) throw new Error('duplicate_file_key');
    keys.add(upload.fileKey);
  }
  return raw as PreparedUploadEntry[];
}

/** Pure server-envelope validation. URL trust validation remains at the caller. */
export function validatePreparedUploadEnvelope(
  raw: unknown,
  expectedFileCount: number,
): PrepareUploadResponse {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_response');
  const value = raw as Partial<PrepareUploadResponse>;
  if (!['prepared', 'already_uploaded', 'already_processed'].includes(value.outcome ?? '')) {
    throw new Error('invalid_outcome');
  }
  value.recording = validateRecording(value.recording);
  if (
    typeof value.replacedMissingRecordingId !== 'boolean' ||
    !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')
  ) throw new Error('invalid_response');

  if (value.outcome !== 'prepared') {
    if (value.uploads !== undefined) throw new Error('unexpected_uploads');
    return value as PrepareUploadResponse;
  }
  value.uploads = validatePreparedEntries(value.uploads, value.recording, expectedFileCount);
  return value as PrepareUploadResponse;
}

export function validateUploadIntentRecoveryEnvelope(
  raw: unknown,
  expectedFileCount: number,
): UploadIntentRecoveryResponse {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_recovery_response');
  const value = raw as Partial<UploadIntentRecoveryResponse>;
  if (value.outcome === 'already_uploaded' || value.outcome === 'already_processed') {
    return { outcome: value.outcome, recording: validateRecording(value.recording) };
  }
  if (value.outcome === 'restart_available' || value.outcome === 'unresolved') {
    return {
      outcome: value.outcome,
      conflict: validateUploadIntentConflictDetails(value.conflict),
    };
  }
  if (value.outcome === 'prepared') {
    const recording = validateRecording(value.recording);
    if (
      value.replacedRecordingId !== null &&
      (typeof value.replacedRecordingId !== 'string' || !UUID_RE.test(value.replacedRecordingId))
    ) {
      throw new Error('invalid_replaced_recording');
    }
    if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string')) {
      throw new Error('invalid_recovery_response');
    }
    return {
      outcome: 'prepared',
      recording,
      replacedRecordingId: value.replacedRecordingId,
      uploads: validatePreparedEntries(value.uploads, recording, expectedFileCount),
      warnings: value.warnings,
    };
  }
  throw new Error('invalid_recovery_outcome');
}

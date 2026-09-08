import { isGenericMissingModelKey, getFailedRemedyModel, hasReprocessRemedyForCategory, remedyRequiresDistinctProvider, type RecordingFailureRemedyCategory } from './aiModels';
import type { OrgAiModels, RecordingStatus } from '../types';

export type RecordingRetryPresentation = 'hidden' | 'retry' | 'audio_unavailable';

/**
 * Central retry presentation for failed, scheduled, and stale processing
 * states. A typed missing-audio race overrides a stale cached audioFileUrl.
 */
export function getRecordingRetryPresentation(input: {
  status: RecordingStatus;
  audioFileUrl: string | null;
  isPollingStale: boolean;
  audioMissingError: boolean;
}): RecordingRetryPresentation {
  const retryEligible =
    input.status === 'failed' ||
    input.status === 'retry_scheduled' ||
    input.isPollingStale;
  if (!retryEligible) return 'hidden';
  if (!input.audioFileUrl || input.audioMissingError) return 'audio_unavailable';
  return 'retry';
}

// Ported from Connect packages/core/src/logic/recording-retry.ts.
export const RECORDING_PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_AUDIO', 'AUDIO_TOO_LONG', 'MISSING_AUDIO', 'MISSING_DEEPGRAM_KEY',
  'INVALID_DEEPGRAM_KEY', 'MISSING_TRANSCRIPTION_KEY', 'INVALID_TRANSCRIPTION_KEY',
  'MISSING_LLM_KEY', 'INVALID_LLM_KEY', 'PAYMENT_REQUIRED', 'CREDENTIALS_REQUIRED',
  'TRIAL_SOAP_LIMIT_REACHED', 'R2_NOT_CONFIGURED', 'IMPORT_FAILED',
]);

export function isRecordingPermanentFailure(errorCode?: string | null): boolean {
  return typeof errorCode === 'string' && RECORDING_PERMANENT_ERROR_CODES.has(errorCode);
}

export function getRecordingFailureRemedyCategory(errorCode?: string | null): RecordingFailureRemedyCategory | null {
  switch (errorCode) {
    case 'AUDIO_TOO_LONG':
    case 'MISSING_DEEPGRAM_KEY':
    case 'INVALID_DEEPGRAM_KEY':
    case 'MISSING_TRANSCRIPTION_KEY':
    case 'INVALID_TRANSCRIPTION_KEY': return 'transcription';
    case 'MISSING_LLM_KEY':
    case 'INVALID_LLM_KEY': return 'soap';
    default: return null;
  }
}

export function getRecordingFailureAction(recording: {
  status: RecordingStatus; errorCode?: string | null; foreignLanguage?: boolean;
  reprocessTranscriptionModel?: string | null;
  reprocessSoapModel?: string | null;
  costBreakdown?: { transcriptionModel?: string | null; modelUsed?: string | null } | null;
}, models?: OrgAiModels | null): 'retry' | 'reprocess' | 'reprocess_blocked' {
  const category = getRecordingFailureRemedyCategory(recording.errorCode);
  if (recording.status !== 'failed' || !category || !models) return 'retry';
  return hasReprocessRemedyForCategory(models, category, {
    recordingForeignLanguage: recording.foreignLanguage,
    excludeModelId: getFailedRemedyModel({
      remedyCategory: category, remedyErrorCode: recording.errorCode,
      currentTranscriptionModel: recording.reprocessTranscriptionModel ?? recording.costBreakdown?.transcriptionModel,
      currentSoapModel: recording.reprocessSoapModel ?? recording.costBreakdown?.modelUsed,
    }),
    allowUnknownMissingProvider: isGenericMissingModelKey(recording.errorCode),
    requireDistinctProvider: remedyRequiresDistinctProvider(recording.errorCode),
  }) ? 'reprocess' : 'reprocess_blocked';
}

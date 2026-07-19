import type { RecordingStatus } from '../types';

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

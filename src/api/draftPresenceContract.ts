import { z } from 'zod';
import type { RecordingStatus } from '../types';
import { recordingIdSchema } from '../lib/validation';

export const DRAFT_PRESENCE_MAX_IDS = 50;

const recordingStatusSchema = z.enum([
  'draft',
  'uploading',
  'uploaded',
  'transcribing',
  'transcribed',
  'generating',
  'retry_scheduled',
  'completed',
  'failed',
  'pending_metadata',
] satisfies readonly RecordingStatus[]);

export const draftPresenceRequestSchema = z
  .strictObject({
    recordingIds: z.array(recordingIdSchema).min(1).max(DRAFT_PRESENCE_MAX_IDS),
  })
  .refine(
    ({ recordingIds }) => new Set(recordingIds).size === recordingIds.length,
    { message: 'Recording IDs must be unique', path: ['recordingIds'] },
  );

const draftPresenceRecordingSchema = z.strictObject({
  id: recordingIdSchema,
  status: recordingStatusSchema,
});

export const draftPresenceResponseSchema = z.strictObject({
  recordings: z.array(draftPresenceRecordingSchema).max(DRAFT_PRESENCE_MAX_IDS),
});

export interface DraftPresenceRecording {
  id: string;
  status: RecordingStatus;
}

export interface DraftPresenceResponse {
  recordings: DraftPresenceRecording[];
}

/**
 * Parse a response without trusting either its shape or its relationship to
 * the request. A duplicate or foreign ID invalidates the entire chunk.
 */
export function parseDraftPresenceResponse(
  requestedRecordingIds: readonly string[],
  value: unknown,
): DraftPresenceResponse {
  const parsedRequest = draftPresenceRequestSchema.parse({
    recordingIds: requestedRecordingIds,
  });
  const parsedResponse = draftPresenceResponseSchema.parse(value);
  const requested = new Set(parsedRequest.recordingIds);
  const returned = new Set<string>();

  for (const recording of parsedResponse.recordings) {
    if (!requested.has(recording.id) || returned.has(recording.id)) {
      throw new Error('Invalid draft presence response');
    }
    returned.add(recording.id);
  }

  return parsedResponse;
}

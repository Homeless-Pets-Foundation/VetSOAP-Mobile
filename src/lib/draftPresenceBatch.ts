import type { RecordingStatus } from '../types';
import { DRAFT_PRESENCE_MAX_IDS, type DraftPresenceResponse } from '../api/draftPresenceContract';

export type DraftPresenceStatus = RecordingStatus | 'missing';

export interface DraftPresenceSnapshot {
  requestedIds: ReadonlySet<string>;
  statusById: ReadonlyMap<string, DraftPresenceStatus>;
}

export type DraftPresenceChunkRequest = (
  recordingIds: readonly string[],
) => Promise<DraftPresenceResponse>;

export function dedupeRecordingIds(recordingIds: readonly string[]): string[] {
  return [...new Set(recordingIds)].sort();
}

function chunkRecordingIds(recordingIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < recordingIds.length; index += DRAFT_PRESENCE_MAX_IDS) {
    chunks.push(recordingIds.slice(index, index + DRAFT_PRESENCE_MAX_IDS));
  }
  return chunks;
}

/**
 * Execute all chunks with at most two requests in flight. Nothing is
 * published unless every chunk succeeds; a caller guard failure has the same
 * all-unknown result as a transport or validation failure.
 */
export async function runDraftPresenceBatches(
  recordingIds: readonly string[],
  requestChunk: DraftPresenceChunkRequest,
  isScopeValid: () => boolean,
): Promise<DraftPresenceSnapshot | null> {
  const uniqueIds = dedupeRecordingIds(recordingIds);
  if (!isScopeValid()) return null;
  if (uniqueIds.length === 0) {
    return {
      requestedIds: new Set<string>(),
      statusById: new Map<string, DraftPresenceStatus>(),
    };
  }

  const chunks = chunkRecordingIds(uniqueIds);
  const responses = new Array<DraftPresenceResponse>(chunks.length);
  let cursor = 0;
  let failed = false;

  const workers = Array.from(
    { length: Math.min(2, chunks.length) },
    async () => {
      while (!failed) {
        const index = cursor;
        cursor += 1;
        const chunk = chunks[index];
        if (!chunk) return;
        if (!isScopeValid()) {
          failed = true;
          return;
        }
        try {
          const response = await requestChunk(chunk);
          if (!isScopeValid()) {
            failed = true;
            return;
          }
          responses[index] = response;
        } catch {
          failed = true;
          return;
        }
      }
    },
  );

  await Promise.all(workers);
  if (failed || !isScopeValid() || responses.some((response) => response === undefined)) {
    return null;
  }

  const statusById = new Map<string, DraftPresenceStatus>(
    uniqueIds.map((id) => [id, 'missing']),
  );
  for (const response of responses) {
    for (const recording of response.recordings) {
      statusById.set(recording.id, recording.status);
    }
  }

  return {
    requestedIds: new Set(uniqueIds),
    statusById,
  };
}

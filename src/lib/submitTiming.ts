/**
 * Ephemeral per-recording timestamps used to compute time-to-SOAP.
 *
 * Flow:
 *   1. `record.tsx` calls `recordSubmitFinish(recordingId)` once the user
 *      hits Finish and `recordSubmitAttempt(recordingId)` at upload start.
 *   2. `app/(app)/(tabs)/recordings/[id].tsx` reads via `getSubmitTimestamps`
 *      when the SOAP first renders, emits `soap_visible`, and clears the
 *      entry so it never fires twice for the same row.
 *
 * Stored in-memory only. Cold start drops the state (fine — time-to-SOAP is
 * meaningful only when the user stays in the app long enough to see it; if
 * they background / re-launch we just skip the metric).
 *
 * Kept in a singleton module rather than React context because the two
 * producers and the consumer live on different navigation trees and sharing
 * via context would require threading a provider everywhere.
 */

interface SubmitTimestamps {
  finishAt?: number;
  submitAt?: number;
}

const timestamps = new Map<string, SubmitTimestamps>();

export function recordSubmitFinish(recordingId: string): void {
  if (!recordingId) return;
  const existing = timestamps.get(recordingId) ?? {};
  if (existing.finishAt === undefined) existing.finishAt = Date.now();
  timestamps.set(recordingId, existing);
}

export function recordSubmitAttempt(recordingId: string): void {
  if (!recordingId) return;
  const existing = timestamps.get(recordingId) ?? {};
  existing.submitAt = Date.now();
  timestamps.set(recordingId, existing);
}

export function getSubmitTimestamps(recordingId: string): SubmitTimestamps | undefined {
  return timestamps.get(recordingId);
}

export function clearSubmitTimestamps(recordingId: string): void {
  timestamps.delete(recordingId);
}

/** Test-only: wipe all entries. */
export function __resetSubmitTimingForTest(): void {
  timestamps.clear();
}

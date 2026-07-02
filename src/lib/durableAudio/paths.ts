/**
 * Pure path + identifier helpers for the durable recorder. No expo / RN imports
 * so it is testable and safe to import on any path (recovery, fallback).
 *
 * The native module validates userId/slotId/recordingId on every entry point
 * before touching the filesystem (plan: reject `/`, `\`, `..`, NUL, or chars
 * outside [A-Za-z0-9_-]). This JS mirror enforces the SAME contract before any
 * JS-side filesystem op AND when accepting a durable recordingId restored from
 * a stash/draft round-trip (CLAUDE.md Rule 15 — preserve the no-path-traversal,
 * no-remote-URI guarantee that validateSegments() gave the old segments[] path).
 */

export const DURABLE_DIR_NAME = 'durable-recordings';
export const AUDIO_FILENAME = 'audio.aac';
export const MANIFEST_FILENAME = 'manifest.json';

// Only these characters are permitted in a durable id segment.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidDurableId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0) return false;
  // Defense-in-depth: '.' is already excluded by SAFE_ID_RE, but the plan calls
  // out '..' explicitly, so check it directly too.
  if (id.includes('..')) return false;
  if (id.includes('\0')) return false;
  return SAFE_ID_RE.test(id);
}

export function assertValidDurableId(id: unknown): asserts id is string {
  if (!isValidDurableId(id)) {
    throw new Error('Invalid durable id');
  }
}

/**
 * Relative directory (under the per-platform durable root) for one recording.
 * Validates both ids; throws on anything that could escape the user scope.
 */
export function buildDurableRelativePath(userId: string, recordingId: string): string {
  assertValidDurableId(userId);
  assertValidDurableId(recordingId);
  return `${DURABLE_DIR_NAME}/${userId}/${recordingId}`;
}

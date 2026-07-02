/**
 * Cross-platform free-disk helper for the durable recorder's JS-side gates.
 *
 * Layering (plan: Storage Policy): the pre-record 500/250 MiB checks run HERE in
 * JS at Record-tab mount / record-start. The while-recording 100 MiB graceful
 * stop and the 225/240 MB source-size limits are enforced NATIVELY by the
 * capture loop (a JS poll can be starved/backgrounded), not here.
 */
import { Paths } from 'expo-file-system';

const MiB = 1024 * 1024;

/** Warn the user below this much free space before starting a new recording. */
export const FREE_SPACE_WARN_BYTES = 500 * MiB;
/** Block starting a new recording below this much free space. */
export const FREE_SPACE_BLOCK_BYTES = 250 * MiB;

export type FreeSpaceGate = 'ok' | 'warn' | 'block';

/** Pure threshold classifier (testable without a device). */
export function classifyFreeSpace(freeBytes: number): FreeSpaceGate {
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return 'ok'; // unknown -> fail open
  if (freeBytes < FREE_SPACE_BLOCK_BYTES) return 'block';
  if (freeBytes < FREE_SPACE_WARN_BYTES) return 'warn';
  return 'ok';
}

/** Current free disk space in bytes, or null if unavailable. */
export function getFreeDiskBytes(): number | null {
  try {
    const v = Paths.availableDiskSpace;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pre-record gate. Unknown free space fails OPEN ('ok') so a capacity-API
 * hiccup never blocks recording (mirrors the offline-fail-open posture).
 */
export function checkPreRecordFreeSpace(): FreeSpaceGate {
  const free = getFreeDiskBytes();
  if (free === null) return 'ok';
  return classifyFreeSpace(free);
}

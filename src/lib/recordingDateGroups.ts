import type { Recording } from '../types';
import { RECORDINGS_LIST_COPY } from '../constants/strings';

/**
 * Date grouping for the Recordings list (layout tier 3, 2026-09-02): a flat run
 * of twenty-plus identical cards gave no sense of when anything happened.
 *
 * Pure and RN-free so the day boundaries are executable under test; `nowMs` is
 * injected rather than read from `Date.now()`.
 */
export type RecordingDateGroupKey = 'today' | 'yesterday' | 'this_week' | 'earlier';

export interface RecordingDateSection {
  key: RecordingDateGroupKey;
  title: string;
  data: Recording[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const GROUP_TITLES: Record<RecordingDateGroupKey, string> = {
  today: RECORDINGS_LIST_COPY.dateGroupToday,
  yesterday: RECORDINGS_LIST_COPY.dateGroupYesterday,
  this_week: RECORDINGS_LIST_COPY.dateGroupThisWeek,
  earlier: RECORDINGS_LIST_COPY.dateGroupEarlier,
};

/**
 * Rule 11: every timestamp is validated before it reaches a Date. A missing or
 * unparseable value is 0, which lands in "Earlier" rather than 1970-as-today.
 */
export function getTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getCreatedAtMs(recording: Recording): number {
  return getTimestampMs(recording.createdAt);
}

/** Submitted-at with a created-at fallback — the precedence the list already sorts by. */
export function getSubmittedAtMs(recording: Recording): number {
  return getTimestampMs(recording.submittedAt) || getCreatedAtMs(recording);
}

/**
 * Local calendar-day boundaries, and a ROLLING seven days for "This week" —
 * a locale week-start rule would put Monday's visit in "Earlier" on a Sunday.
 * A future timestamp (clock skew) reads as today, never as its own group.
 */
export function dateGroupKeyFor(ms: number, nowMs: number): RecordingDateGroupKey {
  if (!Number.isFinite(ms) || ms <= 0) return 'earlier';
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  if (ms >= todayMs) return 'today';
  if (ms >= todayMs - DAY_MS) return 'yesterday';
  if (ms >= todayMs - 6 * DAY_MS) return 'this_week';
  return 'earlier';
}

/**
 * Groups without reordering: the caller has already sorted (and pinned freshly
 * submitted rows first), so within a group the incoming order is preserved.
 * Empty groups are omitted so no header sits over blank space.
 */
export function groupRecordingsByDate(recordings: Recording[], nowMs: number): RecordingDateSection[] {
  const buckets = new Map<RecordingDateGroupKey, Recording[]>();
  for (const recording of recordings) {
    const key = dateGroupKeyFor(getSubmittedAtMs(recording), nowMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(recording);
    else buckets.set(key, [recording]);
  }
  return (['today', 'yesterday', 'this_week', 'earlier'] as const)
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, title: GROUP_TITLES[key], data: buckets.get(key) as Recording[] }));
}

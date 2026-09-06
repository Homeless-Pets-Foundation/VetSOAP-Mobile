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
 * Start of the local day `daysBack` calendar days before `nowMs`.
 *
 * `setDate` walks CALENDAR days, so this survives DST; subtracting a fixed
 * 24h from start-of-today does not. After a fall-back Sunday (a 25h day)
 * `todayMs - DAY_MS` lands at 01:00 yesterday, filing a 00:30 recording under
 * "This week"; after spring-forward (23h) it lands at 23:00 two days ago,
 * filing a 23:30 recording from TWO days ago under "Yesterday".
 */
function startOfDayBefore(nowMs: number, daysBack: number): number {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - daysBack);
  return day.getTime();
}

/**
 * Local calendar-day boundaries, and a ROLLING seven days for "This week" —
 * a locale week-start rule would put Monday's visit in "Earlier" on a Sunday.
 * A future timestamp (clock skew) reads as today, never as its own group.
 */
export function dateGroupKeyFor(ms: number, nowMs: number): RecordingDateGroupKey {
  if (!Number.isFinite(ms) || ms <= 0) return 'earlier';
  if (ms >= startOfDayBefore(nowMs, 0)) return 'today';
  if (ms >= startOfDayBefore(nowMs, 1)) return 'yesterday';
  if (ms >= startOfDayBefore(nowMs, 6)) return 'this_week';
  return 'earlier';
}

/**
 * Groups without reordering: the caller has already sorted (and pinned freshly
 * submitted rows first), so within a group the incoming order is preserved.
 * Empty groups are omitted so no header sits over blank space.
 *
 * `pinnedIds` are rows the caller just submitted and pinned to the top, and
 * they are forced into "Today" regardless of their timestamps. Without that,
 * grouping silently undoes the pin: `submittedAt` is optional and is null for a
 * merged local draft, so a resumed three-day-old draft submitted moments ago
 * falls back to its `createdAt` and lands in "This week" — several sections
 * below the banner that points at it.
 */
export function groupRecordingsByDate(
  recordings: Recording[],
  nowMs: number,
  pinnedIds: readonly string[] = []
): RecordingDateSection[] {
  const pinned = new Set(pinnedIds);
  const buckets = new Map<RecordingDateGroupKey, Recording[]>();
  for (const recording of recordings) {
    const key = pinned.has(recording.id)
      ? 'today'
      : dateGroupKeyFor(getSubmittedAtMs(recording), nowMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(recording);
    else buckets.set(key, [recording]);
  }
  return (['today', 'yesterday', 'this_week', 'earlier'] as const)
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, title: GROUP_TITLES[key], data: buckets.get(key) as Recording[] }));
}

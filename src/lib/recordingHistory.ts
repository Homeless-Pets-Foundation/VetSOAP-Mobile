import type { Recording } from '../types';
import { getSubmittedAtMs } from './recordingDateGroups';

export type DateFilter =
  | { preset: 'all' | 'today' | 'yesterday' | 'last7' }
  | { preset: 'custom'; from: string; through: string };

export interface ActivityBounds {
  activityFrom?: string;
  activityBefore?: string;
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
    throw new RangeError('Choose a valid date.');
  }
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Choose a valid date.');
  const date = new Date(`${value}T00:00:00`);
  if (localDateKey(date) !== value) throw new RangeError('Choose a valid date.');
  return date;
}

export function activityBounds(filter: DateFilter, nowMs: number): ActivityBounds {
  if (filter.preset === 'all') return {};
  let from: Date;
  let through: Date;
  if (filter.preset === 'custom') {
    from = parseLocalDay(filter.from);
    through = parseLocalDay(filter.through);
    if (from.getTime() > through.getTime()) {
      throw new RangeError('From must be on or before Through.');
    }
  } else {
    from = new Date(nowMs);
    localDateKey(from);
    from.setHours(0, 0, 0, 0);
    through = new Date(from);
    if (filter.preset === 'yesterday') {
      from.setDate(from.getDate() - 1);
      through = new Date(from);
    } else if (filter.preset === 'last7') {
      from.setDate(from.getDate() - 6);
    }
  }
  // Calendar days preserve local midnight across 23-hour and 25-hour days.
  through.setDate(through.getDate() + 1);
  return { activityFrom: from.toISOString(), activityBefore: through.toISOString() };
}

export function matchesActivityRange(recording: Recording, bounds: ActivityBounds): boolean {
  if (!bounds.activityFrom && !bounds.activityBefore) return true;
  const activityAt = getSubmittedAtMs(recording);
  return activityAt >= Date.parse(bounds.activityFrom ?? '') &&
    activityAt < Date.parse(bounds.activityBefore ?? '');
}

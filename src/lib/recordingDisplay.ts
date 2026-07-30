import type { Recording } from '../types';
import { UNTITLED_VISIT_LABEL } from '../constants/strings';

export function displayPatientName(
  recording: Pick<Recording, 'patientName'> | { patientName?: string | null } | null | undefined
): string {
  const name = recording?.patientName?.trim();
  return name ? name : UNTITLED_VISIT_LABEL;
}

export function isUntitledVisit(
  recording: Pick<Recording, 'patientName'> | { patientName?: string | null } | null | undefined
): boolean {
  return !recording?.patientName?.trim();
}

/**
 * Compact, list-safe date for a row label — `Jul 29`, or `Jul 29, 2025` once the
 * year differs from `nowMs` (a bare `Jul 29` on a year-old row reads as today).
 *
 * `nowMs` is a parameter rather than an ambient `Date.now()` so the formatting
 * stays pure and deterministic under test.
 *
 * Rule 11: `new Date(null)` yields an Invalid Date and Hermes then throws
 * `RangeError` from `toLocaleDateString` with Intl options, so both the input
 * and the parsed Date are checked before any Intl call. Returns `''` — never a
 * placeholder like "Invalid Date" — when there is no usable timestamp.
 */
export function formatShortDate(ms: number | null | undefined, nowMs: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const parsed = new Date(ms);
  if (isNaN(parsed.getTime())) return '';

  const reference = Number.isFinite(nowMs) ? new Date(nowMs) : null;
  const sameYear =
    !!reference && !isNaN(reference.getTime()) && reference.getFullYear() === parsed.getFullYear();

  try {
    return parsed.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch {
    // A locale-data gap must never take down a row that is otherwise fine.
    return '';
  }
}

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

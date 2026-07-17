import type { CreateRecording } from '../types';

type PimsPatientId = CreateRecording['pimsPatientId'];

/**
 * Track the difference between an untouched blank Patient ID and one the user
 * deliberately removed. The server may enrich the former, but must honor the
 * latter as an explicit clear.
 */
export function nextPimsPatientIdExplicitlyCleared(
  currentValue: PimsPatientId,
  nextValue: PimsPatientId,
  wasExplicitlyCleared: boolean,
): boolean {
  if (typeof nextValue === 'string' && nextValue.trim().length > 0) {
    return false;
  }
  const currentHadValue =
    typeof currentValue === 'string' && currentValue.trim().length > 0;
  return wasExplicitlyCleared || currentValue === null || currentHadValue;
}

/**
 * Older persisted drafts used null for cleared optional values without a
 * separate intent bit. Treat null as an explicit clear so upgrades fail closed.
 */
export function isPimsPatientIdExplicitlyCleared(
  value: PimsPatientId,
  persistedIntent?: boolean,
): boolean {
  return persistedIntent === true || value === null;
}

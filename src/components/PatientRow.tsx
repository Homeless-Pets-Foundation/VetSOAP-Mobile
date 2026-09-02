import React from 'react';
import { useRouter } from 'expo-router';
import { ListItem } from './ui/ListItem';
import { PATIENT_LIST_COPY } from '../constants/strings';
import { formatIsoShortDate } from '../lib/recordingDisplay';
import type { Patient } from '../types';

interface PatientRowProps {
  patient: Patient;
}

export const PatientRow = React.memo(function PatientRow({ patient }: PatientRowProps) {
  const router = useRouter();

  // Client name first: a practice with five patients called "Ace" could tell
  // them apart by nothing but species/breed before (layout tier 3, 2026-09-02).
  // The API returns one free-text client name, so it is shown whole — deriving
  // a surname from "Smith, Jane" / "Dr. J. Smith-Jones" is unreliable.
  const description = [patient.clientName, patient.species, patient.breed]
    .filter(Boolean)
    .join(' · ');

  const visitCount = patient._count?.recordings ?? 0;
  const lastVisit = formatIsoShortDate(patient.lastVisitAt, Date.now());
  const visitLabel = lastVisit
    ? PATIENT_LIST_COPY.lastVisit(lastVisit)
    : visitCount > 0
      ? PATIENT_LIST_COPY.visitCount(visitCount)
      : null;
  const meta = [visitLabel, patient.pimsPatientId ? PATIENT_LIST_COPY.pimsIdPrefix(patient.pimsPatientId) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <ListItem
      onPress={() => {
        if (patient.id) {
          router.push(`/patient/${patient.id}` as `/patient/${string}`);
        }
      }}
      accessibilityLabel={
        patient.clientName ? `Patient ${patient.name}, client ${patient.clientName}` : `Patient ${patient.name}`
      }
      title={patient.name}
      titleClassName="text-body-lg"
      subtitle={description || undefined}
      meta={meta || undefined}
      showChevron
    />
  );
}, (prev, next) =>
  prev.patient.id === next.patient.id &&
  prev.patient.name === next.patient.name &&
  prev.patient.clientName === next.patient.clientName &&
  prev.patient.species === next.patient.species &&
  prev.patient.breed === next.patient.breed &&
  prev.patient.pimsPatientId === next.patient.pimsPatientId &&
  prev.patient.lastVisitAt === next.patient.lastVisitAt &&
  prev.patient._count?.recordings === next.patient._count?.recordings
);

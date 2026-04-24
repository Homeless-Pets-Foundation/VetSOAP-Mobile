import React from 'react';
import { useRouter } from 'expo-router';
import { ListItem } from './ui/ListItem';
import type { Patient } from '../types';

interface PatientRowProps {
  patient: Patient;
}

export const PatientRow = React.memo(function PatientRow({ patient }: PatientRowProps) {
  const router = useRouter();

  const description = [
    patient.species,
    patient.breed ? `${patient.breed}` : null,
  ]
    .filter(Boolean)
    .join(' \u00B7 ');

  const visitCount = patient._count?.recordings ?? 0;

  return (
    <ListItem
      onPress={() => {
        if (patient.id) {
          router.push(`/patient/${patient.id}` as `/patient/${string}`);
        }
      }}
      accessibilityLabel={`Patient ${patient.name}`}
      title={patient.name}
      titleClassName="text-body-lg"
      subtitle={
        patient.pimsPatientId || description
          ? [
              patient.pimsPatientId ? `ID: ${patient.pimsPatientId}` : null,
              description || null,
            ]
              .filter(Boolean)
              .join(' \u00B7 ')
          : undefined
      }
      meta={visitCount > 0 ? `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}` : undefined}
      showChevron
    />
  );
}, (prev, next) =>
  prev.patient.id === next.patient.id &&
  prev.patient.name === next.patient.name &&
  prev.patient._count?.recordings === next.patient._count?.recordings
);

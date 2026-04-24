import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { SegmentedControl } from './ui/SegmentedControl';
import { TextInputField } from './ui/TextInputField';
import { Toggle } from './ui/Toggle';
import type { CreateRecording, Template } from '../types';

const SPECIES_OPTIONS = [
  { label: 'Canine', value: 'Canine' },
  { label: 'Feline', value: 'Feline' },
] as const;

const APPOINTMENT_TYPE_OPTIONS = [
  { label: 'Wellness Exam', value: 'Wellness Exam' },
  { label: 'Sick Visit', value: 'Sick Visit' },
  { label: 'Urgent/Emergency', value: 'Urgent/Emergency' },
  { label: 'Follow-up', value: 'Follow-up' },
] as const;

interface PatientFormProps {
  formData: CreateRecording;
  onUpdate: (field: keyof CreateRecording, value: string | boolean | undefined) => void;
  templates?: Template[];
  templatesLoading?: boolean;
  clientNameDisabled?: boolean;
  onPimsIdBlur?: () => void;
  pimsLookupLoading?: boolean;
}

export function PatientForm({ formData, onUpdate, templates, templatesLoading, clientNameDisabled, onPimsIdBlur, pimsLookupLoading }: PatientFormProps) {
  const handleTemplateSelect = (templateId: string | null) => {
    const template = templates?.find((item) => item.id === templateId);
    const newId = templateId ?? undefined;
    onUpdate('templateId', newId);

    // Auto-fill species if the template targets exactly one species
    if (newId && template?.species?.length === 1 && !formData.species) {
      onUpdate('species', template.species[0]);
    }
  };

  return (
    <View>
      {/* Template Picker */}
      {(templates && templates.length > 0 || templatesLoading) ? (
        templatesLoading ? (
          <View className="mb-3.5">
            <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
              Template
            </Text>
            <ActivityIndicator size="small" color="#78716c" />
          </View>
        ) : (
          <SegmentedControl
            label="Template"
            options={(templates ?? []).map((template) => ({
              label: template.name,
              value: template.id,
              description: template.description || undefined,
            }))}
            value={formData.templateId ?? null}
            onValueChange={handleTemplateSelect}
            allowDeselect
            scrollable
            optionClassName="rounded-pill"
            accessibilityLabel="Template selection"
          />
        )
      ) : null}

      <Text
        className="text-body-lg font-semibold text-stone-900 mb-4"
        accessibilityRole="header"
      >
        Patient Information
      </Text>

      <TextInputField
        label="Patient ID (optional)"
        value={formData.pimsPatientId || ''}
        onChangeText={(v) => onUpdate('pimsPatientId', v)}
        onBlur={onPimsIdBlur}
        placeholder="e.g., P-10042"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
        autoCapitalize="none"
        rightAccessory={pimsLookupLoading ? <ActivityIndicator size="small" color="#78716c" /> : undefined}
      />

      <TextInputField
        label="Patient's Name"
        required
        value={formData.patientName}
        onChangeText={(v) => onUpdate('patientName', v)}
        placeholder="e.g., Buddy"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
      />

      <TextInputField
        label="Client's Last Name"
        required
        value={formData.clientName || ''}
        onChangeText={(v) => onUpdate('clientName', v)}
        placeholder="e.g., Smith"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
        editable={!clientNameDisabled}
      />

      <SegmentedControl
        label="Species"
        required
        options={SPECIES_OPTIONS}
        value={formData.species || null}
        onValueChange={(value) => {
          if (value) onUpdate('species', value);
        }}
        columns={2}
        optionClassName="rounded-pill min-h-[48px]"
        accessibilityLabel="Species selection"
      />

      <TextInputField
        label="Breed"
        value={formData.breed || ''}
        onChangeText={(v) => onUpdate('breed', v)}
        placeholder="e.g., Golden Retriever"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
      />

      <SegmentedControl
        label="Appointment Type"
        required
        options={APPOINTMENT_TYPE_OPTIONS}
        value={formData.appointmentType || null}
        onValueChange={(value) => {
          if (value) onUpdate('appointmentType', value);
        }}
        columns={2}
        accessibilityLabel="Appointment type selection"
      />

      {/* Foreign Language Toggle */}
      <Toggle
        value={!!formData.foreignLanguage}
        onValueChange={(value) => onUpdate('foreignLanguage', value)}
        label="Foreign Language"
        description="Enable if a non-English language was spoken during this exam"
        accessibilityLabel="Foreign Language"
        accessibilityHint="Enable if a non-English language was spoken during this exam"
        className="py-3 mb-3.5"
      />
    </View>
  );
}

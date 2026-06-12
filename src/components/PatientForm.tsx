import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Star } from 'lucide-react-native';
import { SegmentedControl } from './ui/SegmentedControl';
import { TextInputField } from './ui/TextInputField';
import { Toggle } from './ui/Toggle';
import { Button } from './ui/Button';
import { RECORD_FIRST_FORM_HINT, SPECIES_OTHER_COPY, TEMPLATE_DEFAULT_COPY } from '../constants/strings';
import { useThemeColors } from '../hooks/useThemeColors';
import type { CreateRecording, Template } from '../types';

// Sentinel segment value — never sent to the server; the typed free text is
// what lands in formData.species. Server create zod accepts any ≤50-char
// string (verified on Connect), so no enum mapping is needed.
const SPECIES_OTHER_VALUE = '__other__';
const SPECIES_PRESET_VALUES = ['Canine', 'Feline'];

const SPECIES_OPTIONS = [
  { label: 'Canine', value: 'Canine' },
  { label: 'Feline', value: 'Feline' },
  { label: SPECIES_OTHER_COPY.segmentLabel, value: SPECIES_OTHER_VALUE },
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
  defaultTemplateId?: string | null;
  onSetDefaultTemplate?: (templateId: string) => void | Promise<void>;
  defaultTemplateSaving?: boolean;
  clientNameDisabled?: boolean;
  onPimsIdBlur?: () => void;
  pimsLookupLoading?: boolean;
  recordFirstEnabled?: boolean;
}

export function PatientForm({
  formData,
  onUpdate,
  templates,
  templatesLoading,
  defaultTemplateId,
  onSetDefaultTemplate,
  defaultTemplateSaving,
  clientNameDisabled,
  onPimsIdBlur,
  pimsLookupLoading,
  recordFirstEnabled = false,
}: PatientFormProps) {
  const colors = useThemeColors();
  // "Other" reveals a free-text species input. Initialized from persisted data
  // (draft/stash resume with e.g. "Avian" must land on the Other segment).
  const [speciesOtherActive, setSpeciesOtherActive] = useState(
    () => !!formData.species && !SPECIES_PRESET_VALUES.includes(formData.species)
  );

  // External writers (template auto-fill below, draft restore) can set a
  // non-preset species after mount — keep the Other segment in sync. Never
  // flips back to false here; preset taps handle that explicitly.
  useEffect(() => {
    if (formData.species && !SPECIES_PRESET_VALUES.includes(formData.species)) {
      setSpeciesOtherActive(true);
    }
  }, [formData.species]);

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
            <Text className="text-body-sm font-medium text-content-body mb-1.5">
              Template
            </Text>
            <ActivityIndicator size="small" color={colors.contentTertiary} />
          </View>
        ) : (
          <>
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
            {formData.templateId && onSetDefaultTemplate && (
              <View className="items-start -mt-1 mb-3.5">
                <Button
                  variant={formData.templateId === defaultTemplateId ? 'ghost' : 'secondary'}
                  size="sm"
                  loading={!!defaultTemplateSaving}
                  onPress={() => onSetDefaultTemplate(formData.templateId!)}
                  icon={
                    <Star
                      color={formData.templateId === defaultTemplateId ? colors.brand500 : colors.contentBody}
                      fill={formData.templateId === defaultTemplateId ? colors.brand500 : 'none'}
                      size={14}
                    />
                  }
                >
                  {formData.templateId === defaultTemplateId
                    ? TEMPLATE_DEFAULT_COPY.defaultLabel
                    : TEMPLATE_DEFAULT_COPY.makeDefault}
                </Button>
              </View>
            )}
          </>
        )
      ) : null}

      <Text
        className="text-body-lg font-semibold text-content-primary mb-4"
        accessibilityRole="header"
      >
        Patient Information
      </Text>

      {recordFirstEnabled && (
        <Text className="text-body-sm text-content-tertiary mb-4">
          {RECORD_FIRST_FORM_HINT}
        </Text>
      )}

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
        rightAccessory={pimsLookupLoading ? <ActivityIndicator size="small" color={colors.contentTertiary} /> : undefined}
      />

      <TextInputField
        label="Patient's Name"
        required={!recordFirstEnabled}
        value={formData.patientName}
        onChangeText={(v) => onUpdate('patientName', v)}
        placeholder="e.g., Buddy"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
      />

      <TextInputField
        label="Client's Last Name"
        required={!recordFirstEnabled}
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
        required={!recordFirstEnabled}
        options={SPECIES_OPTIONS}
        value={speciesOtherActive ? SPECIES_OTHER_VALUE : formData.species || null}
        onValueChange={(value) => {
          if (!value) {
            if (recordFirstEnabled) {
              setSpeciesOtherActive(false);
              onUpdate('species', undefined);
            }
            return;
          }
          if (value === SPECIES_OTHER_VALUE) {
            setSpeciesOtherActive(true);
            // A previously-selected preset must not linger as the submitted
            // species while the free-text field sits empty.
            if (formData.species && SPECIES_PRESET_VALUES.includes(formData.species)) {
              onUpdate('species', '');
            }
            return;
          }
          setSpeciesOtherActive(false);
          onUpdate('species', value);
        }}
        allowDeselect={recordFirstEnabled}
        columns={3}
        optionClassName="rounded-pill min-h-[48px]"
        accessibilityLabel="Species selection"
      />

      {speciesOtherActive && (
        <TextInputField
          label={SPECIES_OTHER_COPY.inputLabel}
          required={!recordFirstEnabled}
          // Plain pass-through: tapping "Other" already cleared any preset
          // selection, and filtering presets here would make literally-typed
          // "Canine" vanish from the input mid-keystroke.
          value={formData.species || ''}
          onChangeText={(v) => onUpdate('species', v)}
          placeholder={SPECIES_OTHER_COPY.placeholder}
          maxLength={50}
          autoCorrect={false}
          autoComplete="off"
        />
      )}

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
        required={!recordFirstEnabled}
        options={APPOINTMENT_TYPE_OPTIONS}
        value={formData.appointmentType || null}
        onValueChange={(value) => {
          if (value) {
            onUpdate('appointmentType', value);
          } else if (recordFirstEnabled) {
            onUpdate('appointmentType', undefined);
          }
        }}
        allowDeselect={recordFirstEnabled}
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

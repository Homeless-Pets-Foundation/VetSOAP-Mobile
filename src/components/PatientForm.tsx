import React from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { TextInputField } from './ui/TextInputField';
import type { CreateRecording, Template } from '../types';

const SPECIES_OPTIONS = ['Canine', 'Feline'];
const APPOINTMENT_TYPE_OPTIONS = ['Wellness Exam', 'Sick Visit', 'Urgent/Emergency', 'Follow-up'];

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
  const handleTemplateSelect = (template: Template) => {
    Haptics.selectionAsync().catch(() => {});
    const newId = formData.templateId === template.id ? undefined : template.id;
    onUpdate('templateId', newId);

    // Auto-fill species if the template targets exactly one species
    if (newId && template.species?.length === 1 && !formData.species) {
      onUpdate('species', template.species[0]);
    }
  };

  return (
    <View>
      {/* Template Picker */}
      {(templates && templates.length > 0 || templatesLoading) && (
        <View className="mb-3.5">
          <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
            Template
          </Text>
          {templatesLoading ? (
            <ActivityIndicator size="small" color="#78716c" />
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityRole="radiogroup"
              accessibilityLabel="Template selection"
            >
              <View className="flex-row gap-1.5">
                {(templates ?? []).map((template) => {
                  const isSelected = formData.templateId === template.id;
                  return (
                    <Pressable
                      key={template.id}
                      onPress={() => handleTemplateSelect(template)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={template.name}
                      accessibilityHint={template.description || undefined}
                      className={`px-3.5 min-h-[44px] justify-center rounded-pill border ${
                        isSelected
                          ? 'border-brand-500 bg-brand-500'
                          : 'border-stone-300 bg-white'
                      }`}
                    >
                      <Text
                        className={`text-body-sm font-medium ${
                          isSelected ? 'text-white' : 'text-stone-700'
                        }`}
                      >
                        {template.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>
      )}

      <Text
        className="text-body-lg font-semibold text-stone-900 mb-4"
        accessibilityRole="header"
      >
        Patient Information
      </Text>

      <TextInputField
        label="PIMS Patient ID (optional)"
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
        label="Patient Name"
        required
        value={formData.patientName}
        onChangeText={(v) => onUpdate('patientName', v)}
        placeholder="e.g., Buddy"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
      />

      <TextInputField
        label="Client Name"
        required
        value={formData.clientName || ''}
        onChangeText={(v) => onUpdate('clientName', v)}
        placeholder="e.g., John Smith"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
        editable={!clientNameDisabled}
      />

      <View className="mb-3.5">
        <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
          Species<Text className="text-danger-500"> *</Text>
        </Text>
        <View
          className="flex-row gap-2"
          accessibilityRole="radiogroup"
          accessibilityLabel="Species selection"
        >
          {SPECIES_OPTIONS.map((species) => {
            const isSelected = formData.species === species;
            return (
              <Pressable
                key={species}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  if (!isSelected) onUpdate('species', species);
                }}
                hitSlop={8}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={species}
                className={`flex-1 min-h-[48px] items-center justify-center rounded-pill border ${
                  isSelected
                    ? 'border-brand-500 bg-brand-500'
                    : 'border-stone-300 bg-white'
                }`}
              >
                <Text
                  className={`text-body font-medium ${
                    isSelected ? 'text-white' : 'text-stone-700'
                  }`}
                >
                  {species}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <TextInputField
        label="Breed"
        value={formData.breed || ''}
        onChangeText={(v) => onUpdate('breed', v)}
        placeholder="e.g., Golden Retriever"
        maxLength={100}
        autoCorrect={false}
        autoComplete="off"
      />

      <View className="mb-3.5">
        <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
          Appointment Type<Text className="text-danger-500"> *</Text>
        </Text>
        <View
          className="flex-row flex-wrap"
          style={{ marginHorizontal: -4 }}
          accessibilityRole="radiogroup"
          accessibilityLabel="Appointment type selection"
        >
          {APPOINTMENT_TYPE_OPTIONS.map((type) => {
            const isSelected = formData.appointmentType === type;
            return (
              <View key={type} style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}>
              <Pressable
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  if (!isSelected) onUpdate('appointmentType', type);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={type}
                className={`min-h-[44px] items-center justify-center rounded-btn border ${
                  isSelected
                    ? 'border-brand-500 bg-brand-500'
                    : 'border-stone-300 bg-white'
                }`}
              >
                <Text
                  className={`text-body-sm font-medium ${
                    isSelected ? 'text-white' : 'text-stone-700'
                  }`}
                >
                  {type}
                </Text>
              </Pressable>
              </View>
            );
          })}
        </View>
      </View>

      {/* Foreign Language Toggle */}
      <Pressable
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          onUpdate('foreignLanguage', !formData.foreignLanguage);
        }}
        accessibilityRole="switch"
        accessibilityState={{ checked: !!formData.foreignLanguage }}
        accessibilityLabel="Foreign Language"
        accessibilityHint="Enable if a non-English language was spoken during this exam"
        className="flex-row items-center justify-between py-3 mb-3.5"
      >
        <View className="flex-1 mr-3">
          <Text className="text-body-sm font-medium text-stone-700">
            Foreign Language
          </Text>
          <Text className="text-body-xs text-stone-500 mt-0.5">
            Enable if a non-English language was spoken during this exam
          </Text>
        </View>
        <View
          className={`w-[44px] h-[24px] rounded-full justify-center px-[2px] ${
            formData.foreignLanguage ? 'bg-brand-500' : 'bg-stone-300'
          }`}
        >
          <View
            className={`w-[20px] h-[20px] rounded-full bg-white ${
              formData.foreignLanguage ? 'self-end' : 'self-start'
            }`}
          />
        </View>
      </Pressable>
    </View>
  );
}

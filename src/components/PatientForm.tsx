import React from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { TextInputField } from './ui/TextInputField';
import type { CreateRecording, Template } from '../types';

const SPECIES_OPTIONS = ['Canine', 'Feline', 'Equine', 'Bovine', 'Avian', 'Exotic', 'Other'];

interface PatientFormProps {
  formData: CreateRecording;
  onUpdate: (field: keyof CreateRecording, value: string) => void;
  templates?: Template[];
  templatesLoading?: boolean;
}

export function PatientForm({ formData, onUpdate, templates, templatesLoading }: PatientFormProps) {
  const handleTemplateSelect = (template: Template) => {
    Haptics.selectionAsync();
    const newId = formData.templateId === template.id ? '' : template.id;
    onUpdate('templateId', newId);

    // Auto-fill species if the template targets exactly one species
    if (newId && template.species.length === 1 && !formData.species) {
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
                {templates!.map((template) => {
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
        label="Patient Name"
        required
        value={formData.patientName}
        onChangeText={(v) => onUpdate('patientName', v)}
        placeholder="e.g., Buddy"
      />

      <TextInputField
        label="Client Name"
        required
        value={formData.clientName || ''}
        onChangeText={(v) => onUpdate('clientName', v)}
        placeholder="e.g., John Smith"
      />

      <View className="mb-3.5">
        <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
          Species<Text className="text-danger-500"> *</Text>
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityRole="radiogroup"
          accessibilityLabel="Species selection"
        >
          <View className="flex-row gap-1.5">
            {SPECIES_OPTIONS.map((species) => {
              const isSelected = formData.species === species;
              return (
                <Pressable
                  key={species}
                  onPress={() => {
                    Haptics.selectionAsync();
                    onUpdate('species', isSelected ? '' : species);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={species}
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
                    {species}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      <TextInputField
        label="Breed"
        value={formData.breed || ''}
        onChangeText={(v) => onUpdate('breed', v)}
        placeholder="e.g., Golden Retriever"
      />

      <TextInputField
        label="Appointment Type"
        value={formData.appointmentType || ''}
        onChangeText={(v) => onUpdate('appointmentType', v)}
        placeholder="e.g., Wellness Exam, Sick Visit"
      />
    </View>
  );
}

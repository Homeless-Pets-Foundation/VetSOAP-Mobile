import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import type { CreateRecording } from '../types';

const SPECIES_OPTIONS = ['Canine', 'Feline', 'Equine', 'Bovine', 'Avian', 'Exotic', 'Other'];

interface PatientFormProps {
  formData: CreateRecording;
  onUpdate: (field: keyof CreateRecording, value: string) => void;
}

export function PatientForm({ formData, onUpdate }: PatientFormProps) {
  return (
    <View>
      <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917', marginBottom: 16 }}>
        Patient Information
      </Text>

      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
          Patient Name *
        </Text>
        <TextInput
          value={formData.patientName}
          onChangeText={(v) => onUpdate('patientName', v)}
          placeholder="e.g., Buddy"
          placeholderTextColor="#a8a29e"
          style={{
            borderWidth: 1,
            borderColor: '#d6d3d1',
            borderRadius: 8,
            padding: 12,
            fontSize: 15,
            color: '#1c1917',
            backgroundColor: '#fff',
          }}
        />
      </View>

      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
          Client Name
        </Text>
        <TextInput
          value={formData.clientName || ''}
          onChangeText={(v) => onUpdate('clientName', v)}
          placeholder="e.g., John Smith"
          placeholderTextColor="#a8a29e"
          style={{
            borderWidth: 1,
            borderColor: '#d6d3d1',
            borderRadius: 8,
            padding: 12,
            fontSize: 15,
            color: '#1c1917',
            backgroundColor: '#fff',
          }}
        />
      </View>

      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
          Species
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {SPECIES_OPTIONS.map((species) => (
              <Pressable
                key={species}
                onPress={() => onUpdate('species', formData.species === species ? '' : species)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: formData.species === species ? '#0d8775' : '#d6d3d1',
                  backgroundColor: formData.species === species ? '#0d8775' : '#fff',
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: '500',
                    color: formData.species === species ? '#fff' : '#44403c',
                  }}
                >
                  {species}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>

      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
          Breed
        </Text>
        <TextInput
          value={formData.breed || ''}
          onChangeText={(v) => onUpdate('breed', v)}
          placeholder="e.g., Golden Retriever"
          placeholderTextColor="#a8a29e"
          style={{
            borderWidth: 1,
            borderColor: '#d6d3d1',
            borderRadius: 8,
            padding: 12,
            fontSize: 15,
            color: '#1c1917',
            backgroundColor: '#fff',
          }}
        />
      </View>

      <View style={{ marginBottom: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: '#44403c', marginBottom: 6 }}>
          Appointment Type
        </Text>
        <TextInput
          value={formData.appointmentType || ''}
          onChangeText={(v) => onUpdate('appointmentType', v)}
          placeholder="e.g., Wellness Exam, Sick Visit"
          placeholderTextColor="#a8a29e"
          style={{
            borderWidth: 1,
            borderColor: '#d6d3d1',
            borderRadius: 8,
            padding: 12,
            fontSize: 15,
            color: '#1c1917',
            backgroundColor: '#fff',
          }}
        />
      </View>
    </View>
  );
}

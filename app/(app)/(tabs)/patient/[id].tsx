import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Edit2, User } from 'lucide-react-native';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { patientsApi } from '../../../../src/api/patients';
import { Button } from '../../../../src/components/ui/Button';
import { Card } from '../../../../src/components/ui/Card';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import type { UpdatePatient } from '../../../../src/types';

type Tab = 'summary' | 'visits' | 'profile';

interface ProfileDraft {
  name?: string;
  species?: string | null;
  breed?: string | null;
  dateOfBirth?: string | null;
  knownAllergies?: string | null;
  ongoingMedications?: string | null;
  clinicalNotes?: string | null;
}

function ProfileField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View className="mb-3">
      <Text className="text-caption text-stone-500 uppercase tracking-wide">{label}</Text>
      <Text className="text-body text-stone-900 mt-0.5">{value}</Text>
    </View>
  );
}

function EditableField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View className="mb-3.5">
      <Text className="text-body-sm font-medium text-stone-700 mb-1.5">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#78716c"
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        className={`input-base min-h-[44px] text-body text-stone-900 ${multiline ? 'py-2' : ''}`}
        style={multiline ? { height: 80, textAlignVertical: 'top' } : undefined}
      />
    </View>
  );
}

export default function PatientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { iconSm } = useResponsive();

  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [editMode, setEditMode] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({});

  const {
    data: patient,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['patient', id],
    queryFn: () => patientsApi.get(id!),
    enabled: !!id,
  });

  const {
    data: recordingsData,
    isLoading: recordingsLoading,
  } = useQuery({
    queryKey: ['patient', id, 'recordings'],
    queryFn: () => patientsApi.listRecordings(id!, { limit: 20 }),
    enabled: !!id && activeTab === 'visits',
  });

  const updateMutation = useMutation({
    mutationFn: (draft: ProfileDraft) => {
      const payload: UpdatePatient = { ...draft };
      return patientsApi.update(id!, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient', id] }).catch(() => {});
      setEditMode(false);
    },
  });

  const regenerateSummaryMutation = useMutation({
    mutationFn: () => patientsApi.regenerateSummary(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patient', id] }).catch(() => {});
    },
  });

  const startEdit = useCallback(() => {
    if (!patient) return;
    setProfileDraft({
      name: patient.name,
      species: patient.species,
      breed: patient.breed,
      dateOfBirth: patient.dateOfBirth
        ? patient.dateOfBirth.split('T')[0]
        : null,
      knownAllergies: patient.knownAllergies,
      ongoingMedications: patient.ongoingMedications,
      clinicalNotes: patient.clinicalNotes,
    });
    setEditMode(true);
  }, [patient]);

  const TABS: { key: Tab; label: string }[] = [
    { key: 'summary', label: 'Summary' },
    { key: 'visits', label: 'Visits' },
    { key: 'profile', label: 'Profile' },
  ];

  return (
    <SafeAreaView className="flex-1 bg-stone-50" edges={['top']}>
      {/* Header */}
      <View
        className="flex-row items-center px-5 py-3 bg-white border-b border-stone-200"
        style={{ maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' }}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="mr-3"
        >
          <ChevronLeft color="#0d8775" size={iconSm} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-body-lg font-semibold text-stone-900" numberOfLines={1}>
            {isLoading ? 'Loading...' : (patient?.name ?? 'Patient')}
          </Text>
          {patient?.pimsPatientId && (
            <Text className="text-caption text-stone-500">{patient.pimsPatientId}</Text>
          )}
        </View>
      </View>

      {/* Tab Bar */}
      <View
        className="flex-row bg-white border-b border-stone-200"
        style={{ maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' }}
      >
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              className="flex-1 py-3 items-center"
              style={isActive ? { borderBottomWidth: 2, borderBottomColor: '#0d8775' } : undefined}
            >
              <Text
                className={`text-body-sm font-medium ${
                  isActive ? 'text-brand-600' : 'text-stone-500'
                }`}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#0d8775" size="large" />
        </View>
      ) : error || !patient ? (
        <View className="flex-1 items-center justify-center px-8">
          <User color="#a8a29e" size={48} />
          <Text className="text-body font-medium text-stone-900 mt-4">Patient not found</Text>
          <Button variant="secondary" onPress={() => router.back()} className="mt-4">
            Go Back
          </Button>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }} tintColor="#0d8775" />
          }
        >
          {/* SUMMARY TAB */}
          {activeTab === 'summary' && (
            <View>
              {/* AI History Summary */}
              <Card className="mb-4">
                <View className="flex-row items-center justify-between mb-3">
                  <View className="flex-row items-center">
                    <View className="w-2 h-2 rounded-full bg-amber-400 mr-2" />
                    <Text className="text-body-sm font-semibold text-stone-700">AI Patient Summary</Text>
                  </View>
                  {patient.aiHistoryUpdatedAt && Date.now() - new Date(patient.aiHistoryUpdatedAt).getTime() > 30 * 24 * 60 * 60 * 1000 && (
                    <View className="bg-amber-100 rounded px-2 py-0.5">
                      <Text className="text-caption font-medium text-amber-700">Outdated</Text>
                    </View>
                  )}
                </View>
                {patient.aiHistorySummary ? (
                  <>
                    <Text className="text-body text-stone-800 leading-relaxed">
                      {patient.aiHistorySummary}
                    </Text>
                    <View className="flex-row items-center justify-between mt-2">
                      {patient.aiHistoryUpdatedAt && (
                        <Text className="text-caption text-stone-400">
                          {(() => {
                            const d = new Date(patient.aiHistoryUpdatedAt);
                            if (isNaN(d.getTime())) return '';
                            return `Updated ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
                          })()}
                        </Text>
                      )}
                      <Pressable
                        onPress={() => regenerateSummaryMutation.mutate()}
                        disabled={regenerateSummaryMutation.isPending}
                        hitSlop={8}
                      >
                        <Text className="text-caption font-medium text-brand-600">
                          {regenerateSummaryMutation.isPending ? 'Queuing…' : 'Regenerate'}
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <>
                    <Text className="text-body text-stone-500 italic mb-2">
                      No summary yet. Summaries are generated automatically after completed visits.
                    </Text>
                    <Pressable
                      onPress={() => regenerateSummaryMutation.mutate()}
                      disabled={regenerateSummaryMutation.isPending}
                      hitSlop={8}
                    >
                      <Text className="text-caption font-medium text-brand-600">
                        {regenerateSummaryMutation.isPending ? 'Queuing…' : 'Trigger manually'}
                      </Text>
                    </Pressable>
                  </>
                )}
              </Card>

              {/* Known Allergies */}
              {patient.knownAllergies && (
                <Card className="mb-4">
                  <Text className="text-body-sm font-semibold text-stone-700 mb-2">Known Allergies</Text>
                  <Text className="text-body text-stone-800">{patient.knownAllergies}</Text>
                </Card>
              )}

              {/* Ongoing Medications */}
              {patient.ongoingMedications && (
                <Card className="mb-4">
                  <Text className="text-body-sm font-semibold text-stone-700 mb-2">Ongoing Medications</Text>
                  <Text className="text-body text-stone-800">{patient.ongoingMedications}</Text>
                </Card>
              )}
            </View>
          )}

          {/* VISITS TAB */}
          {activeTab === 'visits' && (
            <View>
              {recordingsLoading ? (
                <ActivityIndicator color="#0d8775" className="my-8" />
              ) : !recordingsData?.data.length ? (
                <View className="items-center py-12">
                  <Text className="text-body text-stone-500 text-center">No visit records found</Text>
                </View>
              ) : (
                recordingsData.data.map((recording) => {
                  const date = new Date(recording.createdAt);
                  const dateStr = isNaN(date.getTime())
                    ? ''
                    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                  return (
                    <Pressable
                      key={recording.id}
                      onPress={() =>
                        router.push(`/recordings/${recording.id}` as `/recordings/${string}`)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Visit on ${dateStr}`}
                    >
                      <Card className="mb-3">
                        <View className="flex-row justify-between items-start">
                          <View className="flex-1 mr-3">
                            <Text className="text-body-sm font-semibold text-stone-900">{dateStr}</Text>
                            {recording.appointmentType && (
                              <Text className="text-body-sm text-stone-600 mt-0.5">
                                {recording.appointmentType}
                              </Text>
                            )}
                          </View>
                          <View className="px-2 py-0.5 rounded-full bg-stone-100">
                            <Text className="text-caption text-stone-600 capitalize">
                              {recording.status}
                            </Text>
                          </View>
                        </View>
                      </Card>
                    </Pressable>
                  );
                })
              )}
            </View>
          )}

          {/* PROFILE TAB */}
          {activeTab === 'profile' && (
            <View>
              {!editMode ? (
                <Card className="mb-4">
                  <View className="flex-row justify-between items-center mb-4">
                    <Text className="text-body-sm font-semibold text-stone-700">Patient Details</Text>
                    <Pressable
                      onPress={startEdit}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Edit patient profile"
                      className="flex-row items-center"
                    >
                      <Edit2 color="#0d8775" size={14} />
                      <Text className="text-body-sm text-brand-600 ml-1" style={{ paddingRight: 4 }}>Edit</Text>
                    </Pressable>
                  </View>
                  <ProfileField label="Name" value={patient.name} />
                  <ProfileField label="PIMS ID" value={patient.pimsPatientId} />
                  <ProfileField label="Species" value={patient.species} />
                  <ProfileField label="Breed" value={patient.breed} />
                  <ProfileField
                    label="Date of Birth"
                    value={
                      patient.dateOfBirth
                        ? (() => {
                            const d = new Date(patient.dateOfBirth);
                            return isNaN(d.getTime()) ? null : d.toLocaleDateString();
                          })()
                        : null
                    }
                  />
                  <ProfileField label="Known Allergies" value={patient.knownAllergies} />
                  <ProfileField label="Ongoing Medications" value={patient.ongoingMedications} />
                  <ProfileField label="Clinical Notes" value={patient.clinicalNotes} />
                </Card>
              ) : (
                <Card className="mb-4">
                  <View className="flex-row justify-between items-center mb-4">
                    <Text className="text-body-sm font-semibold text-stone-700">Edit Profile</Text>
                    <Pressable
                      onPress={() => setEditMode(false)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel editing"
                    >
                      <Text className="text-body-sm text-stone-500">Cancel</Text>
                    </Pressable>
                  </View>

                  <EditableField
                    label="Name"
                    value={profileDraft.name ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, name: v }))}
                    placeholder="Patient name"
                  />
                  <EditableField
                    label="Breed"
                    value={profileDraft.breed ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, breed: v || null }))}
                    placeholder="e.g., Golden Retriever"
                  />
                  <EditableField
                    label="Date of Birth (YYYY-MM-DD)"
                    value={profileDraft.dateOfBirth ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, dateOfBirth: v || null }))}
                    placeholder="e.g., 2020-03-15"
                  />
                  <EditableField
                    label="Known Allergies"
                    value={profileDraft.knownAllergies ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, knownAllergies: v || null }))}
                    placeholder="List any known allergies..."
                    multiline
                  />
                  <EditableField
                    label="Ongoing Medications"
                    value={profileDraft.ongoingMedications ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, ongoingMedications: v || null }))}
                    placeholder="List current medications..."
                    multiline
                  />
                  <EditableField
                    label="Clinical Notes"
                    value={profileDraft.clinicalNotes ?? ''}
                    onChangeText={(v) => setProfileDraft((p) => ({ ...p, clinicalNotes: v || null }))}
                    placeholder="Additional clinical notes..."
                    multiline
                  />

                  {updateMutation.error && (
                    <Text className="text-body-sm text-danger-600 mb-3">
                      {updateMutation.error instanceof Error
                        ? updateMutation.error.message
                        : 'Failed to save changes.'}
                    </Text>
                  )}

                  <Button
                    onPress={() => updateMutation.mutate(profileDraft)}
                    loading={updateMutation.isPending}
                    disabled={updateMutation.isPending}
                  >
                    Save Changes
                  </Button>
                </Card>
              )}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

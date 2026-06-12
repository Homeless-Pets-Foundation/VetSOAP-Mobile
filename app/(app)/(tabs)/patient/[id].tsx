import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Alert,
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
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
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

const SUMMARY_COLLAPSE_LINES = 3;
// Below this length the text fits the collapsed window anyway — no toggle.
const SUMMARY_READ_MORE_MIN_CHARS = 160;

function AiSummaryText({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false);
  const showToggle = summary.length > SUMMARY_READ_MORE_MIN_CHARS;
  return (
    <View>
      <Text
        className="text-body text-content-body leading-relaxed"
        numberOfLines={expanded || !showToggle ? undefined : SUMMARY_COLLAPSE_LINES}
      >
        {summary}
      </Text>
      {showToggle && (
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show less of the summary' : 'Read the full summary'}
          className="mt-1 self-start"
          style={{ minHeight: 32, justifyContent: 'center' }}
        >
          {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
          <Text
            className="text-body-sm font-medium text-brand-600"
            allowFontScaling={false}
            style={{ flexShrink: 0, paddingRight: 2 }}
          >
            {`${expanded ? 'Show less' : 'Read more'} `}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function ProfileField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View className="mb-3">
      <Text className="text-caption text-content-tertiary uppercase tracking-wide">{label}</Text>
      <Text className="text-body text-content-primary mt-0.5">{value}</Text>
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
  const colors = useThemeColors();
  return (
    <View className="mb-3.5">
      <Text className="text-body-sm font-medium text-content-body mb-1.5">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.contentTertiary}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        className={`input-base min-h-[44px] text-body text-content-primary ${multiline ? 'py-2' : ''}`}
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
  const colors = useThemeColors();

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
    onError: (mutationError) => {
      const message = mutationError instanceof Error
        ? mutationError.message
        : 'Could not queue patient summary generation. Please try again.';
      Alert.alert('Unable to Regenerate Summary', message);
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
    <SafeAreaView className="flex-1 bg-surface" edges={['top']}>
      {/* Header */}
      <View
        className="flex-row items-center px-5 py-3 bg-surface-raised border-b border-border-default"
        style={{ maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' }}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="mr-3"
        >
          <ChevronLeft color={colors.brand500} size={iconSm} />
        </Pressable>
        <View className="flex-1">
          <Text className="text-body-lg font-semibold text-content-primary" numberOfLines={1}>
            {isLoading ? 'Loading...' : (patient?.name ?? 'Patient')}
          </Text>
          {patient?.pimsPatientId && (
            <Text className="text-caption text-content-tertiary">{patient.pimsPatientId}</Text>
          )}
        </View>
      </View>

      {/* Tab Bar */}
      <View
        className="flex-row bg-surface-raised border-b border-border-default"
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
              style={isActive ? { borderBottomWidth: 2, borderBottomColor: colors.brand500 } : undefined}
            >
              <Text
                className={`text-body-sm font-medium ${
                  isActive ? 'text-brand-600' : 'text-content-tertiary'
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
          <ActivityIndicator color={colors.brand500} size="large" />
        </View>
      ) : error || !patient ? (
        <View className="flex-1 items-center justify-center px-8">
          <User color={colors.contentTertiary} size={48} />
          <Text className="text-body font-medium text-content-primary mt-4">Patient not found</Text>
          <Button variant="secondary" onPress={() => router.back()} className="mt-4">
            Go Back
          </Button>
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, maxWidth: CONTENT_MAX_WIDTH, width: '100%', alignSelf: 'center' }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }} tintColor={colors.brand500} />
          }
        >
          {/* SUMMARY TAB */}
          {activeTab === 'summary' && (
            <View>
              {/* AI History Summary */}
              <Card className="mb-4">
                <View className="flex-row items-center justify-between mb-3">
                  <View className="flex-row items-center">
                    <View className="w-2 h-2 rounded-full bg-warning-500 mr-2" />
                    <Text className="text-body-sm font-semibold text-content-body">AI Patient Summary</Text>
                  </View>
                  {patient.aiHistoryUpdatedAt && (() => { const d = new Date(patient.aiHistoryUpdatedAt); return !isNaN(d.getTime()) && Date.now() - d.getTime() > 30 * 24 * 60 * 60 * 1000; })() && (
                    <View className="bg-status-warning rounded px-2 py-0.5">
                      <Text className="text-caption font-medium text-status-warning">Outdated</Text>
                    </View>
                  )}
                </View>
                {patient.aiHistorySummary ? (
                  <>
                    <AiSummaryText summary={patient.aiHistorySummary} />
                    <View className="flex-row items-center justify-between mt-2">
                      {patient.aiHistoryUpdatedAt && (
                        /* flex-1 + trailing space so the date claims row space
                           and never clips its last glyph next to Regenerate. */
                        <Text
                          className="text-caption text-content-tertiary flex-1 mr-2"
                          numberOfLines={1}
                          style={{ paddingRight: 2 }}
                        >
                          {(() => {
                            const d = new Date(patient.aiHistoryUpdatedAt);
                            if (isNaN(d.getTime())) return '';
                            return `Updated ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} `;
                          })()}
                        </Text>
                      )}
                      <Pressable
                        onPress={() => regenerateSummaryMutation.mutate()}
                        disabled={regenerateSummaryMutation.isPending}
                        hitSlop={8}
                      >
                        {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                        <Text
                          className="text-caption font-medium text-brand-600"
                          allowFontScaling={false}
                          style={{ flexShrink: 0, paddingRight: 2 }}
                        >
                          {`${regenerateSummaryMutation.isPending ? 'Queuing…' : 'Regenerate'} `}
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <>
                    <Text className="text-body text-content-tertiary italic mb-2">
                      No summary yet. Summaries are generated automatically after completed visits.
                    </Text>
                    <Pressable
                      onPress={() => regenerateSummaryMutation.mutate()}
                      disabled={regenerateSummaryMutation.isPending}
                      hitSlop={8}
                    >
                      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                      <Text
                        className="text-caption font-medium text-brand-600"
                        allowFontScaling={false}
                        style={{ flexShrink: 0, paddingRight: 2 }}
                      >
                        {`${regenerateSummaryMutation.isPending ? 'Queuing…' : 'Trigger manually'} `}
                      </Text>
                    </Pressable>
                  </>
                )}
              </Card>

              {/* Known Allergies */}
              {patient.knownAllergies && (
                <Card className="mb-4">
                  <Text className="text-body-sm font-semibold text-content-body mb-2">Known Allergies</Text>
                  <Text className="text-body text-content-body">{patient.knownAllergies}</Text>
                </Card>
              )}

              {/* Ongoing Medications */}
              {patient.ongoingMedications && (
                <Card className="mb-4">
                  <Text className="text-body-sm font-semibold text-content-body mb-2">Ongoing Medications</Text>
                  <Text className="text-body text-content-body">{patient.ongoingMedications}</Text>
                </Card>
              )}
            </View>
          )}

          {/* VISITS TAB */}
          {activeTab === 'visits' && (
            <View>
              {recordingsLoading ? (
                <ActivityIndicator color={colors.brand500} className="my-8" />
              ) : !recordingsData?.data.length ? (
                <View className="items-center py-12">
                  <Text className="text-body text-content-tertiary text-center">No visit records found</Text>
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
                            <Text className="text-body-sm font-semibold text-content-primary">{dateStr}</Text>
                            {recording.appointmentType && (
                              <Text className="text-body-sm text-content-secondary mt-0.5">
                                {recording.appointmentType}
                              </Text>
                            )}
                          </View>
                          <View className="px-2 py-0.5 rounded-full bg-surface-sunken">
                            <Text className="text-caption text-content-secondary capitalize">
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
                    <Text className="text-body-sm font-semibold text-content-body">Patient Details</Text>
                    <Pressable
                      onPress={startEdit}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Edit patient profile"
                      className="flex-row items-center"
                    >
                      <Edit2 color={colors.brand500} size={14} style={{ flexShrink: 0 }} />
                      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                      <Text
                        className="text-body-sm text-brand-600 ml-1"
                        allowFontScaling={false}
                        style={{ flexShrink: 0, paddingRight: 2 }}
                      >
                        {'Edit '}
                      </Text>
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
                    <Text className="text-body-sm font-semibold text-content-body">Edit Profile</Text>
                    <Pressable
                      onPress={() => setEditMode(false)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel editing"
                    >
                      {/* Trailing space + flexShrink:0 — Android under-measures single-word Text and clips the last glyph; do NOT remove. */}
                      <Text
                        className="text-body-sm text-content-tertiary"
                        allowFontScaling={false}
                        style={{ flexShrink: 0, paddingRight: 2 }}
                      >
                        {'Cancel '}
                      </Text>
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
                    <Text className="text-body-sm text-status-danger mb-3">
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

import React from 'react';
import { View, Text, Alert } from 'react-native';
import { Check, Edit2, Sparkles } from 'lucide-react-native';
import type { Recording, RecordingMetadataField, UpdateRecordingMetadata } from '../types';
import { METADATA_REVIEW_COPY } from '../constants/strings';
import { useThemeColors } from '../hooks/useThemeColors';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { TextInputField } from './ui/TextInputField';
import { SegmentedControl } from './ui/SegmentedControl';

const FIELD_LABELS: Record<RecordingMetadataField, string> = {
  patientName: 'Patient',
  clientName: 'Client',
  species: 'Species',
  breed: 'Breed',
  appointmentType: 'Visit Type',
};

const APPOINTMENT_TYPE_OPTIONS = [
  { label: 'Wellness Exam', value: 'Wellness Exam' },
  { label: 'Sick Visit', value: 'Sick Visit' },
  { label: 'Urgent/Emergency', value: 'Urgent/Emergency' },
  { label: 'Follow-up', value: 'Follow-up' },
] as const;

type MetadataForm = Record<RecordingMetadataField, string>;

interface MetadataReviewCardProps {
  recording: Recording;
  mode: 'review' | 'add';
  saving?: boolean;
  onConfirm: () => void;
  onSave: (payload: UpdateRecordingMetadata, correctedFieldCount: number) => void;
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPayload(form: MetadataForm, pimsPatientId: string): UpdateRecordingMetadata {
  return {
    fields: {
      patientName: form.patientName.trim(),
      clientName: trimOrNull(form.clientName),
      species: trimOrNull(form.species),
      breed: trimOrNull(form.breed),
      appointmentType: trimOrNull(form.appointmentType),
      // PIMS Patient ID is vet-entered (never AI-filled) and is deliberately kept
      // out of `correctedCount` so AI-review analytics stay AI-only.
      pimsPatientId: trimOrNull(pimsPatientId),
    },
    review: 'confirmed',
  };
}

function correctedCount(before: MetadataForm, after: MetadataForm): number {
  return (Object.keys(before) as RecordingMetadataField[]).filter(
    (field) => before[field].trim() !== after[field].trim()
  ).length;
}

export function MetadataReviewCard({
  recording,
  mode,
  saving = false,
  onConfirm,
  onSave,
}: MetadataReviewCardProps) {
  const colors = useThemeColors();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const formSeed = React.useMemo(
    () => ({
      patientName: recording.patientName ?? '',
      clientName: recording.clientName ?? '',
      species: recording.species ?? '',
      breed: recording.breed ?? '',
      appointmentType: recording.appointmentType ?? '',
    }),
    [
      recording.patientName,
      recording.clientName,
      recording.species,
      recording.breed,
      recording.appointmentType,
    ]
  );
  const [form, setForm] = React.useState<MetadataForm>(formSeed);

  React.useEffect(() => {
    setForm(formSeed);
  }, [formSeed]);

  // PIMS Patient ID is tracked separately from `form` so it never enters
  // `correctedCount` (AI-only). Re-seed after the save round-trip refetches.
  const pimsSeed = recording.pimsPatientId ?? '';
  const [pimsPatientId, setPimsPatientId] = React.useState(pimsSeed);

  React.useEffect(() => {
    setPimsPatientId(pimsSeed);
  }, [pimsSeed]);

  const before = formSeed;
  const appliedFields = Array.isArray(recording.aiExtractedMetadata?.appliedFields)
    ? recording.aiExtractedMetadata.appliedFields
    : [];
  const fieldsFromMetadata = recording.aiExtractedMetadata?.fields
    ? (Object.keys(recording.aiExtractedMetadata.fields) as RecordingMetadataField[])
    : [];
  const rowFields = (appliedFields.length > 0 ? appliedFields : fieldsFromMetadata).filter(
    (field, index, arr) => arr.indexOf(field) === index && FIELD_LABELS[field]
  );
  const hasAnyFormValue = Object.values(form).some((value) => value.trim().length > 0);

  const updateField = (field: RecordingMetadataField, value: string | null) => {
    setForm((current) => ({ ...current, [field]: value ?? '' }));
  };

  const handleSave = () => {
    try {
      onSave(buildPayload(form, pimsPatientId), correctedCount(before, form));
      setSheetOpen(false);
    } catch {
      Alert.alert('Save Failed', METADATA_REVIEW_COPY.failed);
    }
  };

  const title = mode === 'review' ? METADATA_REVIEW_COPY.title : METADATA_REVIEW_COPY.addTitle;
  const body = mode === 'review' ? METADATA_REVIEW_COPY.body : METADATA_REVIEW_COPY.addBody;

  return (
    <>
      <Card className="mx-5 mb-4 border-brand-100 dark:border-border-default">
        <View className="flex-row items-start">
          <View className="mr-2 mt-0.5">
            <Sparkles color={colors.brand500} size={18} />
          </View>
          <View className="flex-1">
            <Text className="text-body font-semibold text-content-primary mb-1">
              {title}
            </Text>
            <Text className="text-body-sm text-content-tertiary mb-3">
              {body}
            </Text>

            {mode === 'review' && rowFields.length > 0 ? (
              <View className="mb-3">
                {rowFields.map((field) => {
                  const value = before[field].trim();
                  if (!value) return null;
                  return (
                    <View key={field} className="flex-row items-center mb-1.5">
                      <Sparkles color={colors.brand500} size={12} style={{ marginRight: 6 }} />
                      <Text className="text-body-sm text-content-secondary flex-1" numberOfLines={2}>
                        <Text className="font-semibold">{FIELD_LABELS[field]}: </Text>
                        {value}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            <View className="flex-row flex-wrap gap-2">
              {mode === 'review' ? (
                <Button
                  variant="primary"
                  size="sm"
                  onPress={onConfirm}
                  loading={saving}
                  icon={<Check color={colors.contentOnBrand} size={14} />}
                >
                  {METADATA_REVIEW_COPY.looksRight}
                </Button>
              ) : null}
              <Button
                variant={mode === 'review' ? 'secondary' : 'primary'}
                size="sm"
                onPress={() => setSheetOpen(true)}
                disabled={saving}
                icon={<Edit2 color={mode === 'review' ? colors.contentBody : colors.contentOnBrand} size={14} />}
              >
                {mode === 'review'
                  ? METADATA_REVIEW_COPY.editDetails
                  : METADATA_REVIEW_COPY.addDetails}
              </Button>
            </View>
          </View>
        </View>
      </Card>

      <Sheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={METADATA_REVIEW_COPY.sheetTitle}
        closeLabel={METADATA_REVIEW_COPY.cancel}
        footer={
          <View className="flex-row gap-2 pb-2">
            <View className="flex-1">
              <Button variant="secondary" onPress={() => setSheetOpen(false)} disabled={saving}>
                {METADATA_REVIEW_COPY.cancel}
              </Button>
            </View>
            <View className="flex-1">
              <Button
                variant="primary"
                onPress={handleSave}
                loading={saving}
                disabled={!hasAnyFormValue}
              >
                {METADATA_REVIEW_COPY.save}
              </Button>
            </View>
          </View>
        }
      >
        {/* PIMS Patient ID — vet-entered, never AI-filled; shown in both modes.
            Label/placeholder mirror PatientForm.tsx for consistency. */}
        <TextInputField
          label="Patient ID (optional)"
          value={pimsPatientId}
          onChangeText={setPimsPatientId}
          placeholder="e.g., P-10042"
          maxLength={100}
          autoCorrect={false}
          autoComplete="off"
          autoCapitalize="none"
        />
        <TextInputField
          label="Patient's Name"
          value={form.patientName}
          onChangeText={(value) => updateField('patientName', value)}
          maxLength={100}
          autoCorrect={false}
          autoComplete="off"
        />
        <TextInputField
          label="Client's Last Name"
          value={form.clientName}
          onChangeText={(value) => updateField('clientName', value)}
          maxLength={100}
          autoCorrect={false}
          autoComplete="off"
        />
        <TextInputField
          label="Species"
          value={form.species}
          onChangeText={(value) => updateField('species', value)}
          maxLength={50}
          autoCorrect={false}
          autoComplete="off"
        />
        <TextInputField
          label="Breed"
          value={form.breed}
          onChangeText={(value) => updateField('breed', value)}
          maxLength={100}
          autoCorrect={false}
          autoComplete="off"
        />
        <SegmentedControl
          label="Appointment Type"
          options={APPOINTMENT_TYPE_OPTIONS}
          value={form.appointmentType || null}
          onValueChange={(value) => updateField('appointmentType', value)}
          allowDeselect
          columns={2}
          accessibilityLabel="Appointment type selection"
        />
      </Sheet>
    </>
  );
}

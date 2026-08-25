import React from 'react';
import { View, Alert, Pressable } from 'react-native';
import { Text } from './ui/Text';
import { AlertCircle, Check, Edit2, Plus, Sparkles } from 'lucide-react-native';
import type { Recording, RecordingMetadataField, UpdateRecordingMetadata } from '../types';
import { METADATA_FIELD_LABELS, METADATA_REVIEW_COPY } from '../constants/strings';
import {
  computeMetadataAttentionSignals,
  computeSuggestionFields,
  shouldShowNoExtractionEmptyState,
} from '../lib/recordFirstObservability';
import { metadataAttentionReasons } from '../lib/attentionFeed';
import { buildMetadataFormSeed } from '../lib/recordingMetadataSync';
import { useThemeColors } from '../hooks/useThemeColors';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { TextInputField } from './ui/TextInputField';
import { SegmentedControl } from './ui/SegmentedControl';

const FIELD_LABELS: Record<RecordingMetadataField, string> = METADATA_FIELD_LABELS;

const APPOINTMENT_TYPE_OPTIONS = [
  { label: 'Wellness Exam', value: 'Wellness Exam' },
  { label: 'Sick Visit', value: 'Sick Visit' },
  { label: 'Urgent/Emergency', value: 'Urgent/Emergency' },
  { label: 'Follow-up', value: 'Follow-up' },
] as const;

type MetadataForm = Record<RecordingMetadataField, string>;

interface MetadataReviewCardProps {
  recording: Recording;
  mode: 'review' | 'add' | 'edit';
  /** Gates only the ambiguous null-extraction inference, never a real blob. */
  recordFirstEnabled?: boolean;
  saving?: boolean;
  /** Whole-review confirm with no field changes. */
  onConfirm?: () => void;
  /** Deliberate `review: 'dismissed'` — "Keep current details". */
  onDismiss?: () => void;
  onSave: (
    payload: UpdateRecordingMetadata,
    correctedFieldCount: number,
    changedFields: RecordingMetadataField[]
  ) => void;
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPayload(
  form: MetadataForm,
  pimsPatientId: string,
  opts: { includeReview: boolean }
): UpdateRecordingMetadata {
  const payload: UpdateRecordingMetadata = {
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
  };
  // Only an EXPLICIT whole-review terminal action over the complete unresolved
  // set may claim resolution, and only when the server can actually attach it
  // (a null `aiExtractedMetadata` has nowhere to store a review state).
  if (opts.includeReview) payload.review = 'confirmed';
  return payload;
}

function changedFieldList(
  before: MetadataForm,
  after: MetadataForm
): RecordingMetadataField[] {
  return (Object.keys(before) as RecordingMetadataField[]).filter(
    (field) => before[field].trim() !== after[field].trim()
  );
}

export function MetadataReviewCard({
  recording,
  mode,
  recordFirstEnabled = false,
  saving = false,
  onConfirm,
  onDismiss,
  onSave,
}: MetadataReviewCardProps) {
  const colors = useThemeColors();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const formSeed = React.useMemo(
    () => buildMetadataFormSeed(recording, mode),
    [recording, mode]
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
  const signals = React.useMemo(
    () => computeMetadataAttentionSignals(recording),
    [recording]
  );
  // Applied (auto-filled) fields render as confirmed rows.
  const appliedRowFields = signals.validAppliedFields;
  // Every unresolved reason, in deterministic order — including generic
  // reason-only rows when the extracted value is unavailable.
  // Review mode only: in `add`/`edit` the card body already states the single
  // relevant condition, and a duplicate reason row would just repeat it.
  const reasonRows = React.useMemo(
    () => (mode === 'review' ? metadataAttentionReasons(recording, { recordFirstEnabled }) : []),
    [mode, recording, recordFirstEnabled]
  );
  // B6 — fields the AI extracted but did NOT auto-apply (low confidence /
  // multi-patient), still blank on the recording. Rendered as tappable
  // suggestions so staff fill them in one tap instead of retyping.
  const suggestions = computeSuggestionFields(recording);
  // B5 — null-extraction empty state ("AI couldn't read these").
  const showNoExtraction = shouldShowNoExtractionEmptyState(recording);
  const hasAnyFormValue = Object.values(form).some((value) => value.trim().length > 0);
  const suggestionOnlyReview = mode === 'review' && appliedRowFields.length === 0;

  const hasMetadataObject = signals.hasMetadataObject;
  // A blank patient name with nothing applied is the `metadata_missing` state:
  // no terminal action may claim resolution until it is filled in.
  const resolutionBlocked = signals.missingDetails && !form.patientName.trim();
  // Keyed off the CURRENT form value, not just `signals.missingDetails`: when a
  // review starts WITH a patient name that signal is false, so clearing the name
  // in the sheet used to leave `canFinishReview` true — saving a blank name plus
  // `review: 'confirmed'`, and the resolved-state gate then suppressed the
  // `metadata_missing` reason the updated recording would have raised. A
  // confirmed review must never assert a blank patient name (Codex round 2).
  const canFinishReview =
    mode === 'review' && hasMetadataObject && !resolutionBlocked && !!form.patientName.trim();
  // Never let a dismissal hide a blank-patient-name missing-metadata item, and
  // never offer it when the server has no blob to attach the state to.
  const canDismissReview =
    mode === 'review' && hasMetadataObject && !signals.missingDetails && !!onDismiss;

  const updateField = (field: RecordingMetadataField, value: string | null) => {
    setForm((current) => ({ ...current, [field]: value ?? '' }));
  };

  // Tapping a suggestion fills the form and opens the sheet so staff can
  // confirm/edit before saving. Never auto-applies (multi-patient risk — a
  // suggestion can belong to a different patient; see plan B6 / Risks).
  const applySuggestion = (field: RecordingMetadataField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSheetOpen(true);
  };

  const handleSave = () => {
    try {
      const changed = changedFieldList(before, form);
      onSave(
        buildPayload(form, pimsPatientId, { includeReview: canFinishReview }),
        changed.length,
        changed
      );
      setSheetOpen(false);
    } catch {
      Alert.alert('Save Failed', METADATA_REVIEW_COPY.failed);
    }
  };

  const handleKeepCurrent = () => {
    if (!onDismiss) return;
    Alert.alert(
      METADATA_REVIEW_COPY.keepCurrentConfirmTitle,
      METADATA_REVIEW_COPY.keepCurrentConfirmBody,
      [
        { text: METADATA_REVIEW_COPY.cancel, style: 'cancel' },
        { text: METADATA_REVIEW_COPY.keepCurrentConfirm, onPress: onDismiss },
      ]
    );
  };

  const title =
    mode === 'review' && !suggestionOnlyReview
      ? METADATA_REVIEW_COPY.title
      : mode === 'edit'
        ? METADATA_REVIEW_COPY.editTitle
        : METADATA_REVIEW_COPY.addTitle;
  const body =
    mode === 'review' && !suggestionOnlyReview
      ? METADATA_REVIEW_COPY.body
      : mode === 'edit'
        ? METADATA_REVIEW_COPY.editBody
        : showNoExtraction
          ? METADATA_REVIEW_COPY.addBodyNoExtraction
          : METADATA_REVIEW_COPY.addBody;

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

            {(mode === 'review' || mode === 'add') && appliedRowFields.length > 0 ? (
              <View className="mb-3">
                {appliedRowFields.map((field) => {
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

            {/* The COMPLETE unresolved reason set, before either terminal
                action. Reason-only rows appear even when the extracted value
                is unavailable — the copy never fabricates a value. */}
            {reasonRows.length > 0 ? (
              <View className="mb-3">
                <Text className="text-caption text-content-tertiary font-medium uppercase mb-1.5">
                  {METADATA_REVIEW_COPY.reasonsTitle}
                </Text>
                {reasonRows.map((reason) => (
                  <View
                    key={`${reason.code}:${reason.field ?? 'none'}`}
                    className="flex-row items-start mb-1.5"
                  >
                    <View style={{ marginRight: 6, marginTop: 2, flexShrink: 0 }}>
                      <AlertCircle color={colors.contentTertiary} size={12} />
                    </View>
                    <Text className="text-body-sm text-content-secondary flex-1" numberOfLines={3}>
                      {reason.message}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* B6 — tappable below-confidence / multi-patient suggestions. */}
            {(mode === 'review' || mode === 'add') && suggestions.length > 0 ? (
              <View className="mb-3">
                <Text className="text-caption text-content-tertiary font-medium uppercase mb-1.5">
                  {METADATA_REVIEW_COPY.suggestionsTitle}
                </Text>
                {suggestions.map(({ field, value, conflict, currentValue }) => (
                  <Pressable
                    key={field}
                    onPress={() => applySuggestion(field, value)}
                    accessibilityRole="button"
                    accessibilityLabel={
                      conflict
                        ? `Review ${FIELD_LABELS[field]} conflict. Current ${currentValue}. AI suggests ${value}`
                        : `Add ${FIELD_LABELS[field]}: ${value}`
                    }
                    className="flex-row items-center mb-1.5 py-1"
                  >
                    <Plus color={colors.brand500} size={12} style={{ marginRight: 6 }} />
                    <View className="flex-1">
                      <Text className="text-body-sm text-content-secondary" numberOfLines={2}>
                        <Text className="font-semibold">{FIELD_LABELS[field]}: </Text>
                        {value}
                      </Text>
                      {conflict && currentValue ? (
                        <Text className="text-caption text-content-tertiary mt-0.5" numberOfLines={2}>
                          {METADATA_REVIEW_COPY.conflictCurrent}: {currentValue} · {METADATA_REVIEW_COPY.conflictSuggested}: {value}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {resolutionBlocked ? (
              <Text className="text-caption text-content-tertiary mb-2" numberOfLines={2}>
                {METADATA_REVIEW_COPY.missingPatientNameHint}
              </Text>
            ) : null}

            <View className="flex-row flex-wrap gap-2">
              {canFinishReview && onConfirm ? (
                <Button
                  variant="primary"
                  size="sm"
                  onPress={onConfirm}
                  loading={saving}
                  icon={<Check color={colors.contentOnBrand} size={14} />}
                >
                  {METADATA_REVIEW_COPY.saveAndFinish}
                </Button>
              ) : null}
              <Button
                variant={canFinishReview ? 'secondary' : 'primary'}
                size="sm"
                onPress={() => setSheetOpen(true)}
                disabled={saving}
                icon={
                  <Edit2
                    color={canFinishReview ? colors.contentBody : colors.contentOnBrand}
                    size={14}
                  />
                }
              >
                {mode === 'review'
                  ? suggestionOnlyReview
                    ? METADATA_REVIEW_COPY.addDetails
                    : METADATA_REVIEW_COPY.editDetails
                  : mode === 'edit'
                    ? METADATA_REVIEW_COPY.editDetails
                  : METADATA_REVIEW_COPY.addDetails}
              </Button>
              {canDismissReview ? (
                <Button variant="ghost" size="sm" onPress={handleKeepCurrent} disabled={saving}>
                  {METADATA_REVIEW_COPY.keepCurrent}
                </Button>
              ) : null}
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
                disabled={!hasAnyFormValue || resolutionBlocked}
              >
                {canFinishReview ? METADATA_REVIEW_COPY.saveAndFinish : METADATA_REVIEW_COPY.save}
              </Button>
            </View>
          </View>
        }
      >
        {/* Every remaining suggestion stays visible here too, so editing one
            field cannot silently retire the others. */}
        {suggestions.length > 0 ? (
          <View className="mb-3">
            <Text className="text-caption text-content-tertiary font-medium uppercase mb-1.5">
              {METADATA_REVIEW_COPY.suggestionsTitle}
            </Text>
            {suggestions.map(({ field, value }) => (
              <Pressable
                key={`sheet-${field}`}
                onPress={() => applySuggestion(field, value)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${FIELD_LABELS[field]}: ${value}`}
                className="flex-row items-center mb-1.5 py-1"
              >
                <Plus color={colors.brand500} size={12} style={{ marginRight: 6 }} />
                <Text className="text-body-sm text-content-secondary flex-1" numberOfLines={2}>
                  <Text className="font-semibold">{FIELD_LABELS[field]}: </Text>
                  {value}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
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

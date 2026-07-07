import type { Recording, RecordingMetadataField } from '../types';

/**
 * Pure decision + counting helpers for the record-first observability surface
 * (Workstreams A1/A2 of the record-first reliability plan) and the
 * MetadataReviewCard suggestion/empty-state UX (B5/B6).
 *
 * These live outside the React component so they can be unit-tested
 * functionally (see tests/record-first-observability.test.mjs) rather than
 * via brittle source-regex. The component (`app/(app)/(tabs)/recordings/[id].tsx`)
 * and `MetadataReviewCard.tsx` are thin wrappers around them.
 *
 * Everything here is PHI-free at the *event* boundary: we count fields and
 * read flags, and only the MetadataReviewCard helpers surface extracted
 * VALUES — those stay on-device and are never sent to analytics.
 */

/** The five AI-fillable metadata fields, in display order. */
export const METADATA_FIELDS: RecordingMetadataField[] = [
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
];

/** PHI-free payload for the `ai_metadata_extraction_observed` event (A1). */
export interface ExtractionObservedProps {
  applied_field_count: number;
  suggested_field_count: number;
  extracted_field_count: number;
  multiple_patients_detected: boolean;
  had_metadata: boolean;
  needs_metadata_review: boolean;
  blank_field_count_at_submit: number;
  /**
   * Optional count of fields the server dropped (C7 `dropReasons`), surfaced
   * so mobile dashboards can see *that* fields were dropped without a separate
   * Connect query. PHI-free — a count only, never field values or reasons.
   */
  drop_reasons_count?: number;
}

function currentFieldValue(recording: Recording, field: RecordingMetadataField): string {
  const raw = recording[field];
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizedReason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const reason = (value as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : '';
  }
  return '';
}

function extractedConflictValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate =
    (value as { suggestedValue?: unknown }).suggestedValue ??
    (value as { value?: unknown }).value;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function hasConflictReason(recording: Recording, field: RecordingMetadataField): boolean {
  const meta = recording.aiExtractedMetadata as
    | {
        dropReasons?: unknown;
        conflicts?: unknown;
      }
    | null
    | undefined;
  const isConflict = (value: unknown) => normalizedReason(value) === 'conflicts_with_existing';

  if (Array.isArray(meta?.dropReasons)) {
    if (meta.dropReasons.some((item) =>
      item &&
      typeof item === 'object' &&
      (item as { field?: unknown }).field === field &&
      isConflict(item)
    )) {
      return true;
    }
  } else if (meta?.dropReasons && typeof meta.dropReasons === 'object') {
    if (isConflict((meta.dropReasons as Record<string, unknown>)[field])) {
      return true;
    }
  }

  return Array.isArray(meta?.conflicts) && meta.conflicts.some((item) =>
    item &&
    typeof item === 'object' &&
    (item as { field?: unknown }).field === field &&
    (normalizedReason(item) === '' || isConflict(item))
  );
}

function conflictSuggestedValue(recording: Recording, field: RecordingMetadataField): string | null {
  const meta = recording.aiExtractedMetadata as
    | {
        dropReasons?: unknown;
        conflicts?: unknown;
      }
    | null
    | undefined;

  if (Array.isArray(meta?.dropReasons)) {
    for (const item of meta.dropReasons) {
      if (item && typeof item === 'object' && (item as { field?: unknown }).field === field) {
        const value = extractedConflictValue(item);
        if (value) return value;
      }
    }
  } else if (meta?.dropReasons && typeof meta.dropReasons === 'object') {
    const value = extractedConflictValue((meta.dropReasons as Record<string, unknown>)[field]);
    if (value) return value;
  }

  if (Array.isArray(meta?.conflicts)) {
    for (const item of meta.conflicts) {
      if (item && typeof item === 'object' && (item as { field?: unknown }).field === field) {
        const value = extractedConflictValue(item);
        if (value) return value;
      }
    }
  }

  return null;
}

function appliedFieldList(recording: Recording): RecordingMetadataField[] {
  const applied = recording.aiExtractedMetadata?.appliedFields;
  return Array.isArray(applied) ? applied : [];
}

function extractedFieldList(recording: Recording): RecordingMetadataField[] {
  const fields = recording.aiExtractedMetadata?.fields;
  return fields ? (Object.keys(fields) as RecordingMetadataField[]) : [];
}

/**
 * Whether the `ai_metadata_extraction_observed` event should fire for this
 * recording. Gated on the record-first capability + a completed recording so
 * it never fires for non-record-first orgs (A1) and never fires mid-processing.
 *
 * IMPORTANT: this deliberately does NOT gate on `needsMetadataReview` /
 * `shouldShow`. The whole point of A1 is to capture the `had_metadata=false`
 * (null-extraction) cohort that never shows a review card — the population the
 * old card-based query was blind to.
 */
export function shouldEmitExtractionObserved(
  recording: Recording | null | undefined,
  recordFirstEnabled: boolean
): boolean {
  return Boolean(recordFirstEnabled) && recording?.status === 'completed';
}

/** Build the PHI-free A1 event payload. */
export function buildExtractionObservedProps(recording: Recording): ExtractionObservedProps {
  const meta = recording.aiExtractedMetadata ?? null;
  const applied = appliedFieldList(recording);
  const appliedSet = new Set(applied);
  const extracted = extractedFieldList(recording);
  const suggestedCount = extracted.filter((field) => !appliedSet.has(field)).length;

  // A field was blank at submit if the AI later filled it (it's in
  // appliedFields) OR it is still blank now. A field that's filled but NOT
  // applied was entered manually at submit → not blank.
  const blankAtSubmit = METADATA_FIELDS.filter(
    (field) => appliedSet.has(field) || currentFieldValue(recording, field) === ''
  ).length;

  const props: ExtractionObservedProps = {
    applied_field_count: applied.length,
    suggested_field_count: suggestedCount,
    extracted_field_count: extracted.length,
    multiple_patients_detected: meta?.multiplePatientsDetected ?? false,
    had_metadata: meta != null,
    needs_metadata_review: Boolean(recording.needsMetadataReview),
    blank_field_count_at_submit: blankAtSubmit,
  };

  // C7 drop-reason count, if the server attached it (optional/forward-compat).
  const dropReasons = (meta as { dropReasons?: unknown } | null)?.dropReasons;
  if (Array.isArray(dropReasons)) {
    props.drop_reasons_count = dropReasons.length;
  }

  return props;
}

/**
 * Whether to fire the `ai_extract` zero-fill warning (A2).
 *
 * Discriminator is "patient name still blank now" — a manually-filled
 * recording has the patient name populated and self-excludes. Fires when a
 * completed record-first recording with a blank patient name returns no
 * metadata at all OR applied nothing.
 *
 * IMPORTANT: do NOT gate this on `needsMetadataReview`. The server clears that
 * flag when extraction returns null (no suggestions to review) — i.e. the
 * exact zero-fill failure this must catch. The blank-patient-name check is
 * what keeps normal manual recordings from spuriously warning.
 */
export function shouldReportZeroFill(
  recording: Recording | null | undefined,
  recordFirstEnabled: boolean
): boolean {
  if (!recording || !shouldEmitExtractionObserved(recording, recordFirstEnabled)) return false;
  const patientNameBlank = currentFieldValue(recording, 'patientName') === '';
  if (!patientNameBlank) return false;
  const meta = recording.aiExtractedMetadata ?? null;
  const appliedCount = appliedFieldList(recording).length;
  return meta == null || appliedCount === 0;
}

/** Error code for the A2 warning — distinguishes null-extraction from zero-applied. */
export function zeroFillErrorCode(recording: Recording): 'null_extraction' | 'zero_applied' {
  return recording.aiExtractedMetadata == null ? 'null_extraction' : 'zero_applied';
}

export interface MetadataSuggestion {
  field: RecordingMetadataField;
  value: string;
  conflict?: boolean;
  currentValue?: string;
}

/**
 * Below-confidence / multi-patient suggestions to surface as tappable rows
 * (B6): fields the AI extracted but did NOT auto-apply, where the field is
 * still blank on the recording (don't suggest overwriting staff input) and the
 * extracted value is non-empty.
 */
export function computeSuggestionFields(recording: Recording): MetadataSuggestion[] {
  const meta = recording.aiExtractedMetadata;
  if (!meta) return [];
  const fields = meta.fields ?? {};
  const appliedSet = new Set(appliedFieldList(recording));
  const suggestions: MetadataSuggestion[] = [];
  for (const field of METADATA_FIELDS) {
    if (appliedSet.has(field)) continue;
    const currentValue = currentFieldValue(recording, field);
    const extractedValue = fields[field]?.value;
    const value =
      typeof extractedValue === 'string' && extractedValue.trim().length > 0
        ? extractedValue.trim()
        : conflictSuggestedValue(recording, field);
    if (!value) continue;

    if (currentValue !== '') {
      if (hasConflictReason(recording, field) && currentValue !== value) {
        suggestions.push({ field, value, conflict: true, currentValue });
      }
      continue;
    }
    suggestions.push({ field, value });
  }
  return suggestions;
}

/**
 * Whether the "AI couldn't read these — add them" empty state (B5) should
 * show: a completed record-first recording with a blank patient name, nothing
 * auto-applied, and no tappable suggestions to offer.
 */
export function shouldShowNoExtractionEmptyState(recording: Recording): boolean {
  const patientNameBlank = currentFieldValue(recording, 'patientName') === '';
  if (!patientNameBlank) return false;
  if (appliedFieldList(recording).length > 0) return false;
  return computeSuggestionFields(recording).length === 0;
}

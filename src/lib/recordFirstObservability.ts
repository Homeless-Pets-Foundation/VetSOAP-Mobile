import type {
  AiExtractedMetadata,
  AiMetadataDropReasonCode,
  RecordingMetadataField,
  RecordingStatus,
} from '../types';

/**
 * Runtime mirror of the server's closed drop-reason vocabulary. `satisfies`
 * rejects an invalid member and the `never` assertion below rejects a MISSING
 * one, so this array and `AiMetadataDropReasonCode` cannot drift apart.
 */
export const AI_METADATA_DROP_REASONS = [
  'null_extraction',
  'already_filled',
  'conflicts_with_existing',
  'low_confidence',
  'not_verbatim',
  'multi_patient',
] as const satisfies readonly AiMetadataDropReasonCode[];

type _AllDropReasonsCovered = Exclude<
  AiMetadataDropReasonCode,
  (typeof AI_METADATA_DROP_REASONS)[number]
> extends never
  ? true
  : never;
/** Compile-time only: unused value keeps the exhaustiveness assertion alive. */
const _dropReasonsExhaustive: _AllDropReasonsCovered = true;
void _dropReasonsExhaustive;

/**
 * Pure decision + counting helpers for the record-first observability surface
 * (the PHI-free product event), the MetadataReviewCard suggestion/empty-state
 * UX (B5/B6), and the Attention Feed's metadata predicates.
 *
 * These live outside the React component so they can be unit-tested
 * functionally (see tests/record-first-observability.test.mjs) rather than
 * via brittle source-regex. The component (`app/(app)/(tabs)/recordings/[id].tsx`),
 * `MetadataReviewCard.tsx`, and `src/lib/attentionFeed.ts` are thin wrappers
 * around them — there is exactly ONE drop-reason parser and ONE unresolved-AI
 * predicate in the app.
 *
 * Everything here is PHI-free at the *event* boundary: we count fields and
 * read flags, and only the suggestion helpers surface extracted VALUES — those
 * stay on-device and are never sent to analytics.
 */

/** The five AI-fillable metadata fields, in display order. */
export const METADATA_FIELDS: RecordingMetadataField[] = [
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
];

/**
 * Server-side length bounds for each metadata field (Connect's
 * `UpdateRecordingMetadata` schema). On-device summary copy normalizes through
 * these so a legacy overlong value cannot blow up a feed row; the full source
 * value still renders on the detail screen.
 */
export const METADATA_FIELD_MAX_LENGTH: Record<RecordingMetadataField, number> = {
  patientName: 100,
  clientName: 100,
  species: 50,
  breed: 100,
  appointmentType: 100,
};

/**
 * Traversal cap for a drop-reason payload: two passes over every possible
 * (field, reason) pair. A corrupt historical blob with thousands of entries
 * must not create an unbounded render/event array; the normalized output is
 * additionally deduplicated to the finite (field, reason) vocabulary.
 */
export const DROP_REASON_SCAN_LIMIT =
  METADATA_FIELDS.length * AI_METADATA_DROP_REASONS.length * 2;

/**
 * ASCII/C1 control characters plus the Unicode line/paragraph separators. A
 * legacy value carrying these would break a single-line feed row and leak a
 * multi-line blob into an accessibility label.
 */
const CONTROL_WHITESPACE_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

const METADATA_FIELD_SET = new Set<string>(METADATA_FIELDS);
const DROP_REASON_SET = new Set<string>(AI_METADATA_DROP_REASONS);
const FIELD_ORDER = new Map<RecordingMetadataField, number>(
  METADATA_FIELDS.map((field, index) => [field, index])
);

/**
 * Narrow structural input: only the fields these helpers actually read. The
 * broad `Recording` (and the feed's `AttentionRecording`) are both assignable,
 * but nothing here may reach for a detail-only column.
 */
export interface MetadataRecordingInput {
  status?: RecordingStatus | string;
  patientName?: string | null;
  clientName?: string | null;
  species?: string | null;
  breed?: string | null;
  appointmentType?: string | null;
  aiExtractedMetadata?: AiExtractedMetadata | null;
  needsMetadataReview?: boolean;
}

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
   * Uses the NORMALIZED list so a legacy record-form payload and an array
   * payload report the same number.
   */
  drop_reasons_count?: number;
}

export interface NormalizedDropReason {
  field: RecordingMetadataField;
  reason: AiMetadataDropReasonCode;
  /** Present only when the server attached a finite confidence score in [0,1]. */
  score?: number;
}

export interface NormalizedConflict {
  field: RecordingMetadataField;
  /** A conflict entry may omit its reason; only a known code survives. */
  reason?: AiMetadataDropReasonCode;
  suggestedValue?: string;
  currentValue?: string;
}

function isMetadataField(value: unknown): value is RecordingMetadataField {
  return typeof value === 'string' && METADATA_FIELD_SET.has(value);
}

function isDropReasonCode(value: unknown): value is AiMetadataDropReasonCode {
  return typeof value === 'string' && DROP_REASON_SET.has(value);
}

/**
 * Trim, collapse control/newline whitespace, and bound a metadata value to its
 * server length limit. Returns '' for anything that is not a usable string —
 * copy therefore never interpolates `null`, `undefined`, or a raw legacy blob.
 */
export function normalizeMetadataValue(
  value: unknown,
  field: RecordingMetadataField
): string {
  return normalizeDisplayText(value, METADATA_FIELD_MAX_LENGTH[field]);
}

/**
 * Generic row-safe text normalizer: trim, collapse control/newline whitespace,
 * and bound the length. Used for metadata values and for server quality-warning
 * sentences so neither can break a single-line row or an a11y label.
 */
export function normalizeDisplayText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(CONTROL_WHITESPACE_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return maxLength > 0 ? collapsed.slice(0, maxLength) : collapsed;
}

export function currentMetadataValue(
  recording: MetadataRecordingInput,
  field: RecordingMetadataField
): string {
  return normalizeMetadataValue(recording[field], field);
}

function metadataObject(
  recording: MetadataRecordingInput
): AiExtractedMetadata | null {
  const meta = recording.aiExtractedMetadata;
  return meta && typeof meta === 'object' ? meta : null;
}

function pushNormalizedDrop(
  out: NormalizedDropReason[],
  seen: Set<string>,
  field: RecordingMetadataField,
  reason: unknown,
  score: unknown
): void {
  if (!isDropReasonCode(reason)) return;
  const key = `${field}:${reason}`;
  if (seen.has(key)) return;
  seen.add(key);
  const entry: NormalizedDropReason = { field, reason };
  if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) {
    entry.score = score;
  }
  out.push(entry);
}

/**
 * THE canonical drop-reason parser. Accepts the current array payload and the
 * defensive legacy record form (`{ species: 'low_confidence' }` /
 * `{ species: { reason: 'low_confidence' } }`), and discards every unknown
 * key/field/reason — including the PHI-bearing `value`/`suggestedValue`/
 * `currentValue` keys some historical blobs carry, which must never reach the
 * analytics boundary or on-device copy.
 *
 * Output is deduplicated by (field, reason) and sorted by field order then
 * reason order, so downstream ranking/analytics are independent of payload
 * order.
 */
export function parseMetadataDropReasons(
  source: MetadataRecordingInput | AiExtractedMetadata | null | undefined
): NormalizedDropReason[] {
  const meta =
    source && typeof source === 'object' && 'aiExtractedMetadata' in source
      ? metadataObject(source as MetadataRecordingInput)
      : ((source as AiExtractedMetadata | null | undefined) ?? null);
  if (!meta || typeof meta !== 'object') return [];

  const raw = (meta as { dropReasons?: unknown }).dropReasons;
  const out: NormalizedDropReason[] = [];
  const seen = new Set<string>();

  if (Array.isArray(raw)) {
    const limit = Math.min(raw.length, DROP_REASON_SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      const item = raw[i];
      if (!item || typeof item !== 'object') continue;
      const candidate = item as { field?: unknown; reason?: unknown; score?: unknown };
      if (!isMetadataField(candidate.field)) continue;
      pushNormalizedDrop(out, seen, candidate.field, candidate.reason, candidate.score);
    }
  } else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    const limit = Math.min(keys.length, DROP_REASON_SCAN_LIMIT);
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      if (!isMetadataField(key)) continue;
      const value = record[key];
      if (typeof value === 'string') {
        pushNormalizedDrop(out, seen, key, value, undefined);
      } else if (value && typeof value === 'object') {
        const candidate = value as { reason?: unknown; score?: unknown };
        pushNormalizedDrop(out, seen, key, candidate.reason, candidate.score);
      }
    }
  }

  out.sort((a, b) => {
    const fieldDelta = (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0);
    if (fieldDelta !== 0) return fieldDelta;
    return (
      AI_METADATA_DROP_REASONS.indexOf(a.reason) - AI_METADATA_DROP_REASONS.indexOf(b.reason)
    );
  });
  return out;
}

/**
 * Forward-compatible `conflicts[]` parser. Connect never writes this key today
 * — conflict UI is driven from `dropReasons` — but the payload IS specified to
 * carry values, so it (and only it, alongside `fields`) may supply an on-device
 * suggested/current value.
 */
export function parseMetadataConflicts(
  recording: MetadataRecordingInput
): NormalizedConflict[] {
  const meta = metadataObject(recording);
  const raw = (meta as { conflicts?: unknown } | null)?.conflicts;
  if (!Array.isArray(raw)) return [];

  const out: NormalizedConflict[] = [];
  const seen = new Set<string>();
  const limit = Math.min(raw.length, DROP_REASON_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const candidate = item as {
      field?: unknown;
      reason?: unknown;
      suggestedValue?: unknown;
      value?: unknown;
      currentValue?: unknown;
    };
    if (!isMetadataField(candidate.field)) continue;
    if (seen.has(candidate.field)) continue;
    // A conflict entry with an explicit but UNKNOWN reason is not a conflict.
    if (candidate.reason !== undefined && !isDropReasonCode(candidate.reason)) continue;
    if (isDropReasonCode(candidate.reason) && candidate.reason !== 'conflicts_with_existing') continue;
    seen.add(candidate.field);
    const entry: NormalizedConflict = { field: candidate.field };
    if (isDropReasonCode(candidate.reason)) entry.reason = candidate.reason;
    const suggested = normalizeMetadataValue(
      typeof candidate.suggestedValue === 'string' ? candidate.suggestedValue : candidate.value,
      candidate.field
    );
    if (suggested) entry.suggestedValue = suggested;
    const current = normalizeMetadataValue(candidate.currentValue, candidate.field);
    if (current) entry.currentValue = current;
    out.push(entry);
  }

  out.sort((a, b) => (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0));
  return out;
}

/** Unique, known applied fields in display order (payload-order independent). */
export function normalizedAppliedFields(
  recording: MetadataRecordingInput
): RecordingMetadataField[] {
  const meta = metadataObject(recording);
  const applied = (meta as { appliedFields?: unknown } | null)?.appliedFields;
  if (!Array.isArray(applied)) return [];
  const seen = new Set<RecordingMetadataField>();
  for (const value of applied.slice(0, DROP_REASON_SCAN_LIMIT)) {
    if (isMetadataField(value)) seen.add(value);
  }
  return METADATA_FIELDS.filter((field) => seen.has(field));
}

/**
 * Applied fields that actually put a non-blank value on the row. An unknown,
 * duplicated, or blank applied field must never inflate a "Captivet filled N
 * details" count.
 */
export function validAppliedFields(
  recording: MetadataRecordingInput
): RecordingMetadataField[] {
  return normalizedAppliedFields(recording).filter(
    (field) => currentMetadataValue(recording, field) !== ''
  );
}

/** Known extracted fields present in the `fields` map, in display order. */
export function normalizedExtractedFields(
  recording: MetadataRecordingInput
): RecordingMetadataField[] {
  const meta = metadataObject(recording);
  const fields = (meta as { fields?: unknown } | null)?.fields;
  if (!fields || typeof fields !== 'object') return [];
  const present = new Set(
    Object.keys(fields as Record<string, unknown>).filter(isMetadataField)
  );
  return METADATA_FIELDS.filter((field) => present.has(field));
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
  recording: Pick<MetadataRecordingInput, 'status'> | null | undefined,
  recordFirstEnabled: boolean
): boolean {
  return Boolean(recordFirstEnabled) && recording?.status === 'completed';
}

/** Build the PHI-free A1 event payload. */
export function buildExtractionObservedProps(
  recording: MetadataRecordingInput
): ExtractionObservedProps {
  const meta = metadataObject(recording);
  const applied = normalizedAppliedFields(recording);
  const appliedSet = new Set(applied);
  const extracted = normalizedExtractedFields(recording);
  const suggestedCount = extracted.filter((field) => !appliedSet.has(field)).length;

  // A field was blank at submit if the AI later filled it (it's in
  // appliedFields) OR it is still blank now. A field that's filled but NOT
  // applied was entered manually at submit → not blank.
  const blankAtSubmit = METADATA_FIELDS.filter(
    (field) => appliedSet.has(field) || currentMetadataValue(recording, field) === ''
  ).length;

  const props: ExtractionObservedProps = {
    applied_field_count: applied.length,
    suggested_field_count: suggestedCount,
    extracted_field_count: extracted.length,
    multiple_patients_detected: meta?.multiplePatientsDetected === true,
    had_metadata: meta != null,
    needs_metadata_review: Boolean(recording.needsMetadataReview),
    blank_field_count_at_submit: blankAtSubmit,
  };

  // C7 drop-reason count, if the server attached it (optional/forward-compat).
  // Counted from the NORMALIZED list so array and legacy record payloads agree
  // and invalid entries never inflate the number.
  const rawDropReasons = (meta as { dropReasons?: unknown } | null)?.dropReasons;
  if (rawDropReasons !== undefined && rawDropReasons !== null) {
    props.drop_reasons_count = parseMetadataDropReasons(recording).length;
  }

  return props;
}

export interface MetadataSuggestion {
  field: RecordingMetadataField;
  value: string;
  conflict?: boolean;
  currentValue?: string;
}

function conflictSuggestedValue(
  conflicts: NormalizedConflict[],
  field: RecordingMetadataField
): string | null {
  const match = conflicts.find((entry) => entry.field === field);
  return match?.suggestedValue ?? null;
}

function hasConflictReason(
  drops: NormalizedDropReason[],
  conflicts: NormalizedConflict[],
  field: RecordingMetadataField
): boolean {
  return (
    drops.some((drop) => drop.field === field && drop.reason === 'conflicts_with_existing') ||
    conflicts.some((entry) => entry.field === field)
  );
}

/**
 * Below-confidence / multi-patient suggestions to surface as tappable rows
 * (B6): fields the AI extracted but did NOT auto-apply, where the field is
 * still blank on the recording (don't suggest overwriting staff input) and the
 * extracted value is non-empty.
 *
 * Values come ONLY from `fields[field].value` (nullable per the server schema)
 * or the forward-compatible `conflicts[]` payload. The C7 drop reason is
 * PHI-free by construction and must never be mined for a value.
 */
export function computeSuggestionFields(
  recording: MetadataRecordingInput
): MetadataSuggestion[] {
  const meta = metadataObject(recording);
  if (!meta) return [];
  const fields = meta.fields ?? {};
  const appliedSet = new Set(normalizedAppliedFields(recording));
  const drops = parseMetadataDropReasons(recording);
  const conflicts = parseMetadataConflicts(recording);
  const suggestions: MetadataSuggestion[] = [];

  for (const field of METADATA_FIELDS) {
    if (appliedSet.has(field)) continue;
    const currentValue = currentMetadataValue(recording, field);
    const extractedValue = normalizeMetadataValue(fields[field]?.value, field);
    const value = extractedValue || conflictSuggestedValue(conflicts, field);
    if (!value) continue;

    if (currentValue !== '') {
      if (hasConflictReason(drops, conflicts, field) && currentValue !== value) {
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
 * show: a completed recording with a blank patient name, nothing validly
 * auto-applied, and no tappable suggestions to offer.
 */
export function shouldShowNoExtractionEmptyState(
  recording: MetadataRecordingInput
): boolean {
  if (currentMetadataValue(recording, 'patientName') !== '') return false;
  // "Nothing was applied" means nothing landed a non-blank value on the row.
  // An applied field the server named but never actually populated must not
  // suppress the empty state (attention-feed plan: zero VALID applied fields).
  if (validAppliedFields(recording).length > 0) return false;
  return computeSuggestionFields(recording).length === 0;
}

/**
 * The server preserves historical `dropReasons` after a metadata save and only
 * flips `aiExtractedMetadata.review` to confirmed/dismissed
 * (`recordings.ts:5356-5363`). Without this gate every low-confidence/conflict
 * row would be immortal after the vet fixed it.
 */
export function isAiMetadataReviewResolved(
  recording: MetadataRecordingInput
): boolean {
  const review = metadataObject(recording)?.review;
  return review === 'confirmed' || review === 'dismissed';
}

export interface MetadataAttentionSignals {
  /** An explicit `aiExtractedMetadata` OBJECT exists (not the null cohort). */
  hasMetadataObject: boolean;
  /** review === 'confirmed' | 'dismissed' — suppresses every AI signal. */
  resolved: boolean;
  /** review === 'unconfirmed' — a fail-safe reason even if details normalize away. */
  explicitUnconfirmed: boolean;
  multiplePatients: boolean;
  conflictFields: RecordingMetadataField[];
  lowConfidenceFields: RecordingMetadataField[];
  notVerbatimFields: RecordingMetadataField[];
  /** Suggestions with no known per-field reason and no multi-patient explanation. */
  unclassifiedSuggestionFields: RecordingMetadataField[];
  validAppliedFields: RecordingMetadataField[];
  suggestions: MetadataSuggestion[];
  /** Blank patient name + nothing validly applied + no suggestion. */
  missingDetails: boolean;
}

/**
 * ONE normalized classification of a recording's AI-metadata state, shared by
 * the detail review card, its `ai_metadata_review_shown` effect, and the
 * attention feed. Evaluates `dropReasons`/suggestions DIRECTLY — never
 * `needsMetadataReview` alone: `review: 'none'` still hides real
 * low-confidence/not-verbatim suggestions (`metadata-extraction.ts:409-427`),
 * which is exactly the "AI did nothing and nobody knows" cohort.
 */
export function computeMetadataAttentionSignals(
  recording: MetadataRecordingInput
): MetadataAttentionSignals {
  const meta = metadataObject(recording);
  const drops = parseMetadataDropReasons(recording);
  const conflicts = parseMetadataConflicts(recording);
  const suggestions = computeSuggestionFields(recording);
  const dropFieldSet = new Set(drops.map((drop) => drop.field));
  const conflictFieldSet = new Set(conflicts.map((entry) => entry.field));

  const multiplePatients =
    meta?.multiplePatientsDetected === true ||
    drops.some((drop) => drop.reason === 'multi_patient');

  const conflictFields = METADATA_FIELDS.filter(
    (field) =>
      drops.some((drop) => drop.field === field && drop.reason === 'conflicts_with_existing') ||
      conflictFieldSet.has(field)
  );
  const lowConfidenceFields = METADATA_FIELDS.filter((field) =>
    drops.some((drop) => drop.field === field && drop.reason === 'low_confidence')
  );
  const notVerbatimFields = METADATA_FIELDS.filter((field) =>
    drops.some((drop) => drop.field === field && drop.reason === 'not_verbatim')
  );
  const unclassifiedSuggestionFields = multiplePatients
    ? []
    : suggestions
        .map((suggestion) => suggestion.field)
        .filter((field) => !dropFieldSet.has(field) && !conflictFieldSet.has(field));

  return {
    hasMetadataObject: meta != null,
    resolved: isAiMetadataReviewResolved(recording),
    explicitUnconfirmed: meta?.review === 'unconfirmed',
    multiplePatients,
    conflictFields,
    lowConfidenceFields,
    notVerbatimFields,
    unclassifiedSuggestionFields,
    validAppliedFields: validAppliedFields(recording),
    suggestions,
    missingDetails: shouldShowNoExtractionEmptyState(recording),
  };
}

/**
 * True when an explicit AI-metadata object still needs human attention. Used
 * by the detail screen to open `MetadataReviewCard` in REVIEW mode (instead of
 * the generic edit mode) and by the feed to emit metadata rows.
 *
 * Deliberately independent of the current `record_first` capability: disabling
 * future record-first capture must not orphan existing AI review work. Only the
 * origin-ambiguous `aiExtractedMetadata === null` cohort is capability-gated,
 * and that lives at the call site.
 */
export function hasUnresolvedAiMetadataAttention(
  recording: MetadataRecordingInput
): boolean {
  const signals = computeMetadataAttentionSignals(recording);
  if (!signals.hasMetadataObject || signals.resolved) return false;
  // `signals.multiplePatients` is deliberately NOT a term here. It raises no
  // user-facing reason any more (2026-07-29 owner decision), so counting it
  // would open a review card whose reason list is empty.
  return (
    signals.conflictFields.length > 0 ||
    signals.lowConfidenceFields.length > 0 ||
    signals.notVerbatimFields.length > 0 ||
    signals.unclassifiedSuggestionFields.length > 0 ||
    signals.validAppliedFields.length > 0 ||
    signals.missingDetails ||
    signals.explicitUnconfirmed
  );
}

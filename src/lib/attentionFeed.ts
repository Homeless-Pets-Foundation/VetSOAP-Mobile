import type {
  AiExtractedMetadata,
  Recording,
  RecordingMetadataField,
  RecordingStatus,
  User,
} from '../types';
import { ATTENTION_FEED_COPY, METADATA_FIELD_LABELS } from '../constants/strings';
import { displayPatientName } from './recordingDisplay';
import { canRecordAppointments, getRecordingPermissions } from './recordingPermissions';
import {
  computeMetadataAttentionSignals,
  currentMetadataValue,
  DROP_REASON_SCAN_LIMIT,
  normalizeDisplayText,
  normalizeMetadataValue,
  type MetadataSuggestion,
} from './recordFirstObservability';

/**
 * PURE derivation for the Attention Feed (2026-07-29 plan).
 *
 * No React, no fetch, no timers, and no ambient `Date.now()` — `nowMs` is
 * always injected so every time-based predicate is deterministic under test.
 * Its input is a NARROW list-shaped row (`AttentionRecording`) containing only
 * fields the `GET /api/recordings` select actually returns; the broad detail
 * `Recording` stays structurally assignable but this module can never reach for
 * an omitted column (`audioFileUrl`, `processingStartedAt`, `errorCode`,
 * `errorMessage`).
 *
 * The derived `AttentionFeedItem` is a SANITIZED view model: it never retains
 * the raw row, the raw failure message, the whole AI blob, or the whole
 * warnings array. Analytics props are built explicitly from bounded
 * enums/counts at the call site — never by spreading an item.
 */

// ─── Narrow list-shaped input ──────────────────────────────────────────────

/**
 * Exactly the fields selected by the recordings list route. Deliberately
 * EXCLUDES `audioFileUrl`, `processingStartedAt`, `reviewStatus`, `errorCode`,
 * `errorMessage`, and the synthetic `needsMetadataReview` flag (whose
 * incomplete gate is the blindness this feed exists to fix).
 */
export interface AttentionRecording {
  id: string;
  userId: string;
  status: RecordingStatus;
  patientName: string;
  clientName: string | null;
  species: string | null;
  breed: string | null;
  appointmentType: string | null;
  qualityWarnings: string[];
  /**
   * Bounded facts about a `qualityWarnings` array longer than the scan window.
   * Optional so a full detail `Recording` stays assignable. Never the dropped
   * strings themselves.
   */
  qualityWarningsTruncated?: boolean;
  qualityWarningsTotal?: number;
  aiExtractedMetadata?: AiExtractedMetadata | null;
  submittedAt?: string | null;
  updatedAt: string;
}

/** Compile-time proof that a full detail `Recording` stays assignable. */
type _RecordingIsAttentionRecording = Recording extends AttentionRecording ? true : never;
const _recordingAssignable: _RecordingIsAttentionRecording = true;
void _recordingAssignable;

export type AttentionUser = Pick<User, 'id' | 'role'>;

// ─── Reason vocabulary + deterministic priority ────────────────────────────

export type AttentionReasonCode =
  | 'recording_failed'
  | 'retry_scheduled'
  | 'stuck_processing'
  | 'local_drafts'
  | 'local_saved_sessions'
  | 'metadata_conflict'
  | 'metadata_confirm'
  | 'metadata_missing'
  | 'metadata_low_confidence'
  | 'metadata_not_verbatim'
  | 'metadata_suggestion_unclassified'
  | 'quality_warning';

/** Rank order. Index 0 is the most urgent. */
export const ATTENTION_REASON_PRIORITY: readonly AttentionReasonCode[] = [
  'recording_failed',
  'retry_scheduled',
  'stuck_processing',
  'local_drafts',
  'local_saved_sessions',
  'metadata_conflict',
  'metadata_confirm',
  'metadata_missing',
  'metadata_low_confidence',
  'metadata_not_verbatim',
  'metadata_suggestion_unclassified',
  'quality_warning',
] as const;

export type AttentionCategory = 'processing' | 'metadata' | 'quality' | 'local';

export const ATTENTION_CATEGORY_BY_REASON: Record<AttentionReasonCode, AttentionCategory> = {
  recording_failed: 'processing',
  retry_scheduled: 'processing',
  stuck_processing: 'processing',
  local_drafts: 'local',
  local_saved_sessions: 'local',
  metadata_conflict: 'metadata',
  metadata_confirm: 'metadata',
  metadata_missing: 'metadata',
  metadata_low_confidence: 'metadata',
  metadata_not_verbatim: 'metadata',
  metadata_suggestion_unclassified: 'metadata',
  quality_warning: 'quality',
};

export type AttentionFocus = 'metadata' | 'processing' | 'quality';

export const ATTENTION_FOCUS_VALUES: readonly AttentionFocus[] = [
  'metadata',
  'processing',
  'quality',
] as const;

/** Allowlist gate for the `focus=` route parameter (params are untrusted). */
export function parseAttentionFocus(value: unknown): AttentionFocus | null {
  return typeof value === 'string' && (ATTENTION_FOCUS_VALUES as readonly string[]).includes(value)
    ? (value as AttentionFocus)
    : null;
}

export type AttentionDestination =
  | { kind: 'recording_detail'; recordingId: string; focus: AttentionFocus | null }
  | { kind: 'recordings_list' }
  | { kind: 'record_tab' }
  | { kind: 'recovery' }
  /**
   * Non-navigating: the row states what must happen and offers no tap.
   * Used where every candidate screen would reject this viewer, so a link would
   * be a dead end.
   */
  | { kind: 'informational' };

export interface AttentionReason {
  code: AttentionReasonCode;
  /** Present only for per-field metadata reasons. */
  field: RecordingMetadataField | null;
  /** Row-safe, already length-bounded copy. */
  message: string;
  /** Only for `quality_warning`: how many warnings the row carries. */
  warningCount?: number;
}

export interface AttentionFeedItem {
  /** Stable identity. Never an array index, display text, or extracted value. */
  key: string;
  recordingId: string | null;
  title: string;
  body: string;
  category: AttentionCategory;
  primaryReason: AttentionReasonCode;
  primaryField: RecordingMetadataField | null;
  reasons: AttentionReason[];
  /** `reasons.length - 1` — drives "+N more issues". */
  extraIssueCount: number;
  /** Quality rows only: total server warnings (first one is in `reasons`). */
  warningCount: number;
  actionable: boolean;
  destination: AttentionDestination;
  /** `null` for read-only rows — never promise an action the server rejects. */
  ctaLabel: string | null;
  accessibilityLabel: string;
  submittedAtMs: number | null;
  updatedAtMs: number | null;
}

// ─── Timing constants (mirror Connect's recording-retry windows) ───────────

/** `uploaded` with committed audio: the server itself retries after 5 minutes. */
export const STUCK_UPLOADED_MS = 5 * 60_000;
/** `transcribing` / `transcribed` / `generating`. */
export const STUCK_ACTIVE_PROCESSING_MS = 20 * 60_000;
/** Prepared upload: the signed-upload window plus grace. */
export const STUCK_UPLOADING_MS = 35 * 60_000;

export const ACTIVE_PROCESSING_STATUSES: readonly RecordingStatus[] = [
  'transcribing',
  'transcribed',
  'generating',
] as const;

/** Statuses whose source state can still change without user action. */
export const POLLABLE_ATTENTION_STATUSES: readonly RecordingStatus[] = [
  'uploading',
  'uploaded',
  'transcribing',
  'transcribed',
  'generating',
  'retry_scheduled',
] as const;

export const QUALITY_WARNING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const QUALITY_WARNING_MAX_LENGTH = 240;

export type AudioAvailability = 'known_present' | 'known_absent' | 'unknown';

/**
 * The stale-processing window for a status. The list response omits
 * `audioFileUrl`, so a list-shaped `uploading` row cannot tell a committed
 * upload (server-retryable at 5 min) from a prepared one (35 min); it passes
 * `unknown` and gets the conservative window. The detail screen, which knows
 * `audioFileUrl`, passes `known_present` and gets the exact 5-minute window.
 */
export function stuckThresholdMs(
  status: RecordingStatus,
  audioAvailability: AudioAvailability
): number | null {
  if (status === 'uploaded') return STUCK_UPLOADED_MS;
  if (status === 'uploading') {
    return audioAvailability === 'known_present' ? STUCK_UPLOADED_MS : STUCK_UPLOADING_MS;
  }
  if (ACTIVE_PROCESSING_STATUSES.includes(status)) return STUCK_ACTIVE_PROCESSING_MS;
  return null;
}

export type ProcessingStaleness = 'not_applicable' | 'fresh' | 'stale' | 'unknown_timing';

/**
 * Row-age staleness. `unknown_timing` means the row HAS a supported
 * time-dependent predicate but no usable clock input — it never becomes a
 * guessed "stuck" row, but the surface also cannot claim a clean check.
 */
export function getProcessingStaleness(input: {
  status: RecordingStatus;
  updatedAtMs: number | null;
  nowMs: number;
  audioAvailability: AudioAvailability;
}): ProcessingStaleness {
  const threshold = stuckThresholdMs(input.status, input.audioAvailability);
  if (threshold === null) return 'not_applicable';
  if (input.updatedAtMs === null || !Number.isFinite(input.updatedAtMs)) return 'unknown_timing';
  const age = input.nowMs - input.updatedAtMs;
  // A future timestamp (device clock skew / bad server value) is not proof of
  // freshness; it is an unusable clock input.
  if (age < 0) return 'unknown_timing';
  return age >= threshold ? 'stale' : 'fresh';
}

// ─── Defensive projection ──────────────────────────────────────────────────

const RECORDING_STATUSES: readonly RecordingStatus[] = [
  'draft',
  'uploading',
  'uploaded',
  'transcribing',
  'transcribed',
  'generating',
  'retry_scheduled',
  'completed',
  'failed',
  'pending_metadata',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROW_FIELD_MAX_LENGTH: Record<RecordingMetadataField, number> = {
  patientName: 100,
  clientName: 100,
  species: 50,
  breed: 100,
  appointmentType: 100,
};

/** Bounded scan so a corrupt `qualityWarnings` array cannot grow a row. */
export const MAX_QUALITY_WARNINGS_SCANNED = 20;

/** ISO-8601 timestamps are ~24-30 chars; anything longer is not a timestamp. */
const MAX_TIMESTAMP_LENGTH = 64;

function isRecordingStatus(value: unknown): value is RecordingStatus {
  return typeof value === 'string' && (RECORDING_STATUSES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Project ANY raw payload down to the narrow attention shape, or `null` when
 * it is structurally unusable. Applied at BOTH the network boundary and the
 * cache-mutation boundary so a broad detail object's failure/audio fields can
 * never drift back into the attention cache.
 */
export function projectAttentionRecording(raw: unknown): AttentionRecording | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.userId !== 'string' || row.userId.length === 0) return null;
  if (!isRecordingStatus(row.status)) return null;
  if (typeof row.patientName !== 'string') return null;
  if (typeof row.updatedAt !== 'string' || row.updatedAt.length === 0) return null;

  const clientName = optionalString(row.clientName);
  const species = optionalString(row.species);
  const breed = optionalString(row.breed);
  const appointmentType = optionalString(row.appointmentType);
  if (
    clientName === undefined ||
    species === undefined ||
    breed === undefined ||
    appointmentType === undefined
  ) {
    return null;
  }

  const submittedAt = optionalString(row.submittedAt);
  if (submittedAt === undefined) return null;

  if (row.qualityWarnings !== undefined && !Array.isArray(row.qualityWarnings)) return null;
  const rawWarnings = Array.isArray(row.qualityWarnings) ? row.qualityWarnings : [];
  if (rawWarnings.some((warning) => typeof warning !== 'string')) return null;

  const meta = row.aiExtractedMetadata;
  if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    patientName: row.patientName,
    clientName,
    species,
    breed,
    appointmentType,
    qualityWarnings: (rawWarnings as string[]).slice(0, MAX_QUALITY_WARNINGS_SCANNED),
    qualityWarningsTruncated: rawWarnings.length > MAX_QUALITY_WARNINGS_SCANNED,
    qualityWarningsTotal: rawWarnings.length,
    aiExtractedMetadata: (meta ?? null) as AiExtractedMetadata | null,
    submittedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The AI-metadata keys this feed actually consumes, with the type each must have
 * WHEN PRESENT. An absent key is always fine — the server omits what it has not
 * computed.
 *
 * Without this, a present-but-corrupt nested contract passed the boundary on an
 * unchecked cast and the downstream normalizers silently discarded the unusable
 * part. `classificationComplete` tracks only TIMING, so a coverage-complete
 * response could then produce the positive all-clear for a row whose metadata was
 * never actually classified.
 */
const METADATA_REVIEW_STATES: readonly string[] = ['none', 'unconfirmed', 'confirmed', 'dismissed'];

/** One `dropReasons` entry, in either the array or the legacy record form. */
function dropReasonEntryIsUsable(field: unknown, value: unknown): boolean {
  if (typeof field !== 'string') return false;
  // The reason may be the bare code (record form) or live on an object.
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.reason !== undefined && typeof entry.reason !== 'string') return false;
  if (entry.score !== undefined && typeof entry.score !== 'number') return false;
  return true;
}

const AI_METADATA_SHAPE: Record<string, (value: unknown) => boolean> = {
  // The ENUM, not merely a string: `review: 'corrupt'` used to pass, raise no
  // reason, and still count as fully classified — a coverage-complete response
  // could then claim all-clear for a row whose review state was unreadable.
  review: (v) => typeof v === 'string' && METADATA_REVIEW_STATES.includes(v),
  appliedFields: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string'),
  dropReasons: (v) => {
    if (Array.isArray(v)) {
      return v.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        return dropReasonEntryIsUsable(record.field, record);
      });
    }
    if (!v || typeof v !== 'object') return false;
    return Object.entries(v as Record<string, unknown>).every(([field, value]) =>
      dropReasonEntryIsUsable(field, value)
    );
  },
  conflicts: (v) =>
    Array.isArray(v) &&
    v.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      if (typeof record.field !== 'string') return false;
      return record.reason === undefined || typeof record.reason === 'string';
    }),
  fields: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return Object.values(v as Record<string, unknown>).every((entry) => {
      if (entry === null || entry === undefined) return true;
      if (typeof entry !== 'object' || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      // `value` is nullable by contract; `confidence` must be numeric if present.
      if (
        record.value !== undefined &&
        record.value !== null &&
        typeof record.value !== 'string'
      ) {
        return false;
      }
      return record.confidence === undefined || typeof record.confidence === 'number';
    });
  },
  multiplePatientsDetected: (v) => typeof v === 'boolean',
};

/**
 * True when `dropReasons` is longer than the bounded scan, so the parser read
 * only part of it. The row is then not fully classified and the derivation must
 * report classification-incomplete rather than let the surface claim all-clear.
 * (The bound itself stays — an unbounded scan is the thing it protects against.)
 */
function dropReasonsExceedScan(meta: AiExtractedMetadata | null | undefined): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const raw = (meta as { dropReasons?: unknown }).dropReasons;
  if (Array.isArray(raw)) return raw.length > DROP_REASON_SCAN_LIMIT;
  if (raw && typeof raw === 'object') return Object.keys(raw).length > DROP_REASON_SCAN_LIMIT;
  return false;
}

/**
 * Keys where an explicit `null` is NOT interchangeable with omission. A null
 * enum cannot be a valid `MetadataReviewState`, and `review` is the key whose
 * value decides whether the whole blob counts as resolved — so `{ review: null }`
 * slipping through produced no reason while classification stayed complete.
 *
 * The collection keys deliberately still accept `null` as "none": a server that
 * encodes an empty set that way is not corrupt, and failing the whole response
 * over it would take out the feed for every user.
 */
const AI_METADATA_NULL_IS_INVALID: readonly string[] = ['review'];

function aiMetadataShapeIsUsable(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return true;
  const record = meta as Record<string, unknown>;
  for (const [key, isValid] of Object.entries(AI_METADATA_SHAPE)) {
    const value = record[key];
    if (value === undefined) continue;
    if (value === null) {
      if (AI_METADATA_NULL_IS_INVALID.includes(key)) return false;
      continue;
    }
    if (!isValid(value)) return false;
  }
  return true;
}

/**
 * Network-boundary validation: everything `projectAttentionRecording` checks
 * PLUS UUID ids (a malformed id must never be interpolated into navigation) and
 * the server's own field length bounds. A row that fails here makes the whole
 * response malformed — silently dropping it would manufacture a false all-clear.
 */
export function validateAttentionListRow(raw: unknown): AttentionRecording | null {
  const projected = projectAttentionRecording(raw);
  if (!projected) return null;
  if (!UUID_RE.test(projected.id) || !UUID_RE.test(projected.userId)) return null;
  for (const field of Object.keys(ROW_FIELD_MAX_LENGTH) as RecordingMetadataField[]) {
    const value = projected[field];
    if (typeof value === 'string' && value.length > ROW_FIELD_MAX_LENGTH[field]) return null;
  }
  for (const timestamp of [projected.updatedAt, projected.submittedAt]) {
    if (typeof timestamp === 'string' && timestamp.length > MAX_TIMESTAMP_LENGTH) return null;
  }
  // A present-but-corrupt nested AI contract must fail the response rather than
  // be partially discarded behind a "classification complete" claim.
  if (!aiMetadataShapeIsUsable(projected.aiExtractedMetadata)) return null;
  return projected;
}

// ─── Time helpers (rule 11: never hand an invalid Date to Intl) ────────────

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Derivation ────────────────────────────────────────────────────────────

export interface DeriveAttentionOptions {
  nowMs: number;
  /** Gates ONLY the origin-ambiguous `aiExtractedMetadata === null` inference. */
  recordFirstEnabled: boolean;
}

export interface AttentionDerivation {
  items: AttentionFeedItem[];
  /**
   * False when a row could not be fully classified — either a supported
   * time-dependent predicate whose clock input was unusable, or AI metadata the
   * bounded scan could only read part of. Reported SEPARATELY from pagination
   * coverage: a response can be lifetime-complete yet classification-partial.
   */
  classificationComplete: boolean;
  /** Bounded counts of those rows — never their ids or contents. */
  uncheckableTimingRowCount: number;
  uncheckableMetadataRowCount: number;
}

function fieldLabel(field: RecordingMetadataField): string {
  return METADATA_FIELD_LABELS[field];
}

function priorityIndex(code: AttentionReasonCode): number {
  const index = ATTENTION_REASON_PRIORITY.indexOf(code);
  return index === -1 ? ATTENTION_REASON_PRIORITY.length : index;
}

const FIELD_SORT_ORDER: Record<RecordingMetadataField, number> = {
  patientName: 0,
  clientName: 1,
  species: 2,
  breed: 3,
  appointmentType: 4,
};

function compareReasons(a: AttentionReason, b: AttentionReason): number {
  const delta = priorityIndex(a.code) - priorityIndex(b.code);
  if (delta !== 0) return delta;
  const aField = a.field ? FIELD_SORT_ORDER[a.field] : -1;
  const bField = b.field ? FIELD_SORT_ORDER[b.field] : -1;
  return aField - bField;
}

function patientTitle(recording: AttentionRecording): string {
  return displayPatientName({
    patientName: normalizeMetadataValue(recording.patientName, 'patientName'),
  });
}

/**
 * Every normalized AI-metadata reason for a recording, in deterministic
 * priority-then-field order. Shared with `MetadataReviewCard` so the review UI
 * exposes the COMPLETE unresolved set before a whole-review terminal action —
 * confirming a review that hid untouched reasons is what made "the AI is wrong"
 * unfixable in the first place.
 */
export function metadataAttentionReasons(
  recording: MetadataReasonInput,
  opts: { recordFirstEnabled: boolean }
): AttentionReason[] {
  const reasons = collectMetadataReasons(recording as AttentionRecording, opts.recordFirstEnabled);
  return reasons.sort(compareReasons);
}

/** The subset of a row `collectMetadataReasons` actually reads. */
export type MetadataReasonInput = Pick<
  AttentionRecording,
  'patientName' | 'clientName' | 'species' | 'breed' | 'appointmentType' | 'aiExtractedMetadata'
>;

function collectMetadataReasons(
  recording: AttentionRecording,
  recordFirstEnabled: boolean
): AttentionReason[] {
  const signals = computeMetadataAttentionSignals(recording);
  // The server preserves historical dropReasons after a save and only flips
  // `review`. Without this gate every fixed row would be immortal.
  if (signals.resolved) return [];

  const reasons: AttentionReason[] = [];

  if (!signals.hasMetadataObject) {
    // Origin-ambiguous cohort: the list has no durable "this was record-first"
    // field, so only the CURRENT capability can infer it. An explicit blob
    // below never depends on the capability.
    if (recordFirstEnabled && signals.missingDetails) {
      reasons.push({
        code: 'metadata_missing',
        field: null,
        message: ATTENTION_FEED_COPY.missingDetails,
      });
    }
    return reasons;
  }

  const suggestionByField = new Map<RecordingMetadataField, MetadataSuggestion>(
    signals.suggestions.map((suggestion) => [suggestion.field, suggestion])
  );

  // NOTE: `signals.multiplePatients` deliberately raises NO reason. A
  // multi-patient conversation is normal in this practice and the alert was pure
  // noise (2026-07-29 owner decision) — it is not a user-facing attention item on
  // ANY surface. The signal itself is still computed: it suppresses the
  // AI's unreliable per-field suggestions below (see `unclassifiedSuggestionFields`
  // in recordFirstObservability) and still feeds the `multiple_patients_detected`
  // telemetry prop that server-side extraction tuning reads. Do not turn it back
  // into a reason without a new product decision.

  for (const field of signals.conflictFields) {
    const label = fieldLabel(field);
    const current = currentMetadataValue(recording, field);
    const suggested = suggestionByField.get(field)?.value ?? '';
    reasons.push({
      code: 'metadata_conflict',
      field,
      message:
        current && suggested
          ? ATTENTION_FEED_COPY.conflictWithValues(label, current, suggested)
          : ATTENTION_FEED_COPY.conflictGeneric(label),
    });
  }

  if (signals.validAppliedFields.length > 0) {
    reasons.push({
      code: 'metadata_confirm',
      field: null,
      message: ATTENTION_FEED_COPY.confirmWithCount(
        signals.validAppliedFields.length,
        patientTitle(recording)
      ),
    });
  }

  if (signals.missingDetails) {
    reasons.push({
      code: 'metadata_missing',
      field: null,
      message: ATTENTION_FEED_COPY.missingDetails,
    });
  }

  for (const field of signals.lowConfidenceFields) {
    const label = fieldLabel(field);
    const suggested = suggestionByField.get(field)?.value ?? '';
    reasons.push({
      code: 'metadata_low_confidence',
      field,
      message: suggested
        ? ATTENTION_FEED_COPY.lowConfidenceWithValue(label, suggested)
        : ATTENTION_FEED_COPY.lowConfidenceGeneric(label),
    });
  }

  for (const field of signals.notVerbatimFields) {
    reasons.push({
      code: 'metadata_not_verbatim',
      field,
      message:
        field === 'patientName'
          ? ATTENTION_FEED_COPY.notVerbatimPatientName
          : ATTENTION_FEED_COPY.notVerbatimField(fieldLabel(field)),
    });
  }

  for (const field of signals.unclassifiedSuggestionFields) {
    const suggested = suggestionByField.get(field)?.value ?? '';
    if (!suggested) continue;
    reasons.push({
      code: 'metadata_suggestion_unclassified',
      field,
      message: ATTENTION_FEED_COPY.unclassifiedSuggestion(fieldLabel(field), suggested),
    });
  }

  // Fail-safe: an explicit `review: 'unconfirmed'` blob must never vanish just
  // because every detailed legacy field failed normalization.
  //
  // …EXCEPT when multi-patient is the only thing that set it. Connect sets
  // `review: 'unconfirmed'` when `appliedFields.length > 0 || multiplePatientsDetected
  // || hasConflict` (metadata-extraction.ts:409-427), so on the real payload a
  // multi-patient-only recording arrives WITH that flag — and this fallback would
  // resurrect the suppressed alert under a different code, defeating the
  // 2026-07-29 owner decision. We are inside `reasons.length === 0`, so by
  // definition no other supported reason exists to preserve here.
  if (reasons.length === 0 && signals.explicitUnconfirmed && !signals.multiplePatients) {
    reasons.push({
      code: 'metadata_confirm',
      field: null,
      message: ATTENTION_FEED_COPY.confirmFallback,
    });
  }

  return reasons;
}

function normalizedWarnings(recording: AttentionRecording): string[] {
  if (!Array.isArray(recording.qualityWarnings)) return [];
  const out: string[] = [];
  for (const warning of recording.qualityWarnings.slice(0, MAX_QUALITY_WARNINGS_SCANNED)) {
    const text = normalizeDisplayText(warning, QUALITY_WARNING_MAX_LENGTH);
    if (text) out.push(text);
  }
  return out;
}

function actionabilityFor(
  category: AttentionCategory,
  recording: AttentionRecording,
  user: AttentionUser | null | undefined
): boolean {
  if (category === 'processing') {
    // POST /api/recordings/:id/retry is ORG-scoped (owner/admin/veterinarian)
    // and does NOT require authorship — `canEdit` would understate it.
    return canRecordAppointments(user?.role);
  }
  // Metadata mutation is creator-or-owner/admin, enforced server-side; quality
  // resolution flows through the same edit affordances.
  return getRecordingPermissions(user, recording).canEdit;
}

function ctaLabelFor(category: AttentionCategory, actionable: boolean): string | null {
  if (!actionable) return null;
  if (category === 'metadata') return ATTENTION_FEED_COPY.ctaReviewDetails;
  // Neutral "Open" for processing: the list omits audioFileUrl, so only the
  // detail screen can decide Retry vs Audio unavailable.
  return ATTENTION_FEED_COPY.ctaOpenRecording;
}

function focusFor(category: AttentionCategory, actionable: boolean): AttentionFocus | null {
  if (!actionable) return null;
  if (category === 'metadata') return 'metadata';
  if (category === 'quality') return 'quality';
  if (category === 'processing') return 'processing';
  return null;
}

function buildAccessibilityLabel(item: {
  title: string;
  body: string;
  extraIssueCount: number;
  warningCount: number;
  actionable: boolean;
}): string {
  const parts = [item.title, item.body];
  if (item.extraIssueCount > 0) parts.push(ATTENTION_FEED_COPY.moreIssues(item.extraIssueCount));
  if (item.warningCount > 1) parts.push(ATTENTION_FEED_COPY.moreWarnings(item.warningCount - 1));
  if (!item.actionable) parts.push(ATTENTION_FEED_COPY.readOnlyNote);
  return parts.join('. ');
}

/**
 * Derive one row per server recording. A row carries EVERY matching reason and
 * picks one deterministic primary for rank/copy; secondary matches are never
 * discarded (they drive "+N more issues" and the analytics reason set).
 */
export function deriveRecordingAttention(
  recordings: readonly AttentionRecording[],
  user: AttentionUser | null | undefined,
  options: DeriveAttentionOptions
): AttentionDerivation {
  const items: AttentionFeedItem[] = [];
  let uncheckableTimingRowCount = 0;
  let uncheckableMetadataRowCount = 0;

  const source = Array.isArray(recordings) ? recordings : [];
  for (const recording of source) {
    if (!recording || typeof recording !== 'object') continue;

    const reasons: AttentionReason[] = [];
    let timingUncheckable = false;
    let metadataUncheckable = false;
    const updatedAtMs = parseTimestampMs(recording.updatedAt);
    const submittedAtMs = parseTimestampMs(recording.submittedAt);

    if (recording.status === 'failed') {
      // Generic copy only — the raw `errorMessage` is technical/PHI-adjacent
      // and is not even present on this narrow row.
      reasons.push({
        code: 'recording_failed',
        field: null,
        message: ATTENTION_FEED_COPY.recordingFailed,
      });
    } else if (recording.status === 'retry_scheduled') {
      reasons.push({
        code: 'retry_scheduled',
        field: null,
        message: ATTENTION_FEED_COPY.retryScheduled,
      });
    } else if (recording.status === 'completed') {
      // A dropReasons array longer than the bounded scan is only PARTIALLY read,
      // so this row's metadata was not fully classified. `classificationComplete`
      // must say so rather than let a coverage-complete response claim all-clear.
      if (dropReasonsExceedScan(recording.aiExtractedMetadata)) {
        metadataUncheckable = true;
      }
      reasons.push(...collectMetadataReasons(recording, options.recordFirstEnabled));

      const warnings = normalizedWarnings(recording);
      // A truncated array whose scanned window yielded NOTHING usable cannot be
      // called clean: a real warning may sit in the unscanned tail. Report the
      // row as partially classified instead of silently emitting no item.
      if (warnings.length === 0 && recording.qualityWarningsTruncated === true) {
        metadataUncheckable = true;
      }
      if (warnings.length > 0) {
        if (submittedAtMs === null || submittedAtMs > options.nowMs) {
          timingUncheckable = true;
        } else if (options.nowMs - submittedAtMs <= QUALITY_WARNING_MAX_AGE_MS) {
          reasons.push({
            code: 'quality_warning',
            field: null,
            message: warnings[0],
            // The SERVER's total when it is known, so "+N more warnings" does not
            // under-report a list longer than the scan window.
            warningCount: Math.max(
              warnings.length,
              typeof recording.qualityWarningsTotal === 'number'
                ? recording.qualityWarningsTotal
                : 0
            ),
          });
        }
      }
    } else if (recording.status !== 'draft' && recording.status !== 'pending_metadata') {
      // `pending_metadata` is deliberately NOT surfaced: mobile has only a
      // static "Awaiting Details" card, not Connect's completion workflow.
      const staleness = getProcessingStaleness({
        status: recording.status,
        updatedAtMs,
        nowMs: options.nowMs,
        audioAvailability: 'unknown',
      });
      if (staleness === 'unknown_timing') {
        timingUncheckable = true;
      } else if (staleness === 'stale') {
        reasons.push({
          code: 'stuck_processing',
          field: null,
          message: ATTENTION_FEED_COPY.stuckProcessing,
        });
      }
    }

    if (timingUncheckable) uncheckableTimingRowCount += 1;
    if (metadataUncheckable) uncheckableMetadataRowCount += 1;
    if (reasons.length === 0) continue;

    reasons.sort(compareReasons);
    const primary = reasons[0];
    const category = ATTENTION_CATEGORY_BY_REASON[primary.code];
    const actionable = actionabilityFor(category, recording, user);
    const warningCount = reasons.find((r) => r.code === 'quality_warning')?.warningCount ?? 0;
    const title = patientTitle(recording);
    const extraIssueCount = reasons.length - 1;

    items.push({
      key: `recording:${recording.id}`,
      recordingId: recording.id,
      title,
      body: primary.message,
      category,
      primaryReason: primary.code,
      primaryField: primary.field,
      reasons,
      extraIssueCount,
      warningCount,
      actionable,
      destination: {
        kind: 'recording_detail',
        recordingId: recording.id,
        focus: focusFor(category, actionable),
      },
      ctaLabel: ctaLabelFor(category, actionable),
      accessibilityLabel: buildAccessibilityLabel({
        title,
        body: primary.message,
        extraIssueCount,
        warningCount,
        actionable,
      }),
      submittedAtMs,
      updatedAtMs,
    });
  }

  return {
    items,
    // Completeness now covers BOTH kinds of unclassifiable row: an unusable clock
    // input and metadata that could only be partially scanned.
    classificationComplete: uncheckableTimingRowCount === 0 && uncheckableMetadataRowCount === 0,
    uncheckableTimingRowCount,
    uncheckableMetadataRowCount,
  };
}

// ─── Device-local synthetic rows ───────────────────────────────────────────

export interface UnsentWorkSummary {
  draftCount: number;
  stashSessionCount: number;
  /** False when the source could not be READ — never a false zero. */
  draftsKnown: boolean;
  stashesKnown: boolean;
}

export const UNKNOWN_UNSENT_WORK_SUMMARY: UnsentWorkSummary = {
  draftCount: 0,
  stashSessionCount: 0,
  draftsKnown: false,
  stashesKnown: false,
};

export function isUnsentWorkSummaryKnown(summary: UnsentWorkSummary | null | undefined): boolean {
  return !!summary && summary.draftsKnown && summary.stashesKnown;
}

/**
 * Two SOURCE-LEVEL summary rows (not recording rows): drafts route to the
 * Recordings screen (drafts merge into that list) and saved sessions route to
 * the Record tab (where Resume lives).
 *
 * Support staff are the deliberate exception to "actionable means this role can
 * submit": they may still own user-scoped bytes from before a role change, so
 * the data-loss warning stays in "Needs you" — but its CTA is recovery, never
 * Resume/Submit.
 */
export function buildLocalAttentionItems(
  summary: UnsentWorkSummary | null | undefined,
  user: AttentionUser | null | undefined
): AttentionFeedItem[] {
  if (!summary || !user?.id) return [];
  const canSubmit = canRecordAppointments(user.role);
  const items: AttentionFeedItem[] = [];

  const push = (
    code: 'local_drafts' | 'local_saved_sessions',
    title: string,
    message: string,
    submitDestination: AttentionDestination,
    submitCta: string
  ) => {
    const body = canSubmit
      ? message
      : `${message} ${ATTENTION_FEED_COPY.localSupportStaffNote}`;
    const reason: AttentionReason = { code, field: null, message: body };
    items.push({
      key: `local:${user.id}:${code}`,
      recordingId: null,
      title,
      body,
      category: 'local',
      primaryReason: code,
      primaryField: null,
      reasons: [reason],
      extraIssueCount: 0,
      warningCount: 0,
      actionable: true,
      // Support staff get NO link. `/recording-recovery` is gated on
      // `canRecordAppointments`, so it renders "Recovery Not Available" for
      // exactly this cohort, and their current work is not in the owner/admin/vet
      // vault until the sign-out preservation flow runs — so any destination here
      // is a dead end. The row keeps its place in "Needs you" (it is a data-loss
      // warning) and `localSupportStaffNote` in the body says who can act.
      destination: canSubmit ? submitDestination : { kind: 'informational' },
      ctaLabel: canSubmit ? submitCta : null,
      accessibilityLabel: buildAccessibilityLabel({
        title,
        body,
        extraIssueCount: 0,
        warningCount: 0,
        actionable: true,
      }),
      submittedAtMs: null,
      updatedAtMs: null,
    });
  };

  if (summary.draftsKnown && summary.draftCount > 0) {
    push(
      'local_drafts',
      ATTENTION_FEED_COPY.localDraftsTitle,
      ATTENTION_FEED_COPY.localDrafts(summary.draftCount),
      { kind: 'recordings_list' },
      ATTENTION_FEED_COPY.ctaOpenDrafts
    );
  }
  if (summary.stashesKnown && summary.stashSessionCount > 0) {
    push(
      'local_saved_sessions',
      ATTENTION_FEED_COPY.localSavedSessionsTitle,
      ATTENTION_FEED_COPY.localSavedSessions(summary.stashSessionCount),
      { kind: 'record_tab' },
      ATTENTION_FEED_COPY.ctaOpenSavedSessions
    );
  }
  return items;
}

// ─── Ordering + grouping ───────────────────────────────────────────────────

function compareTimestampDesc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  // Valid timestamps sort ahead of invalid/absent ones; two invalids tie.
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Deterministic within-group ordering: reason priority, then submittedAt desc,
 * then updatedAt desc, then key ascending. Independent of input order.
 */
export function compareAttentionItems(a: AttentionFeedItem, b: AttentionFeedItem): number {
  const byPriority = priorityIndex(a.primaryReason) - priorityIndex(b.primaryReason);
  if (byPriority !== 0) return byPriority;
  const bySubmitted = compareTimestampDesc(a.submittedAtMs, b.submittedAtMs);
  if (bySubmitted !== 0) return bySubmitted;
  const byUpdated = compareTimestampDesc(a.updatedAtMs, b.updatedAtMs);
  if (byUpdated !== 0) return byUpdated;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

export interface AttentionGroups {
  needsYou: AttentionFeedItem[];
  acrossPractice: AttentionFeedItem[];
}

/** Split by per-kind actionability — never FILTER practice-wide rows away. */
export function groupAttentionItems(items: readonly AttentionFeedItem[]): AttentionGroups {
  const needsYou: AttentionFeedItem[] = [];
  const acrossPractice: AttentionFeedItem[] = [];
  for (const item of items) {
    (item.actionable ? needsYou : acrossPractice).push(item);
  }
  needsYou.sort(compareAttentionItems);
  acrossPractice.sort(compareAttentionItems);
  return { needsYou, acrossPractice };
}

/** Closed-vocabulary top reason for analytics; `'none'` when there is no row. */
export function topReasonCode(items: readonly AttentionFeedItem[]): AttentionReasonCode | 'none' {
  let best: AttentionFeedItem | null = null;
  for (const item of items) {
    if (!best || compareAttentionItems(item, best) < 0) best = item;
  }
  return best ? best.primaryReason : 'none';
}

/** True when any raw row's source state can still change server-side. */
export function hasPollableAttentionRow(
  recordings: readonly AttentionRecording[] | null | undefined
): boolean {
  if (!Array.isArray(recordings)) return false;
  return recordings.some((recording) =>
    POLLABLE_ATTENTION_STATUSES.includes(recording?.status)
  );
}

/**
 * True when a local clock tick alone could change classification: a pollable
 * processing row (5/20/35-minute thresholds) or a completed row whose quality
 * warning is currently unexpired — including a parseable FUTURE timestamp,
 * which device clock skew can turn into a current one.
 */
export function hasPendingTimingBoundary(
  recordings: readonly AttentionRecording[] | null | undefined,
  nowMs: number
): boolean {
  if (!Array.isArray(recordings)) return false;
  return recordings.some((recording) => {
    if (!recording) return false;
    if (POLLABLE_ATTENTION_STATUSES.includes(recording.status)) return true;
    if (recording.status !== 'completed') return false;
    if (normalizedWarnings(recording).length === 0) return false;
    const submittedAtMs = parseTimestampMs(recording.submittedAt);
    if (submittedAtMs === null) return false;
    if (submittedAtMs > nowMs) return true;
    return nowMs - submittedAtMs <= QUALITY_WARNING_MAX_AGE_MS;
  });
}

// ─── Bounded server page: envelope contract ────────────────────────────────

/** `ListRecordingsQuerySchema` caps `limit` at 100 (recording.schema.ts). */
export const ATTENTION_PAGE_LIMIT = 100;
export const ATTENTION_PAGE_NUMBER = 1;

export interface AttentionPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * What is stored under the attention query key: a validated PAGINATED envelope
 * whose rows are projected `AttentionRecording`s. Keeping the envelope (rather
 * than derived items or a server/local combined view) preserves the shape the
 * recording cache merge/remove helpers expect, without retaining the list's raw
 * failure fields.
 */
export interface AttentionEnvelope {
  data: AttentionRecording[];
  /** `null` when the server sent no pagination proof at all → unknown coverage. */
  pagination: AttentionPagination | null;
}

export class MalformedAttentionResponseError extends Error {
  readonly code = 'ATTENTION_RESPONSE_MALFORMED';
  constructor() {
    // Generic by construction: the payload is never logged, reported, or shown.
    super('Could not read the recordings response.');
    this.name = 'MalformedAttentionResponseError';
  }
}

function parsePagination(
  raw: unknown,
  opts: { page: number; limit: number }
): AttentionPagination | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pagination = raw as Record<string, unknown>;
  const { page, limit, total, totalPages } = pagination;
  const allNumbers = [page, limit, total, totalPages].every(
    (value) => typeof value === 'number' && Number.isFinite(value)
  );
  // No usable proof at all — coverage is unknown, but the response is not
  // malformed (an older server may simply omit it).
  if (!allNumbers) return null;

  const p = page as number;
  const l = limit as number;
  const t = total as number;
  const tp = totalPages as number;
  if (!Number.isInteger(t) || t < 0) throw new MalformedAttentionResponseError();
  if (p !== opts.page || l !== opts.limit) throw new MalformedAttentionResponseError();
  if (!Number.isInteger(tp) || tp < 0) throw new MalformedAttentionResponseError();
  const expected = Math.ceil(t / l);
  // A zero-total page is reported as 0 or 1 pages by different server versions;
  // anything else is an inconsistent proof.
  const acceptable = t === 0 ? tp === 0 || tp === 1 : tp === expected;
  if (!acceptable) throw new MalformedAttentionResponseError();

  return { page: p, limit: l, total: t, totalPages: tp };
}

/**
 * Validate the unparsed list envelope BEFORE it reaches the pure builder. A
 * structurally invalid or duplicate row, an over-cap page, or an inconsistent
 * pagination proof makes the whole response malformed — silently dropping rows
 * would manufacture a false all-clear.
 *
 * Throws only `MalformedAttentionResponseError`, whose message is generic: the
 * payload is never logged or reported.
 */
export function parseAttentionEnvelope(
  raw: unknown,
  opts: { page: number; limit: number } = {
    page: ATTENTION_PAGE_NUMBER,
    limit: ATTENTION_PAGE_LIMIT,
  }
): AttentionEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedAttentionResponseError();
  }
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.data)) throw new MalformedAttentionResponseError();
  if (body.data.length > opts.limit) throw new MalformedAttentionResponseError();

  const seen = new Set<string>();
  const data: AttentionRecording[] = [];
  for (const row of body.data) {
    const validated = validateAttentionListRow(row);
    if (!validated) throw new MalformedAttentionResponseError();
    if (seen.has(validated.id)) throw new MalformedAttentionResponseError();
    seen.add(validated.id);
    data.push(validated);
  }

  const pagination = parsePagination(body.pagination, opts);
  // Cross-check the two halves. Validated independently, a page of N rows
  // reporting `total < N` (e.g. five rows with `total: 0`) would satisfy both —
  // and `attentionCoverage()` would then call it COMPLETE, letting the surface
  // make its one positive all-clear claim off a self-contradictory proof.
  if (pagination && pagination.total < data.length) throw new MalformedAttentionResponseError();

  return { data, pagination };
}

export type AttentionCoverage = 'complete' | 'recent_page_only' | 'unknown';

/**
 * Pagination coverage of the bounded page. NOTE: the endpoint's `total` counts
 * the organization's lifetime non-draft rows with no attention/date filter, so
 * once an org passes 100 rows this client-only v1 is permanently a RECENTLY
 * UPDATED SNAPSHOT — never an exhaustive backlog. That is why the surface has
 * no authoritative badge and never says "View all".
 */
export function attentionCoverage(envelope: AttentionEnvelope | null | undefined): AttentionCoverage {
  if (!envelope) return 'unknown';
  if (!envelope.pagination) return 'unknown';
  return envelope.pagination.total <= envelope.data.length ? 'complete' : 'recent_page_only';
}

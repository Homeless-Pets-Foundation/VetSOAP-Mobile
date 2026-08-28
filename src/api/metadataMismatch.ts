/**
 * Pure metadata-comparison helpers for the upload path, extracted from
 * recordings.ts so they can be unit-tested functionally (see
 * tests/patch-draft-mismatch.test.mjs) rather than through the vm harness that
 * has to mock expo-file-system. Mirrors the ./uploadRetry precedent.
 *
 * The comparison itself is unchanged from the version that lived in
 * recordings.ts — `recordingMatchesMetadataPayload` is kept as the exact
 * negation of `findMetadataMismatches`, so the extraction is provably
 * behavior-preserving.
 *
 * What is NEW is that a failure can now describe itself. A `patch_draft`
 * failure previously reached telemetry as the bare phase name with no
 * indication of which field disagreed or which call site raised it, because
 * `phaseError` mints an error with no `.code` and no `.status` (it sets
 * `httpStatus`), so record.tsx's errorCode derivation always collapsed to the
 * literal 'PATCH_DRAFT'.
 *
 * PHI SAFETY IS STRUCTURAL HERE, NOT BY CONVENTION. The formatter is handed
 * `{key, kind}` pairs and is never given a metadata VALUE, so it cannot echo a
 * patient or client name even by mistake. Keys are additionally checked
 * against REPORTABLE_METADATA_KEYS and anything outside that allowlist is
 * reported as 'other', so a future payload field holding PHI cannot leak by
 * omission.
 */

/** Structural shape of a server recording — only what the comparison reads. */
export type RecordingLike = Record<string, unknown>;

export type RecordingPayload = Record<string, string | boolean | null>;

export interface MetadataMatchOptions {
  allowServerEnrichedBlankFields?: boolean;
  pimsPatientIdExplicitlyCleared?: boolean;
}

/**
 * Which of the seven assertion call sites raised the mismatch. This is the
 * difference between "the assertion ran after a genuinely successful
 * confirm-upload" and "the assertion ran on an idempotent replay", which the
 * telemetry previously could not distinguish at all.
 */
export type MetadataAssertionOrigin =
  | 'prepare_already_uploaded'
  | 'confirm'
  | 'confirm_409_probe'
  | 'recovery_restart'
  | 'recovery_inspect'
  | 'confirm_api'
  | 'confirm_api_409_probe';

/**
 * `absent` = the server response did not carry the key at all.
 * `differs` = the key was present with a different value.
 *
 * The distinction is load-bearing, not cosmetic: the server's recording
 * serializer emits the flat `pimsPatientId` alias ONLY when the Prisma
 * `patient` relation was loaded, so an absent key means "this route did not
 * include the relation", which is a completely different diagnosis from "the
 * value disagrees".
 */
export type MetadataMismatchKind = 'absent' | 'differs';

export interface MetadataMismatchDetail {
  key: string;
  kind: MetadataMismatchKind;
}

export const SERVER_ENRICHABLE_BLANK_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
  'pimsPatientId',
]);

/**
 * Field names safe to emit in telemetry. These are schema identifiers, not
 * user content. Anything not listed is reported as 'other'.
 */
export const REPORTABLE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
  'templateId',
  'foreignLanguage',
  'pimsPatientId',
]);

/**
 * One new, stable errorCode. Deliberately NOT parameterized by field: this
 * value is simultaneously the reportClientError rate-limiter sub-key (cap
 * 5/60s), the Sentry grouping key, and a Sentry tag. rateLimitMonitoring
 * requires channel keys stay coarse, and a per-field code would both defeat
 * the limiter and shatter one Sentry issue into hundreds.
 */
export const METADATA_MISMATCH_ERROR_CODE = 'PATCH_DRAFT_METADATA_MISMATCH';

/** Bounds the emitted field list; the payload has 8 keys, so this is a backstop. */
export const MAX_REPORTED_MISMATCH_FIELDS = 8;

/** Hard cap on the diagnostic string, well inside the server's 512-char message column. */
export const MAX_DIAGNOSTIC_LENGTH = 200;

/**
 * Every mismatched key between a server recording and the metadata payload the
 * client submitted. Empty array means they agree.
 */
export function findMetadataMismatches(
  recording: RecordingLike,
  payload: RecordingPayload,
  opts: MetadataMatchOptions = {}
): MetadataMismatchDetail[] {
  const recordingData = recording as Record<string, unknown>;
  const mismatches: MetadataMismatchDetail[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!Object.prototype.hasOwnProperty.call(recordingData, key)) {
      mismatches.push({ key, kind: 'absent' });
      continue;
    }
    const recordingValue = recordingData[key] ?? null;
    if (
      opts.allowServerEnrichedBlankFields &&
      SERVER_ENRICHABLE_BLANK_METADATA_FIELDS.has(key) &&
      !(key === 'pimsPatientId' && opts.pimsPatientIdExplicitlyCleared) &&
      (value === null || value === '') &&
      recordingValue !== null &&
      recordingValue !== ''
    ) {
      continue;
    }
    if (recordingValue !== value) mismatches.push({ key, kind: 'differs' });
  }
  return mismatches;
}

/**
 * Retained as the exact negation of findMetadataMismatches so the extraction
 * from recordings.ts is verifiably behavior-preserving.
 */
export function recordingMatchesMetadataPayload(
  recording: RecordingLike,
  payload: RecordingPayload,
  opts: MetadataMatchOptions = {}
): boolean {
  return findMetadataMismatches(recording, payload, opts).length === 0;
}

/**
 * A PHI-free, low-cardinality description of the failure, destined for the
 * telemetry `message` field (which record.tsx owns and which the server
 * persists verbatim up to 512 chars).
 *
 * Emits NO '/' character. The server's looksLikePHI check is all-or-nothing:
 * one path-like substring replaces the ENTIRE message, which would destroy the
 * diagnosis along with it.
 */
export function formatMetadataMismatchDiagnostic(
  origin: MetadataAssertionOrigin,
  mismatches: readonly MetadataMismatchDetail[]
): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const mismatch of mismatches) {
    const key = REPORTABLE_METADATA_KEYS.has(mismatch.key) ? mismatch.key : 'other';
    const token = `${key}:${mismatch.kind}`;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  tokens.sort();
  const shown = tokens.slice(0, MAX_REPORTED_MISMATCH_FIELDS);
  return `metadata_mismatch origin=${origin} fields=${shown.join(',')}`.slice(
    0,
    MAX_DIAGNOSTIC_LENGTH
  );
}

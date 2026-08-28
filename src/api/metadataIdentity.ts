/**
 * Two-tier metadata identity rules for the upload path.
 *
 * WHY THIS EXISTS
 *
 * `assertRecordingMatchesMetadataPayload` used to fail a submit whenever the
 * server-returned recording disagreed with the metadata snapshot the client
 * sent — including on the HAPPY path, immediately after a successful
 * confirm-upload. At that point the bytes are in R2, the server has written our
 * snapshot, and it has already enqueued processing. Throwing there prevents
 * nothing; it converts a completed recording into a permanently stuck local
 * draft and tells the vet to "try submitting again" on a submit that worked.
 *
 * The guard's real job is narrower than it looked. It is a LOCAL-DELETION GATE
 * on the adopt path (`already_uploaded` / `already_processed`), where the client
 * uploaded nothing this attempt, is being told its audio is already on the
 * server, and is about to delete the local copy. See
 * docs/stale-recording-upload-404-prevention-plan-2026-07-13.md: "verify
 * returned canonical metadata matches the submitted snapshot ... before
 * treating it as a local-deletion signal."
 *
 * So the first cut is not WHICH FIELD, it is WHICH CALL SITE. The second cut is
 * the tiering below.
 */

import type { MetadataMatchOptions, RecordingPayload } from './metadataMismatch';

/**
 * Whether an assertion site is the LOCAL-DELETION GATE.
 *
 * Deliberately distinct from `isReplayMetadataOrigin`, which answers a
 * different question (is this failure genuinely recovered, for severity?). The
 * two axes do not coincide: a 409 confirm probe is an idempotent replay for
 * severity purposes, but it is still a COMMIT site — it GETs the row named in
 * the request URL, so the row's identity is proven by the id, not by metadata.
 *
 * Only the adopt sites are told "your audio is already on the server" about a
 * row they did not just name in a confirm URL, and only they go on to delete
 * the local copy. Those are the ones where metadata is the last cross-check.
 */
export function isAdoptMetadataOrigin(origin: string): boolean {
  return (
    origin === 'prepare_already_uploaded' ||
    origin === 'recovery_restart' ||
    origin === 'recovery_inspect'
  );
}

export type MetadataTier = 'identity' | 'processing' | 'descriptive';

/**
 * IDENTITY fields decide WHICH PATIENT a recording is filed under. A wrong
 * value here is a clinical error, so they still fail closed on the adopt path.
 *
 * PROCESSING fields change how the note is produced but cannot mis-attribute
 * it, and both are repairable in-app (regenerate SOAP / reprocess). Blocking
 * the submit cannot prevent the wrong outcome anyway — by the time these
 * checks run the processing job is already enqueued.
 *
 * DESCRIPTIVE fields were verified against the server's patient resolution:
 * species, breed, and appointmentType appear in NO lookup key, NO upsert
 * `where` clause, and NO identity guard. They are only ever written into blank
 * profile fields, so they cannot cause a mis-link under any path.
 *
 * `patientId` is deliberately absent: it is a server-derived surrogate the
 * client has no authority over, and comparing it would recreate exactly the
 * false-failure class this tiering removes.
 */
export const METADATA_FIELD_TIERS: Readonly<Record<string, MetadataTier>> = {
  patientName: 'identity',
  clientName: 'identity',
  pimsPatientId: 'identity',
  templateId: 'processing',
  foreignLanguage: 'processing',
  species: 'descriptive',
  breed: 'descriptive',
  appointmentType: 'descriptive',
};

/** Text fields compared case-insensitively, mirroring the server's lookups. */
const CASE_INSENSITIVE_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'patientName',
  'clientName',
]);

export interface MetadataComparison {
  identityFields: readonly string[];
  processingFields: readonly string[];
  descriptiveFields: readonly string[];
  /** Keys the server did not return at all. Never blocking — see below. */
  unknownFields: readonly string[];
}

export interface MetadataDivergenceReport {
  /** Highest tier present, for choosing how loudly to surface it. */
  tier: MetadataTier;
  fields: readonly string[];
  comparison: MetadataComparison;
}

/**
 * Collapses every representation of "empty" to one sentinel.
 *
 * This alone removes a whole class of false failures: a row written by an older
 * client or by the web app stores `''` where the mobile payload sends `null`.
 * The server's own `normalizePatientText` treats those as equal; the client
 * used raw `!==` and threw.
 */
function normalizeBlank(value: unknown): string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return value as string | boolean | null;
}

function valuesAgree(key: string, submitted: unknown, returned: unknown): boolean {
  const a = normalizeBlank(submitted);
  const b = normalizeBlank(returned);
  if (key === 'foreignLanguage') return (a ?? false) === (b ?? false);
  if (
    CASE_INSENSITIVE_IDENTITY_FIELDS.has(key) &&
    typeof a === 'string' &&
    typeof b === 'string'
  ) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Whether a pimsPatientId difference is identity-bearing.
 *
 * Directional on purpose:
 *  - submitted non-blank and the server returned a DIFFERENT non-blank value —
 *    identity. This could mean the visit is filed against the wrong PIMS chart,
 *    which is silent and propagates into patient history.
 *  - the user EXPLICITLY cleared it and the server returned a value — identity
 *    too, because the client cannot tell "the server declined the clear" from
 *    "this is a different visit" without asking a human.
 *  - blank, untouched, and the server filled it in — ordinary enrichment, not
 *    divergence at all.
 */
function pimsDivergenceTier(
  submitted: unknown,
  returned: unknown,
  opts: MetadataMatchOptions
): MetadataTier | null {
  const a = normalizeBlank(submitted);
  const b = normalizeBlank(returned);
  if (a === b) return null;
  if (a === null) {
    // Server supplied a value we did not send.
    if (opts.pimsPatientIdExplicitlyCleared) return 'identity';
    return opts.allowServerEnrichedBlankFields ? null : 'descriptive';
  }
  return 'identity';
}

/**
 * The absent-key tolerance exists for exactly one reason: the server emits the
 * flat `pimsPatientId` alias only when the Prisma `patient` relation was
 * loaded, so a route that omits the relation returns no key at all. That is a
 * serializer shape, not evidence about the patient.
 *
 * It must NOT generalize to the identity ANCHORS. If an adopt response omits
 * `patientName` or `clientName`, we cannot verify which patient the row belongs
 * to — and the adopt path is about to delete the only local copy. Absence there
 * has to block, or a serializer regression would silently authorize deletion
 * against an unverified row.
 */
const ABSENCE_TOLERATED_FIELDS: ReadonlySet<string> = new Set(['pimsPatientId']);

/**
 * Compare a server recording against the metadata snapshot the client sent,
 * bucketed by tier.
 */
export function compareRecordingMetadata(
  recording: Record<string, unknown>,
  payload: RecordingPayload,
  opts: MetadataMatchOptions = {}
): MetadataComparison {
  const identityFields: string[] = [];
  const processingFields: string[] = [];
  const descriptiveFields: string[] = [];
  const unknownFields: string[] = [];
  // Computed once, before the loop: the absent-key branch needs it too.
  const anchorUsable = pimsAnchorUsable(recording, payload);

  for (const [key, submitted] of Object.entries(payload)) {
    if (!Object.prototype.hasOwnProperty.call(recording, key)) {
      unknownFields.push(key);
      // A missing identity anchor is unverifiable, not benign.
      if (METADATA_FIELD_TIERS[key] === 'identity' && !ABSENCE_TOLERATED_FIELDS.has(key)) {
        identityFields.push(key);
      }
      // At the adopt deletion gate with no usable PIMS anchor, an ABSENT
      // species/breed is no safer than a differing one: it is the remaining
      // evidence about which of two same-named charts this is, and a response
      // that simply omits it would otherwise slip past the promotion below
      // (absent keys never reach descriptiveFields at all) and authorize
      // deleting the only local copy. Only a value we actually sent can be
      // missing in this sense — a blank we never sent proves nothing.
      if (
        opts.adoptDeletionGate &&
        normalizeBlank(submitted) !== null &&
        (VISIT_DISAMBIGUATORS.includes(key) ||
          (!anchorUsable && PROFILE_DISAMBIGUATORS.includes(key)))
      ) {
        identityFields.push(key);
      }
      continue;
    }
    const returned = recording[key] ?? null;

    if (key === 'pimsPatientId') {
      const tier = pimsDivergenceTier(submitted, returned, opts);
      if (tier === 'identity') identityFields.push(key);
      else if (tier === 'descriptive') descriptiveFields.push(key);
      continue;
    }

    if (valuesAgree(key, submitted, returned)) continue;

    // A blank we sent that the server filled in is enrichment, not divergence.
    if (
      opts.allowServerEnrichedBlankFields &&
      normalizeBlank(submitted) === null &&
      normalizeBlank(returned) !== null &&
      METADATA_FIELD_TIERS[key] !== 'processing'
    ) {
      continue;
    }

    const tier = METADATA_FIELD_TIERS[key];
    if (tier === 'identity') identityFields.push(key);
    else if (tier === 'processing') processingFields.push(key);
    else if (tier === 'descriptive') descriptiveFields.push(key);
    // A key with no tier is not something we know how to judge; ignore it
    // rather than inventing a blocking reason from an unknown field.
  }

  // On an ADOPT response the comparison decides whether the client may delete
  // its only copy of the audio, and the tiering above assumes a stronger anchor
  // settled WHICH patient the row is. When `pimsPatientId` is blank on both
  // sides, name equality is all that remains — and two charts in one practice
  // can share a patient and client name ("Bella" / "Smith"). A different
  // species or breed is then the only remaining evidence that the server picked
  // the other chart, so it has to block here even though it stays descriptive
  // everywhere else (it participates in no lookup key and cannot itself cause a
  // mis-link).
  if (opts.adoptDeletionGate) {
    // The visit discriminator blocks unconditionally; the patient ones only
    // when nothing stronger settled which chart this is.
    const promote = anchorUsable
      ? VISIT_DISAMBIGUATORS
      : [...VISIT_DISAMBIGUATORS, ...PROFILE_DISAMBIGUATORS];
    for (const field of promote) {
      if (descriptiveFields.includes(field)) identityFields.push(field);
    }
  }

  return { identityFields, processingFields, descriptiveFields, unknownFields };
}

/** Fields that only disambiguate a PATIENT when no stronger anchor can. */
const PROFILE_DISAMBIGUATORS: readonly string[] = ['species', 'breed'];

/**
 * The one VISIT-level discriminator in the payload.
 *
 * `patientName`, `clientName` and `pimsPatientId` identify the patient, not the
 * appointment — so when a stale upload intent resolves to a DIFFERENT visit for
 * the SAME patient, all three match and none of them notices. A Sick Visit
 * followed by a Follow-up is the everyday version of this. At the adopt gate,
 * where the client is about to delete the new visit's only local audio,
 * `appointmentType` is the last thing that can say the row is the wrong visit,
 * so it blocks there regardless of whether the patient anchor is usable. It
 * stays descriptive everywhere else, where it genuinely cannot cause a mis-link
 * (it appears in no lookup key, no upsert `where`, and no identity guard).
 */
const VISIT_DISAMBIGUATORS: readonly string[] = ['appointmentType'];

/**
 * True when `pimsPatientId` actually identifies the patient on BOTH sides. An
 * absent key counts as unusable, not as agreement: the server omits the flat
 * alias whenever the Prisma `patient` relation was not loaded.
 */
function pimsAnchorUsable(
  recording: Record<string, unknown>,
  payload: RecordingPayload
): boolean {
  const submitted = normalizeBlank((payload as Record<string, unknown>).pimsPatientId ?? null);
  if (submitted === null) return false;
  if (!Object.prototype.hasOwnProperty.call(recording, 'pimsPatientId')) return false;
  return normalizeBlank(recording.pimsPatientId ?? null) !== null;
}

export function hasIdentityDivergence(comparison: MetadataComparison): boolean {
  return comparison.identityFields.length > 0;
}

export function hasAnyDivergence(comparison: MetadataComparison): boolean {
  return (
    comparison.identityFields.length > 0 ||
    comparison.processingFields.length > 0 ||
    comparison.descriptiveFields.length > 0
  );
}

/** Highest tier present, or null when nothing diverged. */
export function divergenceTier(comparison: MetadataComparison): MetadataTier | null {
  if (comparison.identityFields.length > 0) return 'identity';
  if (comparison.processingFields.length > 0) return 'processing';
  if (comparison.descriptiveFields.length > 0) return 'descriptive';
  return null;
}

export function buildDivergenceReport(
  comparison: MetadataComparison
): MetadataDivergenceReport | null {
  const tier = divergenceTier(comparison);
  if (!tier) return null;
  const fields = [
    ...comparison.identityFields,
    ...comparison.processingFields,
    ...comparison.descriptiveFields,
  ];
  return { tier, fields, comparison };
}

/**
 * Typed, actionable replacement for the generic tagged failure.
 *
 * Two different things produce it, and both must reach the same reconcile
 * surface: the client-side adopt guard, and the SERVER's own
 * `409 RECORDING_METADATA_CONFLICT` from prepare-upload / confirm-upload, which
 * previously fell through into a generic `prepare`-phase error. Fixing only the
 * client assertion would leave the retry dead-ending on the server.
 *
 * `uploadPhase` stays 'patch_draft' so existing phase-based routing, telemetry,
 * and guard tests keep working.
 */
export class RecordingMetadataConflictError extends Error {
  readonly code = 'RECORDING_METADATA_CONFLICT';
  readonly uploadPhase = 'patch_draft' as const;
  readonly recordingId: string;
  readonly divergentFields: readonly string[];
  readonly source: 'client_adopt_guard' | 'server_conflict';

  constructor(
    recordingId: string,
    divergentFields: readonly string[],
    source: 'client_adopt_guard' | 'server_conflict',
    message: string
  ) {
    super(message);
    this.name = 'RecordingMetadataConflictError';
    this.recordingId = recordingId;
    this.divergentFields = divergentFields;
    this.source = source;
  }
}

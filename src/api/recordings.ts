import {
  getInfoAsync,
  createUploadTask,
  FileSystemUploadType,
} from 'expo-file-system/legacy';
import { apiClient, ApiError } from './client';
import type {
  Recording,
  CreateRecording,
  PaginatedResponse,
  UploadUrlResponse,
  RecordingStatus,
  SoapNote,
  UpdateRecordingMetadata,
  ReviewStatus,
  RecordingTask,
  OrgAiModels,
} from '../types';
import {
  recordingIdSchema,
  recordingTaskIdSchema,
  createRecordingSchema,
  searchQuerySchema,
} from '../lib/validation';
import { normalizeOrgAiModels } from '../lib/aiModels';
import { validateUploadUrl } from '../lib/sslPinning';
import { unwrapTaskList } from '../lib/recordingTasks';
import { getIdempotencyUuid } from '../lib/random';
import type { PendingConfirm, PendingConfirmFile, PendingConfirmMetadata } from '../types/multiPatient';
import { validatePendingConfirm } from '../lib/pendingConfirm';
import { trackEvent } from '../lib/analytics';
import { breadcrumb } from '../lib/monitoring';
import { waitForNetworkOnline } from '../lib/networkWait';
import { STALE_RECORDING_UPLOAD_COPY } from '../constants/strings';
import {
  validatePreparedUploadEnvelope,
  validateUploadIntentConflictDetails,
  validateUploadIntentRecoveryEnvelope,
  type PrepareUploadResponse,
  type UploadIntentConflictDetails,
  type UploadIntentRecoveryResponse,
} from './uploadPreparation';
import {
  tagPhase,
  phaseError,
  isTransientUploadError,
  isStalePresignError,
  uploadTimeoutMs,
  runWithConcurrency,
  type TaggedError,
} from './uploadRetry';
import { isPimsPatientIdExplicitlyCleared } from '../lib/pimsPatientIdIntent';
import {
  draftPresenceRequestSchema,
  parseDraftPresenceResponse,
  type DraftPresenceResponse,
} from './draftPresenceContract';

const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024; // 250 MB
const GENERATIVE_REQUEST_TIMEOUT_MS = 90_000;
const PENDING_CONFIRM_PERSIST_TIMEOUT_MS = 3_000;
const RECORDING_ANCHOR_PERSIST_TIMEOUT_MS = 3_000;

export const RECORDING_AUDIO_MISSING_CODE = 'RECORDING_AUDIO_MISSING' as const;

export function isRecordingAudioMissingError(
  error: unknown,
): error is ApiError & { code: typeof RECORDING_AUDIO_MISSING_CODE } {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === RECORDING_AUDIO_MISSING_CODE
  );
}

export type RecordingDeleteReason =
  | 'user_delete'
  | 'discard_session'
  | 'remove_slot'
  | 'orphan_pending_confirm'
  | 'missing_audio_rerecord'
  | 'orphan_draft_cleanup';

/**
 * Expected bitrate range for a healthy recording. Outside this window we
 * emit `audio_bitrate_anomaly` so device-specific encoder glitches (e.g.
 * 2026-04-22 Morales case: 13 kbps output from some tablets while others
 * encoded at 256 kbps on the same build) surface as dashboards rather than
 * support tickets. Bounds are intentionally wide — the signal is that
 * things landed 10× outside normal, not a precise codec check.
 */
const MIN_EXPECTED_KBPS = 32;
const MAX_EXPECTED_KBPS = 320;

interface AudioQualityParams {
  slotIndex?: number;
  durationSeconds: number;
  sizeBytes: number;
  segmentCount: number;
}

function reportAudioQuality({ slotIndex, durationSeconds, sizeBytes, segmentCount }: AudioQualityParams): void {
  // 8 bits per byte → kbps = (bytes * 8 / duration) / 1000
  const kbps = durationSeconds > 0 ? Math.round((sizeBytes * 8) / durationSeconds / 1000) : 0;
  trackEvent({
    name: 'audio_quality_measured',
    props: {
      slot_index: slotIndex ?? 0,
      duration_s: durationSeconds,
      size_bytes: sizeBytes,
      kbps_estimated: kbps,
      segment_count: segmentCount,
    },
  });
  if (durationSeconds > 5 && (kbps < MIN_EXPECTED_KBPS || kbps > MAX_EXPECTED_KBPS)) {
    trackEvent({
      name: 'audio_bitrate_anomaly',
      props: {
        slot_index: slotIndex ?? 0,
        duration_s: durationSeconds,
        size_bytes: sizeBytes,
        kbps_estimated: kbps,
        expected_min: MIN_EXPECTED_KBPS,
        expected_max: MAX_EXPECTED_KBPS,
      },
    });
  }
}

// Pure upload-retry helpers live in ./uploadRetry so they can be unit-tested
// without dragging expo-file-system imports through the vm-based test loader.
// Re-exported here so existing consumers (record.tsx, etc.) keep working.
export {
  isTransientUploadError,
  isStalePresignError,
  getUploadPhase,
  getUploadHttpStatus,
} from './uploadRetry';
export type { UploadPhase, TaggedError } from './uploadRetry';

export interface PlaybackUrlResult {
  /** First (or only) segment's presigned GET URL. */
  url: string;
  /** ISO timestamp of the guaranteed-minimum URL validity. */
  expiresAt: string;
  /** One presigned GET URL per audio segment, in recording order. */
  segmentUrls: string[];
}

/**
 * Derive the upload filename from contentType (preferred) or the URI extension,
 * defaulting to .m4a. Durable AAC must upload as recording.aac with
 * contentType audio/aac — never the legacy hardcoded recording.m4a.
 */
function deriveUploadFileName(fileUri: string, contentType: string): string {
  const byType: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
  };
  let ext = byType[contentType];
  if (!ext) {
    const m = /\.([a-z0-9]{1,5})(?:\?|#|$)/i.exec(fileUri);
    ext = m ? m[1].toLowerCase() : 'm4a';
  }
  return `recording.${ext}`;
}

function generateIdempotencyKey(): string {
  // expo-crypto → global crypto → Math.random (per CLAUDE.md rule 26: the
  // idempotency key is the only non-security random on iOS Hermes where
  // Math.random is permitted). Centralized in src/lib/random.ts.
  return getIdempotencyUuid();
}

function extensionFromUri(uri: string, fallback = 'm4a'): string {
  const match = uri.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : fallback;
}

/**
 * Race a promise against a timeout. Rejects with a user-friendly message
 * if the timeout fires first. Callers pass `onTimeout` to cancel the native
 * work (e.g. `uploadTask.cancelAsync()`) — otherwise the task keeps running
 * after the wrapper has rejected, which caused orphaned R2 objects and
 * deleted-but-still-uploading server records.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (onTimeout) {
        try { onTimeout(); } catch { /* best-effort */ }
      }
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timeoutId); resolve(value); },
      (error) => { clearTimeout(timeoutId); reject(error); }
    );
  });
}

// 3 attempts total covers a typical WiFi handoff (~5–10s) plus a stale-AP
// recovery, while keeping worst-case time-to-failure bounded (~35s).
const MAX_R2_ATTEMPTS = 3;
// Multi-segment recordings upload segments concurrently in a bounded pool.
// 3 lanes roughly triples multi-segment submit throughput without saturating
// clinic Wi-Fi; per-lane upload timeouts widen accordingly (uploadTimeoutMs
// takes a parallelism factor).
const SEGMENT_UPLOAD_CONCURRENCY = 3;
// Sentry issue REACT-NATIVE-4 (2026-05-13) had a 1.6s gap between
// NETWORK_LOST and submit_failed because the old retry used a flat 1.5s
// setTimeout. 15s covers a typical WiFi flap with headroom.
const NET_RECOVERY_WAIT_MS = 15_000;

async function uploadOnceWithRetry<T>(
  buildAndRun: (attempt: number) => Promise<T>,
  context: { segmentIndex?: number },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_R2_ATTEMPTS; attempt++) {
    try {
      return await buildAndRun(attempt);
    } catch (err) {
      lastErr = err;
      const transient = isTransientUploadError(err);
      // Re-presign on stale 401/403 only on the first attempt. `buildAndRun`
      // already calls getUploadUrl() at the top of each attempt, so simply
      // entering the next iteration produces a fresh presigned URL.
      const stalePresign = attempt === 1 && isStalePresignError(err);
      if (!transient && !stalePresign) throw err;
      if (attempt === MAX_R2_ATTEMPTS) throw err;
      const startedAt = Date.now();
      // Stale-presign retries don't need a long network-wait — the socket
      // succeeded, the URL was the problem. Skip the wait and re-attempt
      // immediately (after the jitter sleep below).
      const online = stalePresign ? true : await waitForNetworkOnline(NET_RECOVERY_WAIT_MS);
      const waitMs = Date.now() - startedAt;
      breadcrumb('upload', stalePresign ? 'r2_put_403_retry' : 'r2_put_retry', {
        attempt,
        segment_index: context.segmentIndex,
        wait_ms: waitMs,
        was_online_at_retry: online,
        http_status: (err as TaggedError).httpStatus,
      });
      // Tiny jitter so multiple concurrent uploads on the same device
      // don't slam the AP the instant it comes back.
      await new Promise<void>((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }
  throw lastErr;
}

const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
]);

export interface UploadProgressEvent {
  loaded: number;
  total: number;
  percent: number;
}

export interface ListRecordingsParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
  status?: RecordingStatus;
  reviewStatus?: ReviewStatus;
  search?: string;
}

export interface TranslateResult {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export interface EmailDraftResult {
  subject: string;
  body: string;
}

type RecordingPayload = Record<string, string | boolean | null>;

const createRecordingPartialSchema = createRecordingSchema.partial();
const SERVER_ENRICHABLE_BLANK_METADATA_FIELDS = new Set([
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
  'pimsPatientId',
]);
const DRAFT_NULLABLE_FIELDS = new Set<keyof CreateRecording>([
  'pimsPatientId',
  'clientName',
  'species',
  'breed',
  'appointmentType',
  // Deselecting a template (PatientForm allowDeselect → undefined) must reach
  // the server as an explicit null — dropping the key leaves the old template
  // on the draft and the SOAP note generates with a template the user removed.
  'templateId',
]);

function normalizeValidatedRecordingPayload(
  data: Partial<CreateRecording>,
  opts: { includePatientName: boolean; nullClearedOptional?: boolean; source?: Partial<CreateRecording> }
): RecordingPayload {
  const payload: RecordingPayload = {};
  if (opts.includePatientName) {
    payload.patientName = typeof data.patientName === 'string' ? data.patientName : '';
  } else if (typeof data.patientName === 'string') {
    payload.patientName = data.patientName;
  }

  for (const key of ['pimsPatientId', 'clientName', 'species', 'breed', 'appointmentType', 'templateId'] as const) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) {
      payload[key] = value;
    } else if (
      opts.nullClearedOptional &&
      opts.source &&
      DRAFT_NULLABLE_FIELDS.has(key) &&
      Object.prototype.hasOwnProperty.call(opts.source, key)
    ) {
      payload[key] = null;
    }
  }

  if (typeof data.foreignLanguage === 'boolean') {
    payload.foreignLanguage = data.foreignLanguage;
  }
  return payload;
}

export function normalizeCreateRecordingPayload(data: CreateRecording): RecordingPayload {
  const validated = createRecordingSchema.parse(data);
  return normalizeValidatedRecordingPayload(validated, { includePatientName: true });
}

function coerceNullClearsForDraftValidation(data: Partial<CreateRecording>): Partial<CreateRecording> {
  const validationInput = { ...data } as Partial<CreateRecording> & Record<string, unknown>;
  const source = data as Record<string, unknown>;
  for (const key of DRAFT_NULLABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] === null) {
      validationInput[key] = undefined;
    }
  }
  return validationInput;
}

export function normalizeDraftMetadataPayload(data: Partial<CreateRecording>): RecordingPayload {
  const validated = createRecordingPartialSchema.parse(coerceNullClearsForDraftValidation(data));
  return normalizeValidatedRecordingPayload(validated, {
    includePatientName: Object.prototype.hasOwnProperty.call(data, 'patientName'),
    nullClearedOptional: true,
    source: data,
  });
}

interface MetadataMatchOptions {
  allowServerEnrichedBlankFields?: boolean;
  pimsPatientIdExplicitlyCleared?: boolean;
}

function recordingMatchesMetadataPayload(
  recording: Recording,
  payload: RecordingPayload,
  opts: MetadataMatchOptions = {}
): boolean {
  const recordingData = recording as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (!Object.prototype.hasOwnProperty.call(recordingData, key)) return false;
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
    if (recordingValue !== value) return false;
  }
  return true;
}

function assertRecordingMatchesMetadataPayload(
  recording: Recording,
  payload?: RecordingPayload,
  opts: MetadataMatchOptions = {}
): Recording {
  if (payload && Object.keys(payload).length > 0 && !recordingMatchesMetadataPayload(recording, payload, opts)) {
    phaseError(
      'patch_draft',
      'Could not sync the latest patient details. Your recording is still saved on this device. Please try submitting again.'
    );
  }
  return recording;
}

function shouldFallbackSubmittedAtSort(error: unknown, params: ListRecordingsParams): boolean {
  return error instanceof ApiError && error.status === 400 && params.sortBy === 'submittedAt';
}

interface LocalUploadFile extends PendingConfirmFile {
  uri: string;
  duration: number;
}

interface ResilientUploadOptions {
  onUploadProgress?: (event: UploadProgressEvent) => void;
  onR2Complete?: (hint: PendingConfirm) => void | Promise<void>;
  onRecordingPrepared?: (recordingId: string) => void | Promise<void>;
  onClearPendingConfirm?: (reason?: PendingConfirmClearReason) => void | Promise<void>;
  resume?: PendingConfirm;
  existingRecordingId?: string;
  idempotencyKey?: string;
  supersededIdempotencyKey?: string;
  onRecoveryPrepared?: () => void | Promise<void>;
  metadataDirty?: boolean;
  pimsPatientIdExplicitlyCleared?: boolean;
  audioDurationSeconds?: number;
  slotIndex?: number;
  mode?: 'durable' | 'standard';
}

export class UploadIntentConflictError extends Error {
  readonly code = 'UPLOAD_INTENT_CONFLICT';
  readonly uploadPhase: 'prepare' | 'confirm';

  constructor(
    public readonly conflict: UploadIntentConflictDetails,
    phase: 'prepare' | 'confirm',
    message = 'This upload needs a safe status check before it can continue.',
    public readonly recoveryOutcome: 'restart_available' | 'unresolved' | null = null,
  ) {
    super(message);
    this.name = 'UploadIntentConflictError';
    this.uploadPhase = phase;
  }
}

function typedUploadIntentConflict(
  error: unknown,
  phase: 'prepare' | 'confirm',
): UploadIntentConflictError | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'UPLOAD_INTENT_CONFLICT') {
    return null;
  }
  try {
    return new UploadIntentConflictError(
      validateUploadIntentConflictDetails(error.data?.uploadConflict),
      phase,
      error.message,
    );
  } catch {
    return null;
  }
}

type PendingConfirmClearReason =
  | 'canonical_change'
  | 'invalid_resume'
  | 'committed_late_hint'
  | 'committed_late_anchor';

interface TimedOutPersistenceWrite {
  settled: Promise<void>;
  clearReason: Extract<
    PendingConfirmClearReason,
    'committed_late_hint' | 'committed_late_anchor'
  >;
  cleanupScheduled: boolean;
}

// Tactical persistence timeouts must not make an uncancelled SecureStore/native
// write invisible to a later retry. Keep this PHI-free, process-local registry
// keyed by the stable upload intent until each callback actually settles.
const timedOutPersistenceByIntent = new Map<string, Set<TimedOutPersistenceWrite>>();

function trackTimedOutPersistence(
  idempotencyKey: string,
  persistence: { settled: Promise<void>; timedOut: boolean },
  clearReason: TimedOutPersistenceWrite['clearReason'],
): TimedOutPersistenceWrite | null {
  if (!persistence.timedOut) return null;
  const entry: TimedOutPersistenceWrite = {
    settled: persistence.settled,
    clearReason,
    cleanupScheduled: false,
  };
  const writes = timedOutPersistenceByIntent.get(idempotencyKey) ?? new Set();
  writes.add(entry);
  timedOutPersistenceByIntent.set(idempotencyKey, writes);
  persistence.settled
    .finally(() => {
      writes.delete(entry);
      if (writes.size === 0) timedOutPersistenceByIntent.delete(idempotencyKey);
    })
    .catch(() => {});
  return entry;
}

function hasPendingTimedOutPersistence(idempotencyKey: string): boolean {
  return (timedOutPersistenceByIntent.get(idempotencyKey)?.size ?? 0) > 0;
}

function completeUploadMetadata(data: CreateRecording): PendingConfirmMetadata {
  const validated = createRecordingSchema.parse(data);
  return {
    patientName: validated.patientName,
    clientName: validated.clientName || null,
    species: validated.species || null,
    breed: validated.breed || null,
    appointmentType: validated.appointmentType || null,
    templateId: validated.templateId || null,
    foreignLanguage: validated.foreignLanguage ?? false,
    pimsPatientId: validated.pimsPatientId || null,
  };
}

function metadataAsPayload(metadata: PendingConfirmMetadata): RecordingPayload {
  return { ...metadata };
}

function validatePreparationResponse(
  raw: unknown,
  expectedFileCount: number,
  metadata: PendingConfirmMetadata,
  matchOptions: MetadataMatchOptions,
): PrepareUploadResponse {
  let value: PrepareUploadResponse;
  try {
    value = validatePreparedUploadEnvelope(raw, expectedFileCount);
  } catch (error) {
    tagPhase(error, 'prepare');
  }
  if (value.outcome !== 'prepared') {
    assertRecordingMatchesMetadataPayload(value.recording, metadataAsPayload(metadata), matchOptions);
    return value;
  }
  for (const upload of value.uploads!) {
    // Keep validation in this try-controlled preparation path so URL failures
    // remain phase tagged and cannot bypass caller cleanup/finally blocks.
    try {
      validateUploadUrl(upload.uploadUrl);
    } catch (error) {
      tagPhase(error, 'prepare');
    }
  }
  return value;
}

async function preflightLocalFiles(files: LocalUploadFile[]): Promise<LocalUploadFile[]> {
  if (files.length < 1 || files.length > 20) phaseError('preflight', 'A recording must contain between 1 and 20 audio files.');
  const checked: LocalUploadFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!(file.uri.startsWith('file://') || file.uri.startsWith('/'))) {
      phaseError('preflight', `Audio segment ${i + 1} has an invalid local path.`);
    }
    if (!ALLOWED_AUDIO_TYPES.has(file.contentType)) {
      phaseError('preflight', `Audio segment ${i + 1} has an unsupported format.`);
    }
    let info: Awaited<ReturnType<typeof getInfoAsync>>;
    try {
      info = await getInfoAsync(file.uri);
    } catch (error) {
      tagPhase(error, 'preflight');
    }
    const size = info.exists ? info.size ?? 0 : 0;
    if (!info.exists) phaseError('preflight', `Failed to read audio segment ${i + 1}. Please try recording again.`);
    if (!size) phaseError('preflight', `Audio segment ${i + 1} is empty. Please try recording again.`);
    if (size > MAX_FILE_SIZE_BYTES) {
      phaseError('preflight', `Audio segment ${i + 1} is too large. Maximum allowed size is 250MB.`);
    }
    checked.push({ ...file, fileSizeBytes: size });
  }
  return checked;
}

function preparationFiles(files: LocalUploadFile[] | PendingConfirmFile[]): PendingConfirmFile[] {
  return files.map(({ fileName, contentType, fileSizeBytes }) => ({ fileName, contentType, fileSizeBytes }));
}

async function requestPreparation(
  existingRecordingId: string | undefined,
  idempotencyKey: string,
  metadata: PendingConfirmMetadata,
  files: PendingConfirmFile[],
  matchOptions: MetadataMatchOptions,
): Promise<PrepareUploadResponse> {
  let raw: unknown;
  try {
    raw = await apiClient.post('/api/recordings/prepare-upload', {
      ...(existingRecordingId ? { existingRecordingId } : {}),
      metadata,
      files,
    }, idempotencyKey);
  } catch (error) {
    const conflict = typedUploadIntentConflict(error, 'prepare');
    if (conflict) throw conflict;
    tagPhase(error, 'prepare');
  }
  return validatePreparationResponse(raw, files.length, metadata, matchOptions);
}

async function requestUploadIntentRecovery(input: {
  action: 'inspect' | 'restart';
  inspectionKey: string;
  replacementIdempotencyKey?: string;
  existingRecordingId?: string;
  metadata: PendingConfirmMetadata;
  files: PendingConfirmFile[];
  pendingConfirm?: PendingConfirm;
}): Promise<UploadIntentRecoveryResponse> {
  let raw: unknown;
  try {
    raw = await apiClient.post(
      '/api/recordings/upload-intent-recovery',
      {
        action: input.action,
        ...(input.replacementIdempotencyKey
          ? { replacementIdempotencyKey: input.replacementIdempotencyKey }
          : {}),
        ...(input.existingRecordingId ? { existingRecordingId: input.existingRecordingId } : {}),
        metadata: input.metadata,
        files: input.files,
        ...(input.pendingConfirm
          ? {
              pendingConfirm: {
                recordingId: input.pendingConfirm.recordingId,
                fileKey: input.pendingConfirm.fileKey,
                ...(input.pendingConfirm.segmentKeys
                  ? {
                      segmentKeys: input.pendingConfirm.segmentKeys,
                      segmentCount: input.pendingConfirm.segmentCount,
                    }
                  : {}),
              },
            }
          : {}),
      },
      input.inspectionKey,
    );
  } catch (error) {
    const conflict = typedUploadIntentConflict(error, 'prepare');
    if (conflict) throw conflict;
    tagPhase(error, 'prepare');
  }
  let response: UploadIntentRecoveryResponse;
  try {
    response = validateUploadIntentRecoveryEnvelope(raw, input.files.length);
  } catch (error) {
    tagPhase(error, 'prepare');
  }
  if (response.outcome === 'prepared') {
    for (const upload of response.uploads) {
      try {
        validateUploadUrl(upload.uploadUrl);
      } catch (error) {
        tagPhase(error, 'prepare');
      }
    }
  }
  return response;
}

function isRouteLevelPrepare404(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === undefined;
}

function trackStaleRecovery(
  stage: string,
  outcome: string,
  segmentCount: number,
  mode: 'durable' | 'standard',
): void {
  trackEvent({
    name: 'upload_stale_recording_recovery',
    props: { stage, outcome, attempt: 1, segment_count: segmentCount, mode },
  });
}

async function postConfirm(
  recordingId: string,
  hint: Pick<PendingConfirm, 'fileKey' | 'segmentKeys' | 'segmentCount'>,
  metadata: PendingConfirmMetadata,
  matchOptions: MetadataMatchOptions,
): Promise<Recording> {
  recordingIdSchema.parse(recordingId);
  let confirmed: Recording;
  try {
    confirmed = await apiClient.post(`/api/recordings/${recordingId}/confirm-upload`, {
      fileKey: hint.fileKey,
      ...(hint.segmentKeys ? { segmentKeys: hint.segmentKeys, segmentCount: hint.segmentCount } : {}),
      metadata,
    });
  } catch (error) {
    const conflict = typedUploadIntentConflict(error, 'confirm');
    if (conflict) throw conflict;
    // Rolling deployments and older API versions can commit the upload and
    // still return an untyped 409. Retain the proven-completed GET fallback;
    // typed conflicts use the stricter recovery endpoint below.
    if (error instanceof ApiError && error.status === 409) {
      let current: Recording;
      try {
        current = await apiClient.get(`/api/recordings/${recordingId}`);
      } catch (probeError) {
        tagPhase(probeError, 'confirm');
      }
      if (
        current.status !== 'draft' &&
        current.status !== 'uploading' &&
        current.status !== 'failed'
      ) {
        return assertRecordingMatchesMetadataPayload(
          current,
          metadataAsPayload(metadata),
          matchOptions,
        );
      }
    }
    tagPhase(error, 'confirm');
  }
  return assertRecordingMatchesMetadataPayload(confirmed, metadataAsPayload(metadata), matchOptions);
}

async function invokePreparedCallback(
  callback: ResilientUploadOptions['onRecordingPrepared'],
  recordingId: string,
): Promise<{ settled: Promise<void>; timedOut: boolean }> {
  if (!callback) return { settled: Promise.resolve(), timedOut: false };
  const settled = Promise.resolve()
    .then(() => callback(recordingId))
    .then(
      () => undefined,
      () => {
        // The server-side idempotency intent remains authoritative. A local
        // SecureStore/native bridge failure must not strand the upload before
        // the R2 PUT, and the callback stays handled if it rejects later.
        breadcrumb('upload', 'recording_anchor_write_failed', { stage: 'prepared' });
      },
    );
  try {
    await withTimeout(
      settled,
      RECORDING_ANCHOR_PERSIST_TIMEOUT_MS,
      'Timed out while saving upload identity.',
    );
    return { settled, timedOut: false };
  } catch {
    breadcrumb('upload', 'recording_anchor_write_timeout', { stage: 'prepared' });
    return { settled, timedOut: true };
  }
}

async function invokeClearHint(
  callback: ResilientUploadOptions['onClearPendingConfirm'],
  reason: PendingConfirmClearReason,
): Promise<void> {
  if (!callback) return;
  const settled = Promise.resolve()
    .then(() => callback(reason))
    .then(
      () => undefined,
      () => {
        breadcrumb('upload', 'pending_confirm_clear_failed', { stage: reason });
      },
    );
  try {
    await withTimeout(
      settled,
      PENDING_CONFIRM_PERSIST_TIMEOUT_MS,
      'Timed out while clearing upload recovery state.',
    );
  } catch {
    breadcrumb('upload', 'pending_confirm_clear_timeout', { stage: reason });
  }
}

async function invokeHintCallback(
  callback: ResilientUploadOptions['onR2Complete'],
  hint: PendingConfirm,
): Promise<{ settled: Promise<void>; timedOut: boolean }> {
  if (!callback) return { settled: Promise.resolve(), timedOut: false };
  const settled = Promise.resolve()
    .then(() => callback(hint))
    .then(
      () => undefined,
      () => {
        // The persistent server intent and deterministic object keys remain the
        // correctness backstop, so a local hint write must not block confirmation.
        breadcrumb('upload', 'pending_confirm_write_failed', { stage: 'post_put' });
      },
    );
  try {
    await withTimeout(
      settled,
      PENDING_CONFIRM_PERSIST_TIMEOUT_MS,
      'Timed out while saving upload recovery state.',
    );
    return { settled, timedOut: false };
  } catch {
    breadcrumb('upload', 'pending_confirm_write_timeout', { stage: 'post_put' });
    return { settled, timedOut: true };
  }
}

interface ActiveUploadTask {
  cancelAsync(): Promise<void>;
}

type StaleCanonicalPreparationError = TaggedError & { staleCanonicalPreparation: true };

function staleCanonicalPreparationError(): StaleCanonicalPreparationError {
  const error = new Error('Upload preparation changed while storage uploads were active.') as StaleCanonicalPreparationError;
  error.uploadPhase = 'prepare';
  error.staleCanonicalPreparation = true;
  return error;
}

function isStaleCanonicalPreparationError(error: unknown): error is StaleCanonicalPreparationError {
  return error instanceof Error && (error as Partial<StaleCanonicalPreparationError>).staleCanonicalPreparation === true;
}

async function putPreparedFiles(
  files: LocalUploadFile[],
  initial: PrepareUploadResponse,
  requestFreshPreparation: () => Promise<PrepareUploadResponse>,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<{ keys: string[]; already?: Recording }> {
  if (!initial.uploads) phaseError('prepare', 'Prepared upload URLs are missing.');
  let uploads = initial.uploads;
  const keys = uploads.map((entry) => entry.fileKey);
  const sentBytes = new Array(files.length).fill(0) as number[];
  const totalBytes = files.reduce((sum, file) => sum + file.fileSizeBytes, 0);
  let lastPercent = 0;
  const active = new Set<ActiveUploadTask>();
  let refreshPromise: Promise<PrepareUploadResponse> | null = null;
  let refreshUsed = false;
  let already: Recording | undefined;
  let refreshFailure: TaggedError | undefined;

  const emit = () => {
    if (!onProgress) return;
    const loaded = sentBytes.reduce((sum, bytes) => sum + bytes, 0);
    lastPercent = Math.max(lastPercent, totalBytes > 0 ? Math.round((loaded / totalBytes) * 100) : 0);
    onProgress({ loaded, total: totalBytes, percent: lastPercent });
  };
  const cancelActive = async () => {
    await Promise.all([...active].map((task) => task.cancelAsync().catch(() => {})));
  };
  const refresh = async (): Promise<PrepareUploadResponse> => {
    if (refreshPromise) return refreshPromise;
    if (refreshUsed) phaseError('r2_put', 'The refreshed upload URL was rejected. Please try again.');
    refreshUsed = true;
    refreshPromise = requestFreshPreparation();
    const next = await refreshPromise;
    if (next.recording.id !== initial.recording.id) {
      refreshFailure = staleCanonicalPreparationError();
      await cancelActive();
      throw refreshFailure;
    }
    if (next.outcome !== 'prepared') {
      already = next.recording;
      await cancelActive();
      return next;
    }
    const nextKeys = next.uploads?.map((entry) => entry.fileKey) ?? [];
    if (nextKeys.length !== keys.length || nextKeys.some((key, i) => key !== keys[i])) {
      refreshFailure = staleCanonicalPreparationError();
      await cancelActive();
      throw refreshFailure;
    }
    uploads = next.uploads!;
    return next;
  };

  const uploadOne = async (index: number) => {
    const file = files[index];
    let attempt = 0;
    let urlEntry = uploads[index];
    // A stale signature refresh earns exactly one PUT against the fresh URL,
    // even when transient failures already consumed the normal attempt budget.
    // Otherwise a final-attempt 401/403 can refresh and fall out of the loop as
    // a false success without ever sending bytes to the new URL.
    let refreshedUrlAttemptPending = false;
    let usingRefreshedUrl = false;
    while (attempt < MAX_R2_ATTEMPTS || refreshedUrlAttemptPending) {
      attempt++;
      refreshedUrlAttemptPending = false;
      sentBytes[index] = 0;
      let task: ActiveUploadTask | null = null;
      try {
        try {
          validateUploadUrl(urlEntry.uploadUrl);
        } catch (error) {
          tagPhase(error, 'r2_put');
        }
        const uploadTask = createUploadTask(
          urlEntry.uploadUrl,
          file.uri,
          {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers: { 'Content-Type': file.contentType },
          },
          onProgress
            ? (progress) => {
                sentBytes[index] = Math.min(progress.totalBytesSent, file.fileSizeBytes);
                emit();
              }
            : undefined,
        );
        task = uploadTask;
        active.add(uploadTask);
        const result = await withTimeout(
          uploadTask.uploadAsync(),
          uploadTimeoutMs(file.fileSizeBytes, files.length > 1 ? SEGMENT_UPLOAD_CONCURRENCY : 1),
          'Upload timed out. Please check your connection and try again.',
          () => { uploadTask.cancelAsync().catch(() => {}); },
        );
        if (!result || result.status < 200 || result.status >= 300) {
          phaseError('r2_put', `Upload to storage failed (HTTP ${result?.status ?? 'unknown'}).`, result?.status);
        }
        sentBytes[index] = file.fileSizeBytes;
        emit();
        return;
      } catch (error) {
        if (already) return;
        if (refreshFailure) throw refreshFailure;
        if (isStalePresignError(error)) {
          if (usingRefreshedUrl) {
            phaseError('r2_put', 'The refreshed upload URL was rejected. Please try again.');
          }
          const next = await refresh();
          if (next.outcome !== 'prepared') return;
          urlEntry = next.uploads![index];
          usingRefreshedUrl = true;
          refreshedUrlAttemptPending = true;
          continue;
        }
        if (!isTransientUploadError(error) || attempt >= MAX_R2_ATTEMPTS) throw error;
        await waitForNetworkOnline(NET_RECOVERY_WAIT_MS);
        await new Promise<void>((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
      } finally {
        if (task) active.delete(task);
      }
    }
  };

  try {
    await runWithConcurrency(files.length, SEGMENT_UPLOAD_CONCURRENCY, uploadOne);
  } catch (error) {
    await cancelActive();
    if (error instanceof Error && (error as TaggedError).uploadPhase) throw error;
    tagPhase(error, 'r2_put');
  }
  if (already) return { keys, already };
  return { keys };
}

async function legacyUpload(
  data: CreateRecording,
  files: LocalUploadFile[],
  metadata: PendingConfirmMetadata,
  options: ResilientUploadOptions,
  idempotencyKey: string,
  persistPrepared: (recordingId: string) => Promise<void>,
): Promise<{ recording: Recording; hint: PendingConfirm; replacedMissingRecordingId: boolean }> {
  let recording: Recording | undefined;
  let replacedMissingRecordingId = false;
  let createdForLegacyUpload = false;
  if (options.existingRecordingId) {
    try {
      if (options.metadataDirty) {
        recording = await apiClient.patch(
          `/api/recordings/${recordingIdSchema.parse(options.existingRecordingId)}/draft-metadata`,
          normalizeDraftMetadataPayload(data),
        );
      } else {
        recording = await apiClient.get(`/api/recordings/${recordingIdSchema.parse(options.existingRecordingId)}`);
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) tagPhase(error, 'patch_draft');
      replacedMissingRecordingId = true;
    }
  }
  if (!recording) {
    try {
      recording = await apiClient.post('/api/recordings', {
        ...normalizeCreateRecordingPayload(data),
        isDraft: false,
      }, idempotencyKey);
      createdForLegacyUpload = true;
    } catch (error) {
      tagPhase(error, 'create_draft');
    }
  }
  if (!recording) phaseError('create_draft', 'The server did not return a recording.');
  const canonicalRecording = recording;
  await persistPrepared(canonicalRecording.id);

  const keys = new Array(files.length) as string[];
  const sent = new Array(files.length).fill(0) as number[];
  const total = files.reduce((sum, file) => sum + file.fileSizeBytes, 0);
  let lastPercent = 0;
  const uploadOne = async (index: number) => {
    const file = files[index];
    await uploadOnceWithRetry(async () => {
      let signed: UploadUrlResponse;
      try {
        signed = await apiClient.post(`/api/recordings/${canonicalRecording.id}/upload-url`, {
          fileName: file.fileName,
          contentType: file.contentType,
          fileSizeBytes: file.fileSizeBytes,
        });
        validateUploadUrl(signed.uploadUrl);
      } catch (error) {
        tagPhase(error, 'presign');
      }
      keys[index] = signed.fileKey;
      const task = createUploadTask(
        signed.uploadUrl,
        file.uri,
        { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': file.contentType } },
        options.onUploadProgress
          ? (progress) => {
              sent[index] = Math.min(progress.totalBytesSent, file.fileSizeBytes);
              const loaded = sent.reduce((sum, bytes) => sum + bytes, 0);
              lastPercent = Math.max(lastPercent, total > 0 ? Math.round((loaded / total) * 100) : 0);
              options.onUploadProgress!({ loaded, total, percent: lastPercent });
            }
          : undefined,
      );
      const result = await withTimeout(
        task.uploadAsync(), uploadTimeoutMs(file.fileSizeBytes),
        'Upload timed out. Please check your connection and try again.',
        () => { task.cancelAsync().catch(() => {}); },
      );
      if (!result || result.status < 200 || result.status >= 300) {
        phaseError('r2_put', `Upload to storage failed (HTTP ${result?.status ?? 'unknown'}).`, result?.status);
      }
    }, { segmentIndex: index });
  };
  try {
    await runWithConcurrency(files.length, SEGMENT_UPLOAD_CONCURRENCY, uploadOne);
  } catch (error) {
    if (createdForLegacyUpload) {
      await apiClient
        .delete(`/api/recordings/${canonicalRecording.id}`, { reason: 'orphan_pending_confirm' })
        .catch(() => {});
    }
    throw error;
  }
  const hint: PendingConfirm = {
    recordingId: canonicalRecording.id,
    fileKey: keys[0],
    ...(files.length > 1 ? { segmentKeys: keys, segmentCount: keys.length } : {}),
    metadata,
    files: preparationFiles(files),
  };
  return { recording: canonicalRecording, hint, replacedMissingRecordingId };
}

async function executeResilientUpload(
  data: CreateRecording,
  inputFiles: LocalUploadFile[],
  options: ResilientUploadOptions,
): Promise<Recording> {
  const idempotencyKey = options.idempotencyKey;
  if (
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !/^[\x21-\x7e]+$/.test(idempotencyKey)
  ) {
    phaseError('prepare', 'This recording is missing its stable upload identity. Please reopen it and try again.');
  }
  const isRestartIdentity = idempotencyKey.startsWith('recording-upload-v2:restart:');
  const suppliedSupersededKey = options.supersededIdempotencyKey;
  const hasValidSupersededKey =
    typeof suppliedSupersededKey === 'string' &&
    suppliedSupersededKey.startsWith('recording-upload-v') &&
    suppliedSupersededKey.length <= 128 &&
    /^[\x21-\x7e]+$/.test(suppliedSupersededKey) &&
    suppliedSupersededKey !== idempotencyKey;
  if (
    isRestartIdentity !== hasValidSupersededKey ||
    (suppliedSupersededKey !== undefined && !hasValidSupersededKey)
  ) {
    phaseError(
      'prepare',
      'This saved upload restart is incomplete. Check its upload status before retrying.',
    );
  }
  if (hasPendingTimedOutPersistence(idempotencyKey)) {
    phaseError(
      'prepare',
      'Captivet is still securing the saved upload state. Check the upload status again.',
    );
  }
  const metadata = completeUploadMetadata(data);
  const metadataMatchOptions: MetadataMatchOptions = {
    allowServerEnrichedBlankFields: true,
    pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
      data.pimsPatientId,
      options.pimsPatientIdExplicitlyCleared,
    ),
  };
  const mode = options.mode ?? 'standard';
  const validResume = options.resume ? validatePendingConfirm(options.resume) : null;
  let latestPendingConfirm: PendingConfirm | null = validResume;
  let staleRestartUsed = false;
  let recoveryRestartConsumed = false;
  let qualityReported = false;
  const timedOutPersistenceWrites: TimedOutPersistenceWrite[] = [];
  const persistPrepared = async (recordingId: string): Promise<void> => {
    const persistence = await invokePreparedCallback(options.onRecordingPrepared, recordingId);
    const tracked = trackTimedOutPersistence(
      idempotencyKey,
      persistence,
      'committed_late_anchor',
    );
    if (tracked) timedOutPersistenceWrites.push(tracked);
  };

  const scheduleCommittedLateWriteCleanup = (): void => {
    for (const write of timedOutPersistenceWrites) {
      if (write.cleanupScheduled) continue;
      write.cleanupScheduled = true;
      write.settled
        .then(() => invokeClearHint(options.onClearPendingConfirm, write.clearReason))
        .catch(() => {});
    }
  };

  const staleFailure = (error: unknown): never => {
    if (error instanceof Error) {
      error.message = STALE_RECORDING_UPLOAD_COPY;
      throw error;
    }
    const wrapped = new Error(STALE_RECORDING_UPLOAD_COPY) as TaggedError;
    wrapped.uploadPhase = 'confirm';
    throw wrapped;
  };

  const prepareAndUpload = async (existingRecordingId: string | undefined): Promise<Recording> => {
    const files = await preflightLocalFiles(inputFiles);
    if (!qualityReported) {
      qualityReported = true;
      const duration = options.audioDurationSeconds ?? files.reduce((sum, file) => sum + file.duration, 0);
      if (duration > 0) {
        reportAudioQuality({
          slotIndex: options.slotIndex,
          durationSeconds: Math.round(duration),
          sizeBytes: files.reduce((sum, file) => sum + file.fileSizeBytes, 0),
          segmentCount: files.length,
        });
      }
    }
    const descriptors = preparationFiles(files);
    let prepared: PrepareUploadResponse;
    let recoveryPreparedThisCall = false;
    try {
      if (options.supersededIdempotencyKey && !recoveryRestartConsumed) {
        recoveryRestartConsumed = true;
        const recovery = await requestUploadIntentRecovery({
          action: 'restart',
          inspectionKey: options.supersededIdempotencyKey,
          replacementIdempotencyKey: idempotencyKey,
          existingRecordingId,
          metadata,
          files: descriptors,
          pendingConfirm: validResume ?? undefined,
        });
        if (recovery.outcome === 'restart_available' || recovery.outcome === 'unresolved') {
          throw new UploadIntentConflictError(
            recovery.conflict,
            'prepare',
            undefined,
            recovery.outcome,
          );
        }
        if (recovery.outcome === 'already_uploaded' || recovery.outcome === 'already_processed') {
          return assertRecordingMatchesMetadataPayload(
            recovery.recording,
            metadataAsPayload(metadata),
            metadataMatchOptions,
          );
        }
        prepared = {
          outcome: 'prepared',
          recording: recovery.recording,
          replacedMissingRecordingId: false,
          uploads: recovery.uploads,
          warnings: recovery.warnings,
        };
        recoveryPreparedThisCall = true;
      } else {
        prepared = await requestPreparation(
          existingRecordingId,
          idempotencyKey,
          metadata,
          descriptors,
          metadataMatchOptions,
        );
      }
    } catch (error) {
      if (!isRouteLevelPrepare404(error)) throw error;
      // A controlled restart must be authorized by the recovery transaction.
      // Falling back to the legacy create/upload route here would bypass the
      // server's proof that the superseded attempt is safe to retire and could
      // duplicate an upload during a rolling API deployment.
      if (options.supersededIdempotencyKey) throw error;
      const legacy = await legacyUpload(data, files, metadata, options, idempotencyKey, persistPrepared);
      if (legacy.replacedMissingRecordingId) staleRestartUsed = true;
      return persistHintAndConfirm(legacy.hint, true);
    }
    // A stale supplied ID resolved here is the submit action's one allowed
    // replacement. If this canonical row also disappears later in the same
    // action, confirmation recovery must stop instead of creating a third row.
    // Recursive preparation after an observed canonical change may report the
    // same replacement again, so assignment is intentionally idempotent.
    if (prepared.replacedMissingRecordingId) staleRestartUsed = true;
    await persistPrepared(prepared.recording.id);
    if (recoveryPreparedThisCall && options.onRecoveryPrepared) {
      await options.onRecoveryPrepared();
    }
    if (validResume && validResume.recordingId !== prepared.recording.id) {
      await invokeClearHint(options.onClearPendingConfirm, 'canonical_change');
    }
    if (prepared.outcome !== 'prepared') return prepared.recording;
    let uploaded: Awaited<ReturnType<typeof putPreparedFiles>> | null = null;
    try {
      uploaded = await putPreparedFiles(
        files,
        prepared,
        async () => requestPreparation(
          prepared.recording.id,
          idempotencyKey,
          metadata,
          descriptors,
          metadataMatchOptions,
        ),
        options.onUploadProgress,
      );
    } catch (error) {
      if (!isStaleCanonicalPreparationError(error)) throw error;
      trackStaleRecovery('url_refresh', 'canonical_changed', files.length, mode);
      if (staleRestartUsed) {
        trackStaleRecovery('url_refresh', 'replacement_cap_reached', files.length, mode);
        staleFailure(error);
      }
      staleRestartUsed = true;
      await invokeClearHint(options.onClearPendingConfirm, 'canonical_change');
      try {
        return await prepareAndUpload(prepared.recording.id);
      } catch (restartError) {
        trackStaleRecovery('url_refresh', 'replacement_failed', files.length, mode);
        staleFailure(restartError);
      }
    }
    if (!uploaded) phaseError('prepare', 'The upload did not return a completion result.');
    if (uploaded.already) return uploaded.already;
    const hint: PendingConfirm = {
      recordingId: prepared.recording.id,
      fileKey: uploaded.keys[0],
      ...(uploaded.keys.length > 1 ? { segmentKeys: uploaded.keys, segmentCount: uploaded.keys.length } : {}),
      metadata,
      files: descriptors,
    };
    return persistHintAndConfirm(hint, false);
  };

  const confirmWithRecovery = async (hint: PendingConfirm, legacy: boolean): Promise<Recording> => {
    try {
      return await postConfirm(hint.recordingId, hint, metadata, metadataMatchOptions);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    trackStaleRecovery('confirm', 'probe_started', inputFiles.length, mode);
    let current: Recording | null = null;
    try {
      current = await apiClient.get(`/api/recordings/${recordingIdSchema.parse(hint.recordingId)}`);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        trackStaleRecovery('probe', 'failed', inputFiles.length, mode);
        if (error instanceof Error) (error as TaggedError).uploadPhase = 'probe';
        staleFailure(error);
      }
      if (staleRestartUsed) {
        trackStaleRecovery('probe', 'replacement_cap_reached', inputFiles.length, mode);
        staleFailure(error);
      }
      staleRestartUsed = true;
      await invokeClearHint(options.onClearPendingConfirm, 'canonical_change');
      try {
        const result = await prepareAndUpload(hint.recordingId);
        trackStaleRecovery('probe', 'replacement_succeeded', inputFiles.length, mode);
        return result;
      } catch (replacementError) {
        trackStaleRecovery('probe', 'replacement_failed', inputFiles.length, mode);
        staleFailure(replacementError);
      }
    }
    if (!current) staleFailure(new Error('The server did not return the recording probe.'));
    const probedRecording = current!;
    if (probedRecording.status === 'draft' || probedRecording.status === 'uploading') {
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      try {
        const result = await postConfirm(hint.recordingId, hint, metadata, metadataMatchOptions);
        trackStaleRecovery('confirm', 'retry_succeeded', inputFiles.length, mode);
        return result;
      } catch (error) {
        trackStaleRecovery('confirm', 'retry_failed', inputFiles.length, mode);
        staleFailure(error);
      }
    }
    if (legacy || !hint.files) {
      trackStaleRecovery('probe', 'proof_unavailable', inputFiles.length, mode);
      const error = new Error(STALE_RECORDING_UPLOAD_COPY) as TaggedError;
      error.uploadPhase = 'confirm';
      throw error;
    }
    let proof: PrepareUploadResponse | null = null;
    try {
      proof = await requestPreparation(
        hint.recordingId,
        idempotencyKey,
        metadata,
        hint.files,
        metadataMatchOptions,
      );
    } catch (error) {
      trackStaleRecovery('probe', 'proof_failed', inputFiles.length, mode);
      staleFailure(error);
    }
    if (!proof) staleFailure(new Error('The server did not return upload proof.'));
    const verifiedProof = proof!;
    await persistPrepared(verifiedProof.recording.id);
    if (verifiedProof.outcome === 'already_uploaded' || verifiedProof.outcome === 'already_processed') {
      trackStaleRecovery('probe', 'proof_succeeded', inputFiles.length, mode);
      return verifiedProof.recording;
    }
    trackStaleRecovery('probe', 'proof_failed', inputFiles.length, mode);
    const error = new Error(STALE_RECORDING_UPLOAD_COPY) as TaggedError;
    error.uploadPhase = 'confirm';
    throw error;
  };

  const persistHintAndConfirm = async (hint: PendingConfirm, legacy: boolean): Promise<Recording> => {
    latestPendingConfirm = hint;
    const persistence = await invokeHintCallback(options.onR2Complete, hint);
    const tracked = trackTimedOutPersistence(
      idempotencyKey,
      persistence,
      'committed_late_hint',
    );
    if (tracked) timedOutPersistenceWrites.push(tracked);
    const result = await confirmWithRecovery(hint, legacy);
    return result;
  };

  if (options.resume && !validResume) {
    await invokeClearHint(options.onClearPendingConfirm, 'invalid_resume');
  }
  try {
    const result = validResume
      ? await confirmWithRecovery(validResume, false)
      : await prepareAndUpload(options.existingRecordingId);
    scheduleCommittedLateWriteCleanup();
    return result;
  } catch (error) {
    if (!(error instanceof UploadIntentConflictError)) {
      throw error;
    }
    if (hasPendingTimedOutPersistence(idempotencyKey)) {
      // The timed-out callback still owns a possible late write of the old
      // server ID or confirmation proof. Do not expose a destructive restart
      // until a subsequent status check observes that every callback settled.
      throw new UploadIntentConflictError(
        error.conflict,
        error.uploadPhase,
        'Captivet is still securing the saved upload state. Check the upload status again.',
        'unresolved',
      );
    }
    // A recovery response has already classified this state. Preserve that
    // exact outcome so callers cannot offer a restart for `unresolved`, and do
    // not inspect it again under a different identity.
    if (error.recoveryOutcome) throw error;

    const recoveryHint = latestPendingConfirm;
    let descriptors = recoveryHint?.files;
    if (!descriptors) {
      if (inputFiles.length > 0) {
        try {
          descriptors = preparationFiles(await preflightLocalFiles(inputFiles));
        } catch {
          throw error;
        }
      } else if (recoveryHint) {
        // Native durable confirmation proofs intentionally omit file
        // descriptors to keep PHI and mutable metadata out of the plaintext
        // manifest. The server can still inspect its canonical intent and R2
        // keys from this exact pending-confirm proof.
        descriptors = [];
      } else {
        throw error;
      }
    }
    const recovery = await requestUploadIntentRecovery({
      action: 'inspect',
      inspectionKey: idempotencyKey,
      existingRecordingId: recoveryHint?.recordingId ?? options.existingRecordingId,
      metadata,
      files: descriptors,
      pendingConfirm: recoveryHint ?? undefined,
    });
    if (recovery.outcome === 'already_uploaded' || recovery.outcome === 'already_processed') {
      scheduleCommittedLateWriteCleanup();
      return assertRecordingMatchesMetadataPayload(
        recovery.recording,
        metadataAsPayload(metadata),
        metadataMatchOptions,
      );
    }
    if (recovery.outcome === 'restart_available' || recovery.outcome === 'unresolved') {
      throw new UploadIntentConflictError(
        recovery.conflict,
        error.uploadPhase,
        undefined,
        recovery.outcome,
      );
    }
    phaseError('prepare', 'The upload status check returned an unexpected restart response.');
  }
}

export const recordingsApi = {
  async list(params: ListRecordingsParams = {}): Promise<PaginatedResponse<Recording>> {
    const sanitized = { ...params } as Record<string, string | number | undefined>;
    if (params.search) {
      sanitized.search = searchQuerySchema.parse(params.search);
    }
    try {
      return await apiClient.get('/api/recordings', sanitized);
    } catch (error) {
      // Compatibility for APKs installed before the matching backend deploy.
      // The new server supports `sortBy=submittedAt`; older servers reject the
      // enum with 400. Retry with createdAt so Recent Recordings and the list do
      // not hard-fail while submitted-id pinning still proves the post-submit rows.
      if (shouldFallbackSubmittedAtSort(error, params)) {
        return apiClient.get('/api/recordings', { ...sanitized, sortBy: 'createdAt' });
      }
      throw error;
    }
  },

  async get(
    id: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      allowAuthSideEffects?: boolean;
    } = {},
  ): Promise<Recording> {
    recordingIdSchema.parse(id);
    return apiClient.request(`/api/recordings/${id}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      allowAuthSideEffects: options.allowAuthSideEffects,
    });
  },

  async draftPresence(
    recordingIds: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<DraftPresenceResponse> {
    const payload = draftPresenceRequestSchema.parse({
      recordingIds: [...recordingIds],
    });
    const response = await apiClient.request<unknown>('/api/recordings/draft-presence', {
      method: 'POST',
      body: payload,
      timeoutMs: 10_000,
      signal: options.signal,
      allowAuthSideEffects: false,
    });
    return parseDraftPresenceResponse(payload.recordingIds, response);
  },

  async create(
    data: CreateRecording,
    options?: { isDraft?: boolean; idempotencyKey?: string }
  ): Promise<Recording> {
    const payload = normalizeCreateRecordingPayload(data);
    // Durable uploads pass a DETERMINISTIC idempotency key derived from the
    // durable recordingId (on disk before Start), so a retried create() after a
    // process kill reuses the same server row instead of duplicating. A random
    // key would be lost on death (CLAUDE.md Rule 21 permits Math.random only for
    // non-durable keys). Server idempotency enforcement closes the pre-response
    // kill window (Server Compatibility Gates).
    const idempotencyKey = options?.idempotencyKey ?? generateIdempotencyKey();
    return apiClient.post('/api/recordings', { ...payload, isDraft: options?.isDraft ?? false }, idempotencyKey);
  },

  async delete(id: string, opts?: { reason?: RecordingDeleteReason }): Promise<void> {
    recordingIdSchema.parse(id);
    return apiClient.delete(
      `/api/recordings/${id}`,
      opts?.reason ? { reason: opts.reason } : undefined
    );
  },

  /**
   * Best-effort cleanup of a server draft row whose local anchor vanished
   * ('no_local_meta'). A concurrent Submit shares the same effective upload
   * idempotency key and can therefore own the very same row — but a Submit
   * only removes the local draft AFTER confirm-upload succeeds, which moves
   * the row off 'draft'. The authoritative guard is SERVER-side: with
   * reason 'orphan_draft_cleanup' the API deletes atomically on a
   * status='draft' precondition and answers 409 RECORDING_NOT_DRAFT for a
   * claimed row (any client-side read would race the confirm). The
   * draft-presence pre-check here is only a cheap short-circuit and a
   * safety net against servers predating the atomic guard. Never throws.
   */
  async deleteOrphanDraftIfUnclaimed(
    id: string,
  ): Promise<'deleted' | 'skipped' | 'failed'> {
    try {
      recordingIdSchema.parse(id);
      const presence = await this.draftPresence([id]);
      const row = presence.recordings.find((entry) => entry.id === id);
      // Absent (already gone / replaced) or no longer 'draft' (a submit,
      // upload confirm, or processing pipeline claimed it) — leave it alone.
      if (!row || row.status !== 'draft') return 'skipped';
      await this.delete(id, { reason: 'orphan_draft_cleanup' });
      return 'deleted';
    } catch (error) {
      // The atomic server precondition refused: a concurrent submit claimed
      // the row between the presence read and the delete. Desired outcome.
      if (error instanceof ApiError && error.code === 'RECORDING_NOT_DRAFT') {
        return 'skipped';
      }
      return 'failed';
    }
  },

  /**
   * PATCH metadata on a recording still in `draft` status. Used by the
   * draft-save-on-finish upload flow to flush edited formData to the server
   * before confirm-upload commits the draft into processing.
   *
   * The server accepts any subset of the create fields; only sent keys are
   * updated. Returns the refreshed Recording. Server-side contract:
   *   200 — updated.
   *   400 — malformed body or cross-org templateId.
   *   403 — caller is not the recording owner and not an admin/owner.
   *   404 — recording not found in caller's org.
   *   409 `{ code: 'NOT_DRAFT' }` — recording has moved past draft.
   *
   * Upload callers fail closed on non-404 errors. A proven missing draft may
   * be resolved through the stable upload intent; live rows are never deleted
   * merely because metadata synchronization failed.
   */
  async updateDraftMetadata(
    recordingId: string,
    data: Partial<CreateRecording>
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.patch(`/api/recordings/${recordingId}/draft-metadata`, normalizeDraftMetadataPayload(data));
  },

  async getUploadUrl(
    recordingId: string,
    fileName: string,
    contentType = 'audio/x-m4a',
    fileSizeBytes?: number
  ): Promise<UploadUrlResponse> {
    recordingIdSchema.parse(recordingId);
    if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
      throw new Error(`Unsupported audio format: ${contentType}`);
    }
    return apiClient.post(`/api/recordings/${recordingId}/upload-url`, {
      fileName,
      contentType,
      ...(fileSizeBytes !== undefined && { fileSizeBytes }),
    });
  },

  async confirmUpload(
    recordingId: string,
    fileKey: string,
    opts?: {
      segmentKeys?: string[];
      segmentCount?: number;
      metadata?: CreateRecording;
      pimsPatientIdExplicitlyCleared?: boolean;
    }
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    // confirm-upload's metadata contract is a complete snapshot. Keep the
    // PATCH-oriented partial normalizer out of this path; Mobile 1.13.10 used
    // it here and omitted foreignLanguage=false, which the strict API rejected
    // as INVALID_CONFIRM_UPLOAD.
    const metadata = opts?.metadata ? completeUploadMetadata(opts.metadata) : undefined;
    const metadataPayload = metadata ? metadataAsPayload(metadata) : undefined;
    const metadataMatchOptions: MetadataMatchOptions = {
      allowServerEnrichedBlankFields: true,
      pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
        opts?.metadata?.pimsPatientId,
        opts?.pimsPatientIdExplicitlyCleared,
      ),
    };
    let recording: Recording;
    try {
      recording = await apiClient.post(`/api/recordings/${recordingId}/confirm-upload`, {
        fileKey,
        ...(opts?.segmentKeys ? { segmentKeys: opts.segmentKeys, segmentCount: opts.segmentCount } : {}),
        ...(metadata ? { metadata } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        let current: Recording;
        try {
          current = await apiClient.get(`/api/recordings/${recordingId}`);
        } catch (probeError) {
          tagPhase(probeError, 'confirm');
        }
        if (current.status !== 'draft' && current.status !== 'uploading' && current.status !== 'failed') {
          return assertRecordingMatchesMetadataPayload(current, metadataPayload, metadataMatchOptions);
        }
      }
      tagPhase(error, 'confirm');
    }
    return assertRecordingMatchesMetadataPayload(recording, metadataPayload, metadataMatchOptions);
  },

  async prepareUpload(
    data: CreateRecording,
    files: PendingConfirmFile[],
    options: {
      existingRecordingId?: string;
      idempotencyKey: string;
      pimsPatientIdExplicitlyCleared?: boolean;
    },
  ): Promise<PrepareUploadResponse> {
    return requestPreparation(
      options.existingRecordingId,
      options.idempotencyKey,
      completeUploadMetadata(data),
      files,
      {
        allowServerEnrichedBlankFields: true,
        pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
          data.pimsPatientId,
          options.pimsPatientIdExplicitlyCleared,
        ),
      },
    );
  },

  async createWithFile(
    data: CreateRecording,
    fileUri: string,
    contentType = 'audio/x-m4a',
    options?: ResilientUploadOptions & { fileName?: string },
  ): Promise<Recording> {
    const fileName = options?.fileName ?? deriveUploadFileName(fileUri, contentType);
    return executeResilientUpload(data, [{
      uri: fileUri,
      duration: options?.audioDurationSeconds ?? 0,
      fileName,
      contentType,
      fileSizeBytes: 0,
    }], options ?? {});
  },

  async createWithSegments(
    data: CreateRecording,
    segments: { uri: string; duration: number }[],
    contentType = 'audio/x-m4a',
    options?: ResilientUploadOptions,
  ): Promise<Recording> {
    const files = segments.map((segment, index): LocalUploadFile => ({
      uri: segment.uri,
      duration: segment.duration,
      fileName: `recording_segment_${index}.${extensionFromUri(segment.uri)}`,
      contentType,
      fileSizeBytes: 0,
    }));
    return executeResilientUpload(data, files, options ?? {});
  },

  async confirmPendingUpload(
    data: CreateRecording,
    hint: PendingConfirm,
    options: Omit<ResilientUploadOptions, 'resume'>,
  ): Promise<Recording> {
    return executeResilientUpload(data, [], { ...options, resume: hint });
  },

  async retry(id: string): Promise<Recording> {
    recordingIdSchema.parse(id);
    return apiClient.post(`/api/recordings/${id}/retry`);
  },

  // Org-scoped model options + defaults for the reprocess pickers. Server filters
  // by configured BYOK keys + per-org allow-list and enforces the same role gate.
  async getOrgAiModels(): Promise<OrgAiModels> {
    const res = await apiClient.get<OrgAiModels>('/api/organization/ai-models');
    return normalizeOrgAiModels(res); // shape guard (rule 10), src/lib/aiModels.ts
  },

  // Re-transcribe + regenerate SOAP with chosen models. 202 returns the updated
  // Recording (status flipped to a non-terminal value) so the caller seeds its
  // cache and polling starts without a refetch race.
  async reprocessRecording(
    recordingId: string,
    models: { transcriptionModelId?: string; soapModel?: string }
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.post<Recording>(`/api/recordings/${recordingId}/reprocess`, models);
  },

  async updateReview(recordingId: string, opts: { reviewed: boolean }): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.patch(`/api/recordings/${recordingId}/review`, {
      reviewed: opts.reviewed,
    });
  },

  async regenerateSoap(
    recordingId: string,
    opts: { templateId?: string | null } = {}
  ): Promise<void> {
    recordingIdSchema.parse(recordingId);
    return apiClient.request<void>(`/api/recordings/${recordingId}/regenerate-soap`, {
      method: 'POST',
      body: {
        ...(opts.templateId ? { templateId: opts.templateId } : {}),
      },
      parseJson: false,
    });
  },

  async updateMetadata(
    recordingId: string,
    data: UpdateRecordingMetadata
  ): Promise<Recording> {
    recordingIdSchema.parse(recordingId);
    return apiClient.patch(`/api/recordings/${recordingId}/metadata`, data);
  },

  async getSoapNote(recordingId: string): Promise<SoapNote> {
    recordingIdSchema.parse(recordingId);
    return apiClient.get(`/api/recordings/${recordingId}/soap-note`);
  },

  async getRecordingTasks(recordingId: string): Promise<RecordingTask[]> {
    recordingIdSchema.parse(recordingId);
    const res = await apiClient.get<{ data: RecordingTask[] }>(
      `/api/recordings/${recordingId}/tasks`
    );
    return unwrapTaskList(res); // rule-10 shape guard (wrapped response)
  },

  async updateRecordingTaskStatus(
    recordingId: string,
    taskId: string,
    status: 'accepted' | 'dismissed'
  ): Promise<RecordingTask> {
    recordingIdSchema.parse(recordingId);
    // taskId is server-supplied — validate it's a UUID before interpolating so a
    // stray '/', '?', or dot segment ('.'/'..') can't redirect the PATCH to
    // another route (e.g. /tasks/.. resolving to the recording route).
    recordingTaskIdSchema.parse(taskId);
    return apiClient.patch(`/api/recordings/${recordingId}/tasks/${taskId}`, { status });
  },

  /**
   * Issue short-lived presigned GET URLs for a recording's audio (server S5).
   * `Recording.audioFileUrl` is a raw R2 object key — never fetchable
   * directly. Multi-segment recordings are not merged server-side, so each
   * segment gets its own URL; `url` mirrors `segmentUrls[0]`.
   */
  async getPlaybackUrl(recordingId: string): Promise<PlaybackUrlResult> {
    recordingIdSchema.parse(recordingId);
    const result = await apiClient.post<PlaybackUrlResult>(
      `/api/recordings/${recordingId}/playback-url`
    );
    // Rule-10 shape guard: tolerate a response missing segmentUrls.
    const segmentUrls = Array.isArray(result?.segmentUrls)
      ? result.segmentUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [];
    if (segmentUrls.length === 0 && typeof result?.url === 'string' && result.url.length > 0) {
      segmentUrls.push(result.url);
    }
    if (segmentUrls.length === 0) {
      throw new ApiError('No playable audio URL was returned.', 0, false, undefined, 'NO_AUDIO');
    }
    return { url: segmentUrls[0], expiresAt: result?.expiresAt ?? '', segmentUrls };
  },

  async translate(
    recordingId: string,
    opts: { targetLanguage: string }
  ): Promise<TranslateResult> {
    recordingIdSchema.parse(recordingId);
    return apiClient.request<TranslateResult>(`/api/recordings/${recordingId}/translate`, {
      method: 'POST',
      body: { targetLanguage: opts.targetLanguage },
      timeoutMs: GENERATIVE_REQUEST_TIMEOUT_MS,
    });
  },

  async generateEmailDraft(
    recordingId: string,
    opts: { mode: 'visit_summary' }
  ): Promise<EmailDraftResult> {
    recordingIdSchema.parse(recordingId);
    return apiClient.request<EmailDraftResult>(`/api/recordings/${recordingId}/email-draft`, {
      method: 'POST',
      body: { mode: opts.mode },
      timeoutMs: GENERATIVE_REQUEST_TIMEOUT_MS,
    });
  },
};

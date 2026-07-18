/**
 * Durable recording manifest: type contract + pure parse/validate/serialize.
 *
 * No expo / RN imports — the validator must run on the JS recovery/fallback
 * path and in unit tests. Filesystem IO (atomic temp+rename write, read,
 * tombstone) lives in ./manifestIo and ./recovery, which import this module.
 *
 * The manifest is a BOUNDED sidecar driving UI/progress; it is NOT the recovery
 * source of truth. The complete ADTS prefix (./adts) is. A stale/torn manifest
 * must never block recovery (plan: On-Disk Durability).
 */
import { isValidDurableId } from './paths';
import type { PendingConfirm } from '../../types/multiPatient';
import { toNativePendingConfirmProof } from '../pendingConfirm';

export const MANIFEST_SCHEMA_VERSION = 3 as const;

export type DurableRecorderState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'interrupted'
  | 'stopped'
  | 'uploaded' // server confirmUpload succeeded; excluded from recovery
  | 'error';

const VALID_STATES: ReadonlySet<string> = new Set([
  'idle',
  'starting',
  'recording',
  'paused',
  'interrupted',
  'stopped',
  'uploaded',
  'error',
]);

/**
 * States that, together with >=1 complete ADTS frame and NO confirmed-upload
 * signal, make a manifest recoverable (plan: listRecoverableSessions).
 */
export const RECOVERABLE_STATES: ReadonlySet<DurableRecorderState> = new Set([
  'starting',
  'recording',
  'paused',
  'interrupted',
  'stopped',
  'error',
]);

export interface DurableAudioFile {
  uri: string; // audio.aac (local file:// or absolute path)
  committedBytes: number; // lower-bound UI hint; NEVER a seek anchor
  completeFrameBytes: number; // last confirmed complete-frame boundary; the seek anchor
}

export interface DurableRecordingManifest {
  schemaVersion: 3;
  recordingId: string;
  userId: string;
  slotId: string;
  state: DurableRecorderState;
  startedAt: string;
  updatedAt: string;
  container: 'adts';
  codec: 'aac_lc';
  bitrate: 32000 | 48000;
  sampleRate: 16000 | 24000;
  channels: 1;
  adtsFrameCount: number;
  durationMs: number; // frame-derived authoritative recovered/upload duration
  capturedDurationMs: number; // last live PCM-snapshot; NOT the upload duration
  audioFile: DurableAudioFile;
  peakDb: number; // running PCM peak before encoding
  appVersion: string;
  buildNumber: string;
  lastErrorCode?: string;
  serverRecordingId?: string; // death-surviving anchor; presence != confirmed upload
  confirmedUploadAt?: string; // SOLE confirmed-upload signal
  edited?: boolean; // durable source is the edited audio.aac
  anchorsPending?: boolean; // transient: edit intent written, anchors not finalized
  pendingConfirm?: PendingConfirm; // complete post-PUT hint; never contains a URL
  pendingConfirmJson?: string; // native on-disk representation, hydrated by JS
  uploadKeyOverride?: string; // controlled restart identity
  supersededUploadKey?: string; // prior intent inspected by recovery
}

export type ManifestValidation =
  | { ok: true; manifest: DurableRecordingManifest }
  | { ok: false; reason: string };

/** A URI is "local" if it is a file:// URI or an absolute filesystem path. */
export function isLocalUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length === 0) return false;
  if (uri.startsWith('file://')) return true;
  if (uri.startsWith('/')) return true;
  // Anything with a remote scheme (http, https, content://, s3, etc.) is rejected.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return false;
  return false;
}

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0;
}

/**
 * Validate an already-parsed object as a DurableRecordingManifest. Rejects
 * malformed shape, unsupported schema, invalid/path-traversal ids, wrong user,
 * non-local audio URI, and out-of-range codec/profile fields.
 */
export function validateManifestObject(
  obj: unknown,
  opts: { expectedUserId?: string } = {},
): ManifestValidation {
  if (typeof obj !== 'object' || obj === null) return { ok: false, reason: 'not_object' };
  const m = obj as Record<string, unknown>;

  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) return { ok: false, reason: 'unsupported_schema' };

  if (!isValidDurableId(m.recordingId)) return { ok: false, reason: 'invalid_recording_id' };
  if (!isValidDurableId(m.userId)) return { ok: false, reason: 'invalid_user_id' };
  if (!isValidDurableId(m.slotId)) return { ok: false, reason: 'invalid_slot_id' };

  if (opts.expectedUserId !== undefined && m.userId !== opts.expectedUserId) {
    return { ok: false, reason: 'wrong_user' };
  }

  if (!VALID_STATES.has(m.state as string)) return { ok: false, reason: 'invalid_state' };
  if (m.container !== 'adts') return { ok: false, reason: 'invalid_container' };
  if (m.codec !== 'aac_lc') return { ok: false, reason: 'invalid_codec' };
  if (m.bitrate !== 32000 && m.bitrate !== 48000) return { ok: false, reason: 'invalid_bitrate' };
  if (m.sampleRate !== 16000 && m.sampleRate !== 24000) return { ok: false, reason: 'invalid_sample_rate' };
  if (m.channels !== 1) return { ok: false, reason: 'invalid_channels' };

  if (!isFiniteNonNeg(m.adtsFrameCount)) return { ok: false, reason: 'invalid_frame_count' };
  if (!isFiniteNonNeg(m.durationMs)) return { ok: false, reason: 'invalid_duration' };
  if (!isFiniteNonNeg(m.capturedDurationMs)) return { ok: false, reason: 'invalid_captured_duration' };
  if (typeof m.peakDb !== 'number' || !Number.isFinite(m.peakDb)) return { ok: false, reason: 'invalid_peak' };

  if (!isNonEmptyString(m.startedAt)) return { ok: false, reason: 'invalid_started_at' };
  if (!isNonEmptyString(m.updatedAt)) return { ok: false, reason: 'invalid_updated_at' };
  if (!isNonEmptyString(m.appVersion)) return { ok: false, reason: 'invalid_app_version' };
  if (!isNonEmptyString(m.buildNumber)) return { ok: false, reason: 'invalid_build_number' };

  const af = m.audioFile as Record<string, unknown> | undefined;
  if (typeof af !== 'object' || af === null) return { ok: false, reason: 'invalid_audio_file' };
  if (!isLocalUri(af.uri)) return { ok: false, reason: 'non_local_uri' };
  if (!isFiniteNonNeg(af.committedBytes)) return { ok: false, reason: 'invalid_committed_bytes' };
  if (!isFiniteNonNeg(af.completeFrameBytes)) return { ok: false, reason: 'invalid_complete_frame_bytes' };

  if (m.pendingConfirmJson !== undefined && typeof m.pendingConfirmJson !== 'string') {
    return { ok: false, reason: 'invalid_pending_confirm_json' };
  }
  if (typeof m.pendingConfirmJson === 'string') {
    try {
      const pending = toNativePendingConfirmProof(JSON.parse(m.pendingConfirmJson));
      if (!pending) return { ok: false, reason: 'invalid_pending_confirm' };
      m.pendingConfirm = pending;
    } catch {
      return { ok: false, reason: 'invalid_pending_confirm' };
    }
  }
  if (
    m.uploadKeyOverride !== undefined &&
    (typeof m.uploadKeyOverride !== 'string' ||
      (!m.uploadKeyOverride.startsWith('recording-upload-v2:restart:') &&
        !m.uploadKeyOverride.startsWith('recording-upload-v3:audio-change:')) ||
      m.uploadKeyOverride.length > 128)
  ) {
    return { ok: false, reason: 'invalid_upload_key_override' };
  }
  if (
    m.supersededUploadKey !== undefined &&
    (typeof m.supersededUploadKey !== 'string' ||
      !m.supersededUploadKey.startsWith('recording-upload-v') ||
      m.supersededUploadKey.length > 128)
  ) {
    return { ok: false, reason: 'invalid_superseded_upload_key' };
  }

  return { ok: true, manifest: m as unknown as DurableRecordingManifest };
}

/** Parse + validate manifest JSON text. Returns null on any failure. */
export function parseManifest(
  jsonText: string,
  opts: { expectedUserId?: string } = {},
): DurableRecordingManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const result = validateManifestObject(parsed, opts);
  return result.ok ? result.manifest : null;
}

export function serializeManifest(manifest: DurableRecordingManifest): string {
  return JSON.stringify(manifest);
}

/** A manifest is confirmed-uploaded iff state 'uploaded' OR confirmedUploadAt set. */
export function isConfirmedUploaded(manifest: DurableRecordingManifest): boolean {
  return manifest.state === 'uploaded' || isNonEmptyString(manifest.confirmedUploadAt);
}

/**
 * Whether a manifest should be offered for recovery: a recoverable state, at
 * least one complete ADTS frame, and NOT confirmed-uploaded. Excludes on the
 * confirmed-upload signal only — NEVER on serverRecordingId alone (a
 * created-but-unconfirmed recording is still recoverable + reconciled).
 */
export function shouldOfferRecovery(manifest: DurableRecordingManifest): boolean {
  if (isConfirmedUploaded(manifest)) return false;
  if (!RECOVERABLE_STATES.has(manifest.state)) return false;
  return manifest.adtsFrameCount > 0;
}

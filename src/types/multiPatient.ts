import type { CreateRecording } from './index';
import type { UploadIntentConflictDetails } from '../api/uploadPreparation';

export interface AudioSegment {
  uri: string;
  duration: number; // seconds
  peakMetering?: number; // dBFS, closer to 0 means louder
}

/**
 * Resume hint captured once an R2 upload completes but before the server has
 * confirmed. If a later step (confirm request / network / response parsing)
 * fails, a retry can use this hint to skip re-creating the recording and
 * re-uploading audio — preventing duplicate server recordings.
 */
export interface PendingConfirm {
  recordingId: string;
  fileKey: string;
  // Multi-segment uploads need the full key list to confirm. For single-file
  // uploads these are omitted and `fileKey` is sufficient.
  segmentKeys?: string[];
  segmentCount?: number;
  metadata?: PendingConfirmMetadata;
  files?: PendingConfirmFile[];
}

export interface PendingConfirmFile {
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
}

export interface PendingConfirmMetadata {
  patientName: string;
  clientName: string | null;
  species: string | null;
  breed: string | null;
  appointmentType: string | null;
  templateId: string | null;
  foreignLanguage: boolean;
  pimsPatientId: string | null;
}

/**
 * Pointer to a durable-recorder capture (one growing audio.aac). When present,
 * this slot's audio lives ONLY in the durable file — `segments[]` is empty and
 * `durable.recordingId` is the sole on-disk pointer. Per CLAUDE.md Rule 20 this
 * MUST round-trip through all three stash sites (StashedSlot,
 * moveSegmentsToStashDir, convertToPatientSlots) or Resume orphans audio.aac.
 * Carries codec/sampleRate/bitrate so Resume reopens the encoder with the
 * locked settings. `edited` is intentionally NOT here — it is manifest-derived
 * (a stash round-trip could drop a slot flag).
 */
export interface DurableSlotRef {
  recordingId: string;
  codec: 'aac_lc';
  sampleRate: 16000 | 24000;
  bitrate: 32000 | 48000;
  durationMs: number; // frame-derived authoritative recovered/upload duration
  peakDb: number;     // PCM running peak for the synthetic silent-audio guard
  // Set ONLY on a support-staff cross-user vault restore: a local file:// copy of
  // audio.aac in a neutral, current-user-readable dir. The native durable root is
  // user-scoped, so a recording captured under the departing support_staff user
  // has no manifest under the restoring owner's scope — the submit path uploads
  // this copied file directly. Must stay a local URI (Rule 15).
  recoveredAudioUri?: string | null;
}

export interface PatientSlot {
  id: string;
  uploadIntentId: string;
  // A controlled conflict restart keeps the original intent for inspection
  // while all future upload calls use this persisted replacement identity.
  uploadKeyOverride: string | null;
  supersededUploadKey: string | null;
  // Ephemeral presentation state. The durable restart identities above are
  // persisted; this can be reconstructed by inspecting the server again.
  uploadRecovery: {
    conflict: UploadIntentConflictDetails;
    canRestart: boolean;
  } | null;
  formData: CreateRecording;
  // Distinguishes an untouched blank Patient ID (server enrichment allowed)
  // from one the user deliberately removed (server must preserve the clear).
  // This upload-affecting bit must survive every draft/stash/vault round-trip.
  pimsPatientIdExplicitlyCleared: boolean;
  audioState: 'idle' | 'recording' | 'paused' | 'stopped';
  segments: AudioSegment[];
  // Durable AAC capture pointer (null for legacy segments[] m4a slots). A slot
  // is "durable" iff `durable !== null`; every submit-path consumer branches on
  // durable-vs-legacy.
  durable: DurableSlotRef | null;
  audioUri: string | null;   // last segment's URI (compat)
  audioDuration: number;     // sum of all segment durations
  uploadStatus: 'pending' | 'uploading' | 'success' | 'error';
  uploadProgress: number;
  uploadError: string | null;
  serverRecordingId: string | null;
  draftSlotId: string | null;      // local SecureStore key for this draft
  serverDraftId: string | null;    // server Recording.id created on Finish (draft status)
  // True once formData has been edited after serverDraftId was assigned.
  // uploadSlot flushes the edits via PATCH /draft-metadata before confirming;
  // if PATCH cannot prove the server draft is current, submit fails closed
  // before upload/confirm so local audio stays recoverable.
  draftMetadataDirty: boolean;
  pendingConfirm: PendingConfirm | null;  // resume hint captured post-R2 upload
}

/**
 * True when a slot can still complete submission. A pending-confirm proof is
 * captured audio for workflow purposes because R2 already owns the bytes even
 * if every local file has disappeared.
 */
export function slotHasRecoverableAudio(
  slot: Pick<PatientSlot, 'segments' | 'durable' | 'pendingConfirm'>,
): boolean {
  return slot.segments.length > 0 || slot.durable !== null || slot.pendingConfirm !== null;
}

export type SessionAction =
  | { type: 'ADD_SLOT'; defaultTemplateId?: string }
  | { type: 'REMOVE_SLOT'; slotId: string }
  | { type: 'SET_ACTIVE_INDEX'; index: number }
  | { type: 'UPDATE_FORM'; slotId: string; field: keyof CreateRecording; value: string | boolean | undefined }
  | { type: 'SET_AUDIO_STATE'; slotId: string; audioState: PatientSlot['audioState'] }
  | { type: 'SAVE_AUDIO'; slotId: string; audioUri: string; duration: number; peakMetering?: number }
  | { type: 'CLEAR_AUDIO'; slotId: string }
  | { type: 'CONTINUE_RECORDING'; slotId: string; freshAudioUploadKey?: string }
  | { type: 'BIND_RECORDER'; slotId: string }
  | { type: 'UNBIND_RECORDER' }
  | { type: 'SET_UPLOAD_STATUS'; slotId: string; status: PatientSlot['uploadStatus']; progress?: number; error?: string | null; serverRecordingId?: string | null; pendingConfirm?: PendingConfirm | null }
  | { type: 'SET_PENDING_CONFIRM'; slotId: string; pendingConfirm: PendingConfirm | null }
  | {
      type: 'SET_UPLOAD_RECOVERY';
      slotId: string;
      recovery: PatientSlot['uploadRecovery'];
      error?: string | null;
    }
  | {
      type: 'RESET_UPLOAD_ATTEMPT';
      slotId: string;
      uploadKeyOverride: string;
      supersededUploadKey: string | null;
    }
  | { type: 'RESET_SESSION'; defaultTemplateId?: string }
  | { type: 'RESTORE_SESSION'; slots: PatientSlot[] }
  | { type: 'UPDATE_SEGMENT'; slotId: string; segmentIndex: number; uri: string; duration: number; peakMetering?: number }
  | { type: 'DELETE_SEGMENT'; slotId: string; segmentIndex: number }
  | { type: 'REPLACE_ALL_SEGMENTS'; slotId: string; segments: AudioSegment[] }
  | { type: 'SET_DRAFT_IDS'; slotId: string; draftSlotId: string; serverDraftId: string | null; preserveDirty?: boolean }
  // Attach/update the durable capture pointer on a slot (set on Finish/park of a
  // durable recording, and re-applied after Resume). Frame-derived durationMs +
  // PCM peakDb come from the durable manifest. Does NOT touch audioState/upload.
  | { type: 'SET_DURABLE_RECORDING'; slotId: string; durable: DurableSlotRef }
  | { type: 'MARK_DRAFT_METADATA_DIRTY'; slotId: string }
  | { type: 'CLEAR_DRAFT_DIRTY'; slotId: string }
  // Re-point a slot's segments at durable draft copies after draftStorage.saveDraft
  // succeeds. Without this, slot.segments[].uri keeps pointing at recorder-temp
  // paths the OS can reap, which is the trigger for Sentry REACT-NATIVE-8
  // (`Draft storage: all N segment copies failed (copy_threw)`). URI-only — the
  // reducer must NOT touch audioState, recorderBoundToSlotId, uploadStatus, or
  // any other slot field.
  | { type: 'PROMOTE_SEGMENTS_TO_DRAFT'; slotId: string; segments: AudioSegment[] };

export interface SessionState {
  slots: PatientSlot[];
  activeIndex: number;
  recorderBoundToSlotId: string | null;
}

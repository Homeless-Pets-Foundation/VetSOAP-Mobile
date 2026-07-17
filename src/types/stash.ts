import type { CreateRecording } from './index';
import type { DurableSlotRef, PendingConfirm } from './multiPatient';

export interface StashedSegment {
  uri: string; // documentDirectory path after move
  duration: number; // seconds
  peakMetering?: number; // dBFS, closer to 0 means louder
}

export interface StashedSlot {
  id: string;
  uploadIntentId?: string;
  uploadKeyOverride?: string | null;
  supersededUploadKey?: string | null;
  formData: CreateRecording;
  // Optional for stashes written before explicit Patient ID clear intent was
  // persisted. Legacy null form values are interpreted fail-closed on restore.
  pimsPatientIdExplicitlyCleared?: boolean;
  segments: StashedSegment[];
  audioDuration: number; // sum of all segment durations
  // Preserve draft linkage across the stash round-trip so Resume → Submit promotes
  // the existing server draft instead of creating a duplicate recording. Optional
  // for forward-compat with stashes written by older clients (treat missing as null).
  serverDraftId?: string | null;
  draftSlotId?: string | null;
  // True when the server draft may have stale metadata and submit must send
  // current formData with confirm-upload. Optional for legacy stashes.
  draftMetadataDirty?: boolean;
  pendingConfirm?: PendingConfirm | null;
  // Durable AAC capture pointer (Rule 20 site 1 of 3). A durable slot has empty
  // `segments[]` and its audio lives only in audio.aac under the durable root;
  // `durable.recordingId` (+ codec/sampleRate/bitrate) MUST survive the stash
  // round-trip or Resume orphans the file. Optional/forward-compat: legacy
  // stashes written before durable rollout have no `durable` and keep segments[].
  durable?: DurableSlotRef | null;
}

export interface StashedSession {
  id: string; // UUID
  stashedAt: string; // ISO timestamp
  clientName: string; // for display in stash list
  patientSummary: string; // e.g. "Buddy, Whiskers (+1 more)"
  patientCount: number;
  totalDuration: number; // sum of all segment durations across all slots
  totalSegments: number;
  slots: StashedSlot[];
  // Set when the stash has been resumed into an active session. Keeps the entry
  // in SecureStore so orphan cleanup preserves the audio directory, but hides it
  // from the stash list UI so it cannot be double-resumed. Cleared on app launch
  // (so a crashed resumed session can be recovered by the user again).
  resumedAt?: string; // ISO timestamp
}

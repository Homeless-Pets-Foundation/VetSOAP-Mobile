import type { CreateRecording } from './index';

export interface AudioSegment {
  uri: string;
  duration: number; // seconds
}

export interface PatientSlot {
  id: string;
  formData: CreateRecording;
  audioState: 'idle' | 'recording' | 'paused' | 'stopped';
  segments: AudioSegment[];
  audioUri: string | null;   // last segment's URI (compat)
  audioDuration: number;     // sum of all segment durations
  uploadStatus: 'pending' | 'uploading' | 'success' | 'error';
  uploadProgress: number;
  uploadError: string | null;
  serverRecordingId: string | null;
}

export type SessionAction =
  | { type: 'ADD_SLOT'; defaultTemplateId?: string }
  | { type: 'REMOVE_SLOT'; slotId: string }
  | { type: 'SET_ACTIVE_INDEX'; index: number }
  | { type: 'UPDATE_FORM'; slotId: string; field: keyof CreateRecording; value: string | boolean | undefined }
  | { type: 'SET_AUDIO_STATE'; slotId: string; audioState: PatientSlot['audioState'] }
  | { type: 'SAVE_AUDIO'; slotId: string; audioUri: string; duration: number }
  | { type: 'CLEAR_AUDIO'; slotId: string }
  | { type: 'CONTINUE_RECORDING'; slotId: string }
  | { type: 'BIND_RECORDER'; slotId: string }
  | { type: 'UNBIND_RECORDER' }
  | { type: 'SET_UPLOAD_STATUS'; slotId: string; status: PatientSlot['uploadStatus']; progress?: number; error?: string | null; serverRecordingId?: string | null }
  | { type: 'RESET_SESSION'; defaultTemplateId?: string }
  | { type: 'RESTORE_SESSION'; slots: PatientSlot[] }
  | { type: 'UPDATE_SEGMENT'; slotId: string; segmentIndex: number; uri: string; duration: number }
  | { type: 'DELETE_SEGMENT'; slotId: string; segmentIndex: number }
  | { type: 'REPLACE_ALL_SEGMENTS'; slotId: string; segments: AudioSegment[] };

export interface SessionState {
  slots: PatientSlot[];
  activeIndex: number;
  recorderBoundToSlotId: string | null;
}

import type { CreateRecording } from './index';

export interface StashedSegment {
  uri: string; // documentDirectory path after move
  duration: number; // seconds
  peakMetering?: number; // dBFS, closer to 0 means louder
}

export interface StashedSlot {
  id: string;
  formData: CreateRecording;
  segments: StashedSegment[];
  audioDuration: number; // sum of all segment durations
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
}

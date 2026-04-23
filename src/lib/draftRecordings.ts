import type { Recording } from '../types';
import type { DraftMetadata } from './draftStorage';
import { fileExists } from './fileOps';

const LOCAL_DRAFT_PREFIX = 'local-draft:';
type RecordingSortOrder = 'asc' | 'desc';

export function getLocalDraftRecordingId(slotId: string): string {
  return `${LOCAL_DRAFT_PREFIX}${slotId}`;
}

export function isDraftResumable(draft: DraftMetadata): boolean {
  return draft.segments.length > 0 && draft.segments.every((segment) => fileExists(segment.uri));
}

export function buildDraftResumeMap(drafts: DraftMetadata[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const draft of drafts) {
    if (!isDraftResumable(draft)) continue;
    if (draft.serverDraftId) {
      map[draft.serverDraftId] = draft.slotId;
    } else {
      map[getLocalDraftRecordingId(draft.slotId)] = draft.slotId;
    }
  }

  return map;
}

export function draftMetadataToRecording(
  draft: DraftMetadata,
  userId: string,
  organizationId: string
): Recording {
  return {
    id: draft.serverDraftId ?? getLocalDraftRecordingId(draft.slotId),
    organizationId,
    userId,
    patientName: draft.formData.patientName,
    clientName: draft.formData.clientName ?? null,
    species: draft.formData.species || null,
    breed: draft.formData.breed || null,
    appointmentType: draft.formData.appointmentType || null,
    pimsPatientId: draft.formData.pimsPatientId || null,
    patientId: null,
    status: 'draft',
    audioFileUrl: null,
    audioFileName: null,
    audioDurationSeconds: draft.audioDuration,
    audioFileSizeBytes: null,
    transcriptText: null,
    transcriptConfidence: null,
    qualityWarnings: [],
    soapNoteId: null,
    errorMessage: null,
    errorCode: null,
    processingStartedAt: null,
    processingCompletedAt: null,
    triggerJobId: null,
    foreignLanguage: Boolean(draft.formData.foreignLanguage),
    templateId: draft.formData.templateId ?? null,
    isExported: false,
    exportedAt: null,
    exportedTo: null,
    exportedBy: null,
    costBreakdown: null,
    importSource: null,
    createdAt: draft.savedAt,
    updatedAt: draft.savedAt,
  };
}

function getCreatedAtMs(recording: Recording): number {
  const createdAtMs = new Date(recording.createdAt).getTime();
  return Number.isNaN(createdAtMs) ? 0 : createdAtMs;
}

export function sortRecordingsByCreatedAt(
  recordings: Recording[],
  sortOrder: RecordingSortOrder = 'desc'
): Recording[] {
  return [...recordings].sort((a, b) => (
    sortOrder === 'asc'
      ? getCreatedAtMs(a) - getCreatedAtMs(b)
      : getCreatedAtMs(b) - getCreatedAtMs(a)
  ));
}

export function mergeDraftRecordings(
  localDrafts: DraftMetadata[],
  serverDrafts: Recording[],
  userId: string,
  organizationId: string,
  sortOrder: RecordingSortOrder = 'desc'
): Recording[] {
  const merged = new Map<string, Recording>();

  for (const draft of localDrafts) {
    if (!isDraftResumable(draft)) continue;
    const recording = draftMetadataToRecording(draft, userId, organizationId);
    merged.set(recording.id, recording);
  }

  for (const draft of serverDrafts) {
    merged.set(draft.id, draft);
  }

  return sortRecordingsByCreatedAt(Array.from(merged.values()), sortOrder);
}

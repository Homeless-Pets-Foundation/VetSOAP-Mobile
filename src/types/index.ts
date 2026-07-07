export type RecordingStatus =
  | 'draft'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'pending_metadata';

export type ReviewStatus = 'needs_review' | 'reviewed';

// Reprocess (re-transcribe + regenerate SOAP) model selection. Sourced from
// GET /api/organization/ai-models (org-scoped, key/allow-list filtered server-side).
export interface AiModelOption {
  id: string;
  label: string;
}
export interface AiModelCategory {
  default: string | null;
  options: AiModelOption[];
}
export interface OrgAiModels {
  transcription: AiModelCategory;
  soap: AiModelCategory;
}

export interface CostBreakdown {
  transcriptionCostCents: number;
  generationCostCents: number;
  totalCostCents: number;
  modelUsed: string;
  modelsUsed: Record<string, string> | null;
  promptTokens: number;
  completionTokens: number;
  tokensByModel: Record<string, { promptTokens: number; completionTokens: number }> | null;
  transcriptionModel: string | null;
  audioDurationSeconds?: number;
}

export interface Recording {
  id: string;
  organizationId: string;
  userId: string;
  patientName: string;
  clientName: string | null;
  species: string | null;
  breed: string | null;
  appointmentType: string | null;
  pimsPatientId: string | null;
  patientId: string | null;
  status: RecordingStatus;
  audioFileUrl: string | null;
  audioFileName: string | null;
  audioDurationSeconds: number | null;
  audioFileSizeBytes: number | null;
  transcriptText: string | null;
  transcriptConfidence: number | null;
  qualityWarnings: string[];
  soapNoteId: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  triggerJobId: string | null;
  foreignLanguage: boolean;
  templateId: string | null;
  isExported: boolean;
  exportedAt: string | null;
  exportedTo: string | null;
  exportedBy: { id: string; fullName: string } | null;
  reviewStatus?: ReviewStatus | null;
  reviewedAt?: string | null;
  reviewedBy?: { id: string; fullName: string } | null;
  costBreakdown: CostBreakdown | null;
  importSource: 'google_drive' | null;
  aiExtractedMetadata?: AiExtractedMetadata | null;
  needsMetadataReview?: boolean;
  submittedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AppointmentType = 'Wellness Exam' | 'Sick Visit' | 'Urgent/Emergency' | 'Follow-up';

export interface CreateRecording {
  pimsPatientId?: string;
  patientName: string;
  clientName?: string | null;
  species?: string | null;
  breed?: string | null;
  appointmentType?: AppointmentType | '' | null;
  templateId?: string;
  foreignLanguage?: boolean;
}

export type RecordingMetadataField =
  | 'patientName'
  | 'clientName'
  | 'species'
  | 'breed'
  | 'appointmentType';

export type MetadataReviewState = 'none' | 'unconfirmed' | 'confirmed' | 'dismissed';

export interface AiExtractedMetadataField {
  value: string;
  confidence?: number;
}

export interface AiMetadataDropReason {
  field: RecordingMetadataField;
  reason: string;
  currentValue?: string | null;
  suggestedValue?: string | null;
  value?: string | null;
}

export interface AiMetadataConflict {
  field: RecordingMetadataField;
  reason?: string;
  currentValue?: string | null;
  suggestedValue?: string | null;
  value?: string | null;
}

export interface AiExtractedMetadata {
  extractedAt?: string;
  model?: string;
  fields?: Partial<Record<RecordingMetadataField, AiExtractedMetadataField>>;
  appliedFields?: RecordingMetadataField[];
  dropReasons?: AiMetadataDropReason[] | Partial<Record<RecordingMetadataField, string | AiMetadataDropReason>>;
  conflicts?: AiMetadataConflict[];
  multiplePatientsDetected?: boolean;
  review?: MetadataReviewState;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
}

export interface UpdateRecordingMetadata {
  // `pimsPatientId` is widened onto the payload map only — it is intentionally NOT
  // part of the RecordingMetadataField union (which drives AI FIELD_LABELS /
  // correctedCount), since the PIMS Patient ID is never AI-filled.
  fields?: Partial<Record<RecordingMetadataField, string | null>> & { pimsPatientId?: string | null };
  review?: 'confirmed' | 'dismissed';
}

export interface Patient {
  id: string;
  organizationId: string;
  pimsPatientId: string;
  name: string;
  species: string | null;
  breed: string | null;
  dateOfBirth: string | null;
  knownAllergies: string | null;
  ongoingMedications: string | null;
  clinicalNotes: string | null;
  aiHistorySummary: string | null;
  aiHistoryUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Present when the server includes a Prisma relation-count on list endpoints.
  _count?: { recordings: number };
}

export interface ListPatientsParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface UpdatePatient {
  name?: string;
  species?: string | null;
  breed?: string | null;
  dateOfBirth?: string | null;
  knownAllergies?: string | null;
  ongoingMedications?: string | null;
  clinicalNotes?: string | null;
}

export interface SoapSection {
  content: string;
  isEdited: boolean;
  editedAt: string | null;
}

export interface SoapNote {
  id: string;
  recordingId: string;
  subjective: SoapSection;
  objective: SoapSection;
  assessment: SoapSection;
  plan: SoapSection;
  generatedAt: string;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  isExported: boolean;
  exportedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RecordingTaskType = 'todo' | 'billing';
export type RecordingTaskStatus = 'suggested' | 'accepted' | 'dismissed' | 'done';

export interface RecordingTask {
  id: string;
  type: RecordingTaskType;
  title: string;
  detail: string | null;
  status: RecordingTaskStatus;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UploadUrlResponse {
  uploadUrl: string;
  fileKey: string;
  warnings: string[];
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  organizationId: string;
  avatarUrl: string | null;
  capabilities?: string[];
}

export interface TemplateSection {
  enabled: boolean;
  customPrompt: string | null;
  defaultContent: string | null;
  requiredFields: string[];
}

export type OutputFormat = 'structured' | 'narrative';

export interface Template {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  species: string[];
  appointmentTypes: string[];
  sections: {
    subjective: TemplateSection;
    objective: TemplateSection;
    assessment: TemplateSection;
    plan: TemplateSection;
  };
  systemPrompt: string | null;
  outputFormat: OutputFormat;
  createdAt: string;
  updatedAt: string;
}

/**
 * Maps SOAP prompt variable keys to CreateRecording form fields.
 * Variables not listed here (appointment_date, transcript) are auto-generated.
 */
export const VARIABLE_TO_FIELD: Record<string, keyof CreateRecording> = {
  patient_name: 'patientName',
  client_name: 'clientName',
  species: 'species',
  breed: 'breed',
  appointment_type: 'appointmentType',
};

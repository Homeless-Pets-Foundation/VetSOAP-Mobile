export type RecordingStatus =
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'generating'
  | 'completed'
  | 'failed';

export interface Recording {
  id: string;
  organizationId: string;
  userId: string;
  patientName: string;
  clientName: string | null;
  species: string | null;
  breed: string | null;
  appointmentType: string | null;
  status: RecordingStatus;
  audioFileUrl: string | null;
  audioFileName: string | null;
  audioDurationSeconds: number | null;
  audioFileSizeBytes: number | null;
  transcriptText: string | null;
  transcriptConfidence: number | null;
  soapNoteId: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  triggerJobId: string | null;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRecording {
  patientName: string;
  clientName: string;
  species: string;
  breed?: string;
  appointmentType?: string;
  templateId?: string;
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
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  organizationId: string;
  avatarUrl: string | null;
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

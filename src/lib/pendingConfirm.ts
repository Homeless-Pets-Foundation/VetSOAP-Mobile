import type { PendingConfirm, PendingConfirmMetadata } from '../types/multiPatient';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ALLOWED_AUDIO_TYPES = new Set(['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/webm']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMetadata(value: unknown): PendingConfirmMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.patientName !== 'string' ||
    (typeof raw.clientName !== 'string' && raw.clientName !== null) ||
    (typeof raw.species !== 'string' && raw.species !== null) ||
    (typeof raw.breed !== 'string' && raw.breed !== null) ||
    (typeof raw.appointmentType !== 'string' && raw.appointmentType !== null) ||
    (typeof raw.templateId !== 'string' && raw.templateId !== null) ||
    typeof raw.foreignLanguage !== 'boolean' ||
    (typeof raw.pimsPatientId !== 'string' && raw.pimsPatientId !== null)
  ) {
    return undefined;
  }
  return {
    patientName: raw.patientName,
    clientName: raw.clientName,
    species: raw.species,
    breed: raw.breed,
    appointmentType: raw.appointmentType,
    templateId: raw.templateId,
    foreignLanguage: raw.foreignLanguage,
    pimsPatientId: raw.pimsPatientId,
  };
}

function normalizeFiles(value: unknown, expectedCount: number): PendingConfirm['files'] | undefined {
  if (!Array.isArray(value) || value.length !== expectedCount || value.length < 1 || value.length > 20) {
    return undefined;
  }
  const files = value.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.fileName !== 'string' || raw.fileName.length < 1 || raw.fileName.length > 255 ||
      typeof raw.contentType !== 'string' || !ALLOWED_AUDIO_TYPES.has(raw.contentType) ||
      typeof raw.fileSizeBytes !== 'number' || !Number.isSafeInteger(raw.fileSizeBytes) ||
      raw.fileSizeBytes < 1 || raw.fileSizeBytes > 250 * 1024 * 1024
    ) return null;
    return {
      fileName: raw.fileName,
      contentType: raw.contentType,
      fileSizeBytes: raw.fileSizeBytes,
    };
  });
  return files.every((entry) => entry !== null) ? files as NonNullable<PendingConfirm['files']> : undefined;
}

export function validatePendingConfirm(value: unknown): PendingConfirm | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PendingConfirm>;
  if (typeof raw.recordingId !== 'string' || !UUID_RE.test(raw.recordingId)) return null;
  if (typeof raw.fileKey !== 'string') return null;

  const prefix = `recordings/${UUID_PART}/${escapeRegex(raw.recordingId)}`;
  const single = new RegExp(`^${prefix}\\.[A-Za-z0-9]+$`);
  const manifested = new RegExp(`^${prefix}_segment_(\\d+)\\.[A-Za-z0-9]+$`);
  const legacy = new RegExp(`^${prefix}_recording_segment_(\\d+)\\.[A-Za-z0-9]+$`);
  let segmentKeys: string[] | undefined;
  let segmentCount: number | undefined;
  if (raw.segmentKeys !== undefined) {
    if (!Array.isArray(raw.segmentKeys) || raw.segmentKeys.length < 1 || raw.segmentKeys.length > 20) {
      return null;
    }
    if (
      raw.segmentKeys.some((key) => typeof key !== 'string') ||
      new Set(raw.segmentKeys).size !== raw.segmentKeys.length ||
      raw.fileKey !== raw.segmentKeys[0]
    ) {
      return null;
    }
    const firstNew = manifested.test(raw.segmentKeys[0]!);
    const pattern = firstNew ? manifested : legacy;
    if (
      !raw.segmentKeys.every((key, index) => {
        const match = pattern.exec(key);
        return !!match && Number(match[1]) === index;
      })
    ) {
      return null;
    }
    if (raw.segmentCount !== raw.segmentKeys.length) return null;
    segmentKeys = [...raw.segmentKeys];
    segmentCount = raw.segmentKeys.length;
  } else if (!single.test(raw.fileKey) || raw.segmentCount !== undefined) {
    return null;
  }

  const metadata = raw.metadata === undefined ? undefined : normalizeMetadata(raw.metadata);
  if (raw.metadata !== undefined && !metadata) return null;
  const expectedCount = segmentKeys?.length ?? 1;
  const files = raw.files === undefined ? undefined : normalizeFiles(raw.files, expectedCount);
  if (raw.files !== undefined && !files) return null;
  return {
    recordingId: raw.recordingId,
    fileKey: raw.fileKey,
    ...(segmentKeys ? { segmentKeys, segmentCount } : {}),
    ...(metadata ? { metadata } : {}),
    ...(files ? { files } : {}),
  };
}

export function clonePendingConfirm(value: PendingConfirm | null | undefined): PendingConfirm | null {
  if (!value) return null;
  return validatePendingConfirm({
    ...value,
    segmentKeys: value.segmentKeys ? [...value.segmentKeys] : undefined,
    metadata: value.metadata ? { ...value.metadata } : undefined,
    files: value.files ? value.files.map((file) => ({ ...file })) : undefined,
  });
}

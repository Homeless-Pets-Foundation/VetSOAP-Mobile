import type { Recording, RecordingMetadataField } from '../types';

export type MetadataFormMode = 'review' | 'add' | 'edit';
export type MetadataFormSeed = Record<RecordingMetadataField, string>;

const METADATA_FIELDS: RecordingMetadataField[] = [
  'patientName',
  'clientName',
  'species',
  'breed',
  'appointmentType',
];

function currentFieldValue(recording: Recording, field: RecordingMetadataField): string {
  const value = recording[field];
  return typeof value === 'string' ? value : '';
}

function extractedFieldValue(recording: Recording, field: RecordingMetadataField): string {
  const value = recording.aiExtractedMetadata?.fields?.[field]?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function hasAppliedMetadataFields(recording: Recording): boolean {
  const applied = recording.aiExtractedMetadata?.appliedFields;
  return Array.isArray(applied) && applied.length > 0;
}

export function buildMetadataFormSeed(
  recording: Recording,
  mode: MetadataFormMode
): MetadataFormSeed {
  const seed: MetadataFormSeed = {
    patientName: currentFieldValue(recording, 'patientName'),
    clientName: currentFieldValue(recording, 'clientName'),
    species: currentFieldValue(recording, 'species'),
    breed: currentFieldValue(recording, 'breed'),
    appointmentType: currentFieldValue(recording, 'appointmentType'),
  };

  const shouldSeedSuggestions =
    mode === 'add' || (mode === 'review' && !hasAppliedMetadataFields(recording));

  if (!shouldSeedSuggestions) {
    return seed;
  }

  for (const field of METADATA_FIELDS) {
    if (seed[field].trim()) continue;
    const suggested = extractedFieldValue(recording, field);
    if (suggested) {
      seed[field] = suggested;
    }
  }

  return seed;
}

type RecordingsCache = { pages?: unknown[] };
type RecordingsPage = { data?: unknown };

export function mergeUpdatedRecordingIntoRecordingsCache<T>(
  cache: T,
  updatedRecording: Recording
): T {
  if (!cache || typeof cache !== 'object') {
    return cache;
  }

  const candidate = cache as RecordingsCache;
  if (!Array.isArray(candidate.pages)) {
    return cache;
  }

  let changed = false;
  const pages = candidate.pages.map((page) => {
    if (!page || typeof page !== 'object') {
      return page;
    }

    const candidatePage = page as RecordingsPage;
    if (!Array.isArray(candidatePage.data)) {
      return page;
    }

    let pageChanged = false;
    const data = candidatePage.data.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }
      if ((item as { id?: unknown }).id !== updatedRecording.id) {
        return item;
      }

      pageChanged = true;
      changed = true;
      return { ...item, ...updatedRecording };
    });

    return pageChanged ? { ...page, data } : page;
  });

  return changed ? ({ ...cache, pages } as T) : cache;
}

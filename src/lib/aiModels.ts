// src/lib/aiModels.ts — pure selection logic for the reprocess model pickers.
// NO React Native imports; type-only import from '../types' so the .mjs
// transpile-and-import tests can load it (mirrors recording-permissions.test.mjs;
// a value import from '../types' would pull RN deps into the vm and break it).
import type { OrgAiModels, AiModelCategory, AiModelOption } from '../types';

export const FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL = 'nova-3';

function normalizeCategory(raw: unknown): AiModelCategory {
  const c = (raw ?? {}) as { default?: unknown; options?: unknown };
  const options: AiModelOption[] = Array.isArray(c.options)
    ? c.options.filter(
        (o): o is AiModelOption =>
          !!o &&
          typeof (o as { id?: unknown }).id === 'string' &&
          typeof (o as { label?: unknown }).label === 'string'
      )
    : [];
  const def =
    typeof c.default === 'string' && options.some((o) => o.id === c.default)
      ? (c.default as string)
      : (options[0]?.id ?? null);
  return { default: def, options };
}

// Rule 10 shape guard — tolerate null body / missing categories / bad option shapes.
export function normalizeOrgAiModels(raw: unknown): OrgAiModels {
  const r = (raw ?? {}) as { transcription?: unknown; soap?: unknown };
  return {
    transcription: normalizeCategory(r.transcription),
    soap: normalizeCategory(r.soap),
  };
}

// Both categories must be usable AND at least one must offer a real choice. Requiring a usable
// default in BOTH prevents the combined reprocess flow from rendering for an org that has, e.g.,
// multiple transcription models but zero usable SOAP providers (after BYOK/allow-list filtering) —
// which would initialize the missing selection to null and submit an unusable request the backend
// would reject.
export function hasSelectableModels(m: OrgAiModels): boolean {
  const transcriptionUsable = m.transcription.options.length >= 1 && m.transcription.default != null;
  const soapUsable = m.soap.options.length >= 1 && m.soap.default != null;
  const anyChoice = m.transcription.options.length > 1 || m.soap.options.length > 1;
  return transcriptionUsable && soapUsable && anyChoice;
}

export function hasVisibleReprocessModelChoice(
  m: OrgAiModels,
  options: { recordingForeignLanguage?: boolean } = {}
): boolean {
  return hasSelectableModels(getEffectiveReprocessModels(m, options.recordingForeignLanguage));
}

export type RecordingFailureRemedyCategory = 'transcription' | 'soap';
export const GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe';

// Local mapping references Connect's deriveSoapProviderFromModel and
// deriveRecordingTranscriptionProviderFromModel (organization.schema.ts).
// Unknown IDs never supply evidence of a distinct provider.
export function deriveModelProvider(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  if (modelId === 'nova-3' || modelId === 'nova-3-medical') return 'deepgram';
  if (modelId === GEMINI_TRANSCRIPTION_MODEL) return 'gemini';
  const prefixes = {
    'gemini-': 'gemini', 'claude-': 'anthropic', 'gpt-': 'openai',
    'glm-': 'z_ai', 'muse-spark-': 'meta',
  };
  return Object.entries(prefixes).find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? null;
}

export function normalizeForForeignLanguage(modelId: string | null, foreignLanguage?: boolean): string | null {
  return foreignLanguage && deriveModelProvider(modelId) === 'deepgram'
    ? FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL : modelId;
}

export function getEffectiveTranscriptionCategory(category: AiModelCategory, foreignLanguage?: boolean): AiModelCategory {
  if (!foreignLanguage) return category;
  return normalizeCategory({
    default: normalizeForForeignLanguage(category.default, true),
    options: category.options.filter((o) =>
      deriveModelProvider(o.id) !== 'deepgram' || o.id === FOREIGN_LANGUAGE_TRANSCRIPTION_MODEL),
  });
}

export function getEffectiveReprocessModels(models: OrgAiModels, foreignLanguage?: boolean): OrgAiModels {
  return { ...models, transcription: getEffectiveTranscriptionCategory(models.transcription, foreignLanguage) };
}

export function remedyRequiresDistinctProvider(errorCode?: string | null): boolean {
  return ['MISSING_DEEPGRAM_KEY', 'INVALID_DEEPGRAM_KEY', 'MISSING_TRANSCRIPTION_KEY',
    'INVALID_TRANSCRIPTION_KEY', 'MISSING_LLM_KEY', 'INVALID_LLM_KEY'].includes(errorCode ?? '');
}

export function pickRemedyModel(category: AiModelCategory, options: {
  excludeModelId?: string | null; requireDistinctProvider?: boolean;
} = {}): string | null {
  const excluded = options.excludeModelId === undefined ? category.default : options.excludeModelId;
  const provider = deriveModelProvider(excluded);
  if (options.requireDistinctProvider && provider) {
    const alternative = category.options.find((o) => {
      const candidate = deriveModelProvider(o.id);
      return candidate && candidate !== provider;
    });
    if (alternative) return alternative.id;
  }
  return category.options.find((o) => o.id !== excluded)?.id ?? category.default ?? category.options[0]?.id ?? null;
}

export function hasReprocessRemedyForCategory(models: OrgAiModels, category: RecordingFailureRemedyCategory,
  options: { recordingForeignLanguage?: boolean; requireDistinctProvider?: boolean } = {}
): boolean {
  const effective = getEffectiveReprocessModels(models, options.recordingForeignLanguage);
  if (!hasSelectableModels(effective)) return false;
  const choices = effective[category].options;
  return options.requireDistinctProvider
    ? new Set(choices.map((o) => deriveModelProvider(o.id)).filter(Boolean)).size > 1
    : new Set(choices.map((o) => o.id)).size > 1;
}

export interface ReprocessSelection {
  transcriptionModelId: string | null;
  soapModel: string | null;
}

export interface ReprocessSelectionOptions {
  recordingForeignLanguage?: boolean;
  remedyCategory?: RecordingFailureRemedyCategory | null;
  remedyErrorCode?: string | null;
}

export function getInitialReprocessSelection(models: OrgAiModels, options: ReprocessSelectionOptions = {}): ReprocessSelection {
  const effective = getEffectiveReprocessModels(models, options.recordingForeignLanguage);
  const selection = { transcriptionModelId: effective.transcription.default, soapModel: effective.soap.default };
  if (options.remedyCategory) {
    const model = pickRemedyModel(effective[options.remedyCategory], {
      excludeModelId: options.remedyErrorCode === 'AUDIO_TOO_LONG' ? GEMINI_TRANSCRIPTION_MODEL : undefined,
      requireDistinctProvider: remedyRequiresDistinctProvider(options.remedyErrorCode),
    });
    if (options.remedyCategory === 'transcription') selection.transcriptionModelId = model;
    else selection.soapModel = model;
  }
  return selection;
}

export function isReprocessSelectionValid(models: OrgAiModels, selection: ReprocessSelection): boolean {
  return models.transcription.options.some((o) => o.id === selection.transcriptionModelId) &&
    models.soap.options.some((o) => o.id === selection.soapModel);
}

// Reconcile refreshes without overwriting a still-valid manual choice.
export function reconcileReprocessSelection(models: OrgAiModels, selection: ReprocessSelection,
  options: ReprocessSelectionOptions = {}): ReprocessSelection {
  const effective = getEffectiveReprocessModels(models, options.recordingForeignLanguage);
  const initial = getInitialReprocessSelection(models, options);
  const transcription = normalizeForForeignLanguage(selection.transcriptionModelId, options.recordingForeignLanguage);
  return {
    transcriptionModelId: effective.transcription.options.some((o) => o.id === transcription)
      ? transcription : initial.transcriptionModelId,
    soapModel: effective.soap.options.some((o) => o.id === selection.soapModel) ? selection.soapModel : initial.soapModel,
  };
}

// "Currently: …" label. costBreakdown values may be a raw id or a model string not in options —
// fall back to the raw value so the subline never renders blank.
export function getCurrentModelLabel(
  currentId: string | null | undefined,
  cat: AiModelCategory
): string {
  if (!currentId) return '';
  return cat.options.find((o) => o.id === currentId)?.label ?? currentId;
}

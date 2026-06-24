// src/lib/aiModels.ts — pure selection logic for the reprocess model pickers.
// NO React Native imports; type-only import from '../types' so the .mjs
// transpile-and-import tests can load it (mirrors recording-permissions.test.mjs;
// a value import from '../types' would pull RN deps into the vm and break it).
import type { OrgAiModels, AiModelCategory, AiModelOption } from '../types';

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

// "Currently: …" label. costBreakdown values may be a raw id or a model string not in options —
// fall back to the raw value so the subline never renders blank.
export function getCurrentModelLabel(
  currentId: string | null | undefined,
  cat: AiModelCategory
): string {
  if (!currentId) return '';
  return cat.options.find((o) => o.id === currentId)?.label ?? currentId;
}

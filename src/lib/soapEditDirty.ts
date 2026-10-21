/**
 * Tracks which SOAP sections hold an unsaved edit, and reports only the
 * any-section-dirty TRANSITIONS — so the recording detail screen re-renders
 * when a guard has to arm or disarm, never per keystroke.
 *
 * Why (UI/UX audit 2026-10-21, UX-H5): a section edit lived only in the
 * section's local state, and no back path on the detail screen guarded it —
 * Back, Android hardware back or an iOS swipe silently threw away typed
 * clinical text.
 */
export interface SoapDirtyTracker {
  /** Record one section's dirty state; fires `onChange` only when "any dirty" flips. */
  set(sectionKey: string, dirty: boolean): void;
  isDirty(): boolean;
}

export function createSoapDirtyTracker(onChange: (anyDirty: boolean) => void): SoapDirtyTracker {
  const dirtySections = new Set<string>();
  return {
    set(sectionKey, dirty) {
      const before = dirtySections.size > 0;
      if (dirty) dirtySections.add(sectionKey);
      else dirtySections.delete(sectionKey);
      const after = dirtySections.size > 0;
      if (before !== after) onChange(after);
    },
    isDirty() {
      return dirtySections.size > 0;
    },
  };
}

/** A section is dirty only while it is being edited AND differs from the saved text. */
export function isSoapSectionDirty(
  isEditing: boolean,
  draft: string,
  savedContent: string | null | undefined,
): boolean {
  return isEditing && draft !== (savedContent ?? '');
}

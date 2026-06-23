# Move "Foreign Language" toggle out of patient details — 2026-06-23

## Change

Moved the `Foreign Language` toggle out of the patient-details form into its own
standalone section that renders **directly below** the Patient Details card.

### Files

- `src/components/PatientForm.tsx` — removed the `Toggle` JSX block and the now-unused
  `Toggle` import.
- `src/components/PatientSlotCard.tsx` — added `Toggle` import; defined a
  `foreignLanguageCard` element (a `Card` wrapping the toggle); rendered it
  immediately after `formCard` in **both** layout branches:
  - classic (`!recordFirstEnabled`): Patient Information → Foreign Language → Record
  - record-first (`recordFirstEnabled`): Record → Patient Details (collapsible) → Foreign Language

## Why

In record-first mode the patient-details card collapses, which previously hid the
toggle. As its own section directly below patient details, it stays visible
regardless of collapse state.

## Data flow (unchanged)

`slot.formData.foreignLanguage` → `handleUpdateForm('foreignLanguage', value)` →
`onUpdateForm`. Validation (`src/lib/validation.ts`), draft serialization
(`src/lib/draftRecordings.ts`), and API payload (`src/api/recordings.ts`) untouched.

## Audit — 2 passes, zero issues

1. Self: `tsc --noEmit` clean, eslint clean, no orphaned refs, render conditions
   mutually exclusive (no duplicate), sync void callback (no RN async-crash risk).
2. Adversarial reviewer subagent: no issues across orphaned refs, dup render,
   data binding, async-callback rule, placement logic, unused imports.

Not committed.

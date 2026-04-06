# Touch & Scroll Reliability — Design Spec

**Date:** 2026-04-06
**Status:** Approved
**Platform:** Android only (iOS not yet built)

---

## Context

Users report two related interaction problems that appear throughout the app, worst on the record screen:

1. **Scroll blocked near interactive elements** — When scrolling within a patient card, if the finger starts on or near a species selector, appointment type grid, or template pill, the scroll gesture doesn't register. The user must move their finger to a blank area of the screen to scroll.

2. **Button taps don't always register** — Pressable buttons (species, appointment type, Record, Finish, and general app-wide buttons) occasionally fail to fire `onPress`, especially with light or slightly off-center taps.

### Root Causes

**Scroll conflict:** `PatientSlotCard` uses React Native's built-in `ScrollView`, which on Android does not coordinate with `Pressable` children via the native gesture recognizer. When a touch starts on a `Pressable`, Android's responder system claims it for that element before the `ScrollView` can detect scroll intent. The species/appointment type grids cover enough vertical space that most scroll attempts begin on a button.

**Tap misses:** Most `Pressable` elements have no `hitSlop` (tap target = exact visual size) and no `pressRetentionOffset` (press cancels if finger drifts even 1px outside the element boundary).

---

## Design

### Change 1 — RNGH ScrollView in PatientSlotCard

**File:** `src/components/PatientSlotCard.tsx`

Swap the `ScrollView` import from `react-native` to `react-native-gesture-handler`. RNGH's `ScrollView` is API-compatible — all existing props (`contentContainerStyle`, `keyboardShouldPersistTaps="handled"`, `showsVerticalScrollIndicator`) continue unchanged. On Android, RNGH's version uses the native gesture recognizer, which properly discriminates scroll intent from tap-on-Pressable. This is the same mechanism already used correctly in `TrimOverlay.tsx`.

```ts
// Before
import { ScrollView } from 'react-native';

// After
import { ScrollView } from 'react-native-gesture-handler';
```

No other changes needed in this file.

### Change 2 — Global button touch targets

**File:** `src/components/ui/Button.tsx`

Add `hitSlop` and `pressRetentionOffset` to the root `Pressable`:

- `hitSlop={12}` — extends the tap zone 12pt beyond the visual edge on all sides
- `pressRetentionOffset={{ top: 10, bottom: 10, left: 10, right: 10 }}` — keeps the press active if the finger drifts up to 10pt outside the button during a tap

These two props together eliminate the "light off-center tap does nothing" failure mode. Since nearly every user-facing button in the app flows through this component, this is a global fix.

### Change 3 — Form selector touch targets

**File:** `src/components/PatientForm.tsx`

Add `hitSlop={8}` to the `Pressable` elements that currently have none:
- Appointment type grid buttons (4 buttons — currently no hitSlop)
- Template pill buttons in the horizontal scroll row (currently no hitSlop)

The species selector buttons already have `hitSlop={8}` — leave them unchanged.

### Change 4 — Tab strip touch targets

**File:** `src/components/PatientTabStrip.tsx`

Add `hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}` to the patient tab `AnimatedPressable` elements. The "Add patient" button already has this — the regular patient tabs do not.

---

## What Is Not Changing

- `app/(app)/(tabs)/record.tsx` — FlatList pager works correctly per user testing
- `src/components/PatientTabStrip.tsx` horizontal ScrollView — works correctly
- `src/components/TrimOverlay.tsx` — already uses RNGH gestures correctly
- `keyboardShouldPersistTaps="handled"` on PatientSlotCard — correct, leave as-is
- No new dependencies — `react-native-gesture-handler` v2.30.1 is already installed

---

## Verification

1. **Scroll from anywhere** — On the record screen, scroll the patient card starting from directly on top of the species buttons and appointment type grid. Scroll should register regardless of where the finger starts.
2. **Off-center taps** — Tap species, appointment type, and template pills at the edges of each button. All should register.
3. **Light tap on Record/Finish** — Quick light tap on the main action buttons. Should fire reliably.
4. **No regressions** — Verify: card still scrolls to bottom, template pills still scroll horizontally, keyboard dismisses correctly, horizontal pager swipe between patients unaffected.
5. **Global button spot-check** — Test buttons on at least one other screen (recordings list, login) to confirm `Button.tsx` hitSlop improvement is felt app-wide.

# Touch & Scroll Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix scroll-blocking and tap-miss issues on Android by swapping the patient card's `ScrollView` to RNGH's gesture-coordinated version and standardising `hitSlop`/`pressRetentionOffset` across all interactive elements.

**Architecture:** Replace `react-native`'s `ScrollView` in `PatientSlotCard` with the drop-in equivalent from `react-native-gesture-handler` (already installed, v2.30.1) — this makes the native gesture recognizer properly discriminate scroll intent from button taps. Add consistent `hitSlop` (12pt on shared `Button`, 8pt on inline `Pressable` elements) and `pressRetentionOffset` on `Button` to prevent tap cancellation on slight finger drift.

**Tech Stack:** React Native 0.83.4, Expo SDK 55, `react-native-gesture-handler` v2.30.1, `react-native-reanimated` v4.2.1, NativeWind v4.

---

## Files Modified

| File | Change |
|------|--------|
| `src/components/PatientSlotCard.tsx` | Swap `ScrollView` import to RNGH |
| `src/components/ui/Button.tsx` | Add `hitSlop={12}` + `pressRetentionOffset` |
| `src/components/PatientForm.tsx` | Add `hitSlop={8}` to appointment type + template pill `Pressable`s |
| `src/components/PatientTabStrip.tsx` | Add `hitSlop={8}` to patient tab `AnimatedPressable`s; increase add-button hitSlop to match |

---

## Task 1: Swap ScrollView in PatientSlotCard to RNGH

**Files:**
- Modify: `src/components/PatientSlotCard.tsx:2`

- [ ] **Step 1: Update the import**

  Open `src/components/PatientSlotCard.tsx`. Line 2 currently reads:

  ```tsx
  import { View, Text, ScrollView, Pressable } from 'react-native';
  ```

  Change it to:

  ```tsx
  import { View, Text, Pressable } from 'react-native';
  import { ScrollView } from 'react-native-gesture-handler';
  ```

  No other changes in this file. The `ScrollView` JSX at line 150 and all its props (`style`, `contentContainerStyle`, `showsVerticalScrollIndicator`, `keyboardShouldPersistTaps`) are identical — RNGH's `ScrollView` accepts the same props.

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors (or only pre-existing errors unrelated to this file).

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/PatientSlotCard.tsx
  git commit -m "fix(touch): swap PatientSlotCard ScrollView to RNGH for gesture coordination"
  ```

---

## Task 2: Add hitSlop and pressRetentionOffset to shared Button

**Files:**
- Modify: `src/components/ui/Button.tsx:86-96`

- [ ] **Step 1: Update the AnimatedPressable props**

  Open `src/components/ui/Button.tsx`. The `AnimatedPressable` block starts at line 86. Replace it so it reads:

  ```tsx
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
      hitSlop={12}
      pressRetentionOffset={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || children}
      accessibilityState={{ disabled: disabled || loading }}
      className={`rounded-btn items-center justify-center flex-row min-h-[44px] ${variant !== 'ghost' ? 'shadow-btn' : ''} ${v.container} ${s.container} ${disabled || loading ? 'opacity-50' : ''}`}
      style={animatedStyle}
      {...rest}
    >
  ```

  The two new props (`hitSlop` and `pressRetentionOffset`) are placed before the `accessibilityRole` and after `disabled` so they can be overridden by `{...rest}` if a caller ever needs a different value.

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors related to `Button.tsx`.

- [ ] **Step 3: Commit**

  ```bash
  git add src/components/ui/Button.tsx
  git commit -m "fix(touch): add hitSlop and pressRetentionOffset to shared Button"
  ```

---

## Task 3: Add hitSlop to inline Pressables in PatientForm

**Files:**
- Modify: `src/components/PatientForm.tsx:53` (template pills)
- Modify: `src/components/PatientForm.tsx:190` (appointment type grid)

- [ ] **Step 1: Add hitSlop to template pill Pressables**

  In `src/components/PatientForm.tsx`, locate the template pill `Pressable` starting at line 53. It currently has no `hitSlop`. Add `hitSlop={8}` after the `accessibilityHint` prop:

  ```tsx
  <Pressable
    key={template.id}
    onPress={() => handleTemplateSelect(template)}
    accessibilityRole="radio"
    accessibilityState={{ selected: isSelected }}
    accessibilityLabel={template.name}
    accessibilityHint={template.description || undefined}
    hitSlop={8}
    className={`px-3.5 min-h-[44px] justify-center rounded-pill border ${
      isSelected
        ? 'border-brand-500 bg-brand-500'
        : 'border-stone-300 bg-white'
    }`}
  >
  ```

- [ ] **Step 2: Add hitSlop to appointment type Pressables**

  Locate the appointment type `Pressable` starting at line 190. It currently has no `hitSlop`. Add `hitSlop={8}` after the `accessibilityState` prop:

  ```tsx
  <Pressable
    onPress={() => {
      Haptics.selectionAsync().catch(() => {});
      if (!isSelected) onUpdate('appointmentType', type);
    }}
    accessibilityRole="radio"
    accessibilityState={{ selected: isSelected }}
    accessibilityLabel={type}
    hitSlop={8}
    className={`min-h-[44px] items-center justify-center rounded-btn border ${
      isSelected
        ? 'border-brand-500 bg-brand-500'
        : 'border-stone-300 bg-white'
    }`}
  >
  ```

  Note: the species `Pressable` (line 137) already has `hitSlop={8}` — leave it unchanged.

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors related to `PatientForm.tsx`.

- [ ] **Step 4: Commit**

  ```bash
  git add src/components/PatientForm.tsx
  git commit -m "fix(touch): add hitSlop to appointment type and template pill Pressables"
  ```

---

## Task 4: Add hitSlop to patient tabs in PatientTabStrip

**Files:**
- Modify: `src/components/PatientTabStrip.tsx:144` (patient tab AnimatedPressable)
- Modify: `src/components/PatientTabStrip.tsx:182` (add-patient button)

- [ ] **Step 1: Add hitSlop to patient tab AnimatedPressables**

  In `src/components/PatientTabStrip.tsx`, the `AnimatedPressable` for each patient tab starts at line 144. It currently has no `hitSlop`. Add `hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}` after the `accessibilityLiveRegion` prop:

  ```tsx
  <AnimatedPressable
    key={slot.id}
    entering={FadeIn.duration(150)}
    exiting={FadeOut.duration(120)}
    layout={TAB_LAYOUT_TRANSITION}
    onPress={() => handleTabPress(index)}
    onLayout={(e) => {
      tabPositions.current[index] = {
        x: e.nativeEvent.layout.x,
        width: e.nativeEvent.layout.width,
      };
    }}
    accessibilityRole="tab"
    accessibilityState={{ selected: isActive }}
    accessibilityLabel={`${label}, ${status}`}
    accessibilityLiveRegion="polite"
    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    className={`px-3.5 min-h-[44px] flex-row items-center justify-center rounded-pill border ${
      isActive
        ? 'border-brand-500 bg-brand-500'
        : 'border-stone-300 bg-white'
    }`}
  >
  ```

- [ ] **Step 2: Increase add-patient button hitSlop to match**

  The "Add patient" `Pressable` at line 182 currently has `hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}`. Increase it to 8 to be consistent:

  ```tsx
  <Pressable
    onPress={handleAddPress}
    accessibilityRole="button"
    accessibilityLabel="Add patient"
    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    className="w-[44px] h-[44px] items-center justify-center rounded-full border border-dashed border-stone-400 bg-white"
  >
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors related to `PatientTabStrip.tsx`.

- [ ] **Step 4: Commit**

  ```bash
  git add src/components/PatientTabStrip.tsx
  git commit -m "fix(touch): add consistent hitSlop to patient tab and add-patient Pressables"
  ```

---

## Task 5: Manual verification on Android emulator

- [ ] **Step 1: Start the emulator and Metro**

  ```bash
  "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/emulator/emulator.exe" -avd Medium_Phone_API_36.1 -no-snapshot-load &>/dev/null &
  ```

  Wait ~30 seconds, then:

  ```bash
  "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" devices
  "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" reverse tcp:8081 tcp:8081
  npx expo start --clear
  ```

- [ ] **Step 2: Test scroll from on top of buttons**

  Navigate to the record screen. Place your finger directly on the species selector (Canine/Feline row) and scroll down. Scroll should register from the first touch — no longer need to start the scroll from a blank area of the screen.

  Repeat with the appointment type grid (4-button 2×2 grid). Same result expected.

- [ ] **Step 3: Test off-center taps**

  Tap the species buttons and appointment type buttons at their edges (not center). All should register on the first tap.

  Tap template pills at the edges. Same expectation.

- [ ] **Step 4: Test Record and Finish buttons**

  Do a quick light tap on the Record button (large circle). Should fire reliably. Repeat with Finish, Pause, Resume.

- [ ] **Step 5: Verify no regressions**

  - [ ] Card still scrolls fully to the bottom to reveal all fields
  - [ ] Template pills horizontal scroll still works
  - [ ] Keyboard still dismisses when tapping a form field (keyboardShouldPersistTaps="handled" unchanged)
  - [ ] Horizontal pager swipe between patients works as before
  - [ ] Patient tab strip scrolls and taps work

- [ ] **Step 6: Spot-check another screen**

  Navigate to the recordings list or login screen and test any buttons. Confirm the `Button.tsx` hitSlop improvement is felt globally.

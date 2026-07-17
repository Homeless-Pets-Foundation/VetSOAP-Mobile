# Captivet Mobile — Full UI/UX Audit

**Date:** 2026-07-17
**Scope:** Every screen in `app/` and every component in `src/components/` (including `src/components/ui/`), plus cross-cutting concerns: design tokens, dark mode, accessibility, font scaling, copy, and the documented Android text-clipping gotcha.
**Method:** Five parallel code-review passes (auth, core recording flow, recordings/SOAP consumption, home/settings/secondary screens, design system), followed by spot-verification of all top-severity claims against the source. Every finding cites the file and line it was observed at.

**Severity key:**
- **High** — blocks or actively misleads users, destroys work, or is an accessibility blocker.
- **Medium** — real friction, inconsistency, or a half-wired pattern.
- **Low** — polish.

---

## Executive summary

The app's bones are unusually good. The design system is mature (semantic CSS-var tokens with real working dark mode, 16 shared primitives with strong accessibility defaults, centralized haptics/async-safety, a copy catalog, near-zero hardcoded color), data safety in the recording flow is exceptional (auto-draft, auto-stash, interruption capture, orphan sweeps), and destructive flows like sign-out-with-unsent-work and delete-account are best-in-class. The documented Android single-word text-clipping mitigation is applied with impressive discipline almost everywhere.

The problems cluster at the **seams**, not the centers:

1. **The auth flow has broken plumbing.** The login screen has no "Forgot password?" link at all — that screen is unreachable. Both password-reset screens ignore the error Supabase returns and show **false success**. An Apple sign-in handler is fully wired but no button renders it (an App Store 4.8 rejection risk). Autofill props are missing from the primary sign-in form.
2. **Discard paths haven't caught up with the draft-persistence model.** Three flows (nav-away guard, resume-stash replace, and their shared discard routine) still threaten — and actually delete — recordings the system has already made durable as drafts, contradicting the draft-save-on-finish contract.
3. **Silent state transitions in the recording flow.** Swiping to another patient auto-pauses a live recording with only a haptic; a durable-capture interruption (phone call) silently finalizes the recording. In both cases a vet keeps talking while nothing records.
4. **A handful of accessibility patterns are half-wired system-wide.** `content-tertiary` text fails WCAG contrast in light mode across ~120 usages; 17 sites disable font scaling outright instead of capping it; `accessibilityLiveRegion` (Android-only) is used where iOS VoiceOver needs `announceForAccessibility`; several `adjustable` roles have no actions wired.
5. **The shared `Button` doesn't implement the project's own clipping fix**, which is actively pushing screens back to raw Pressables and string-level hacks (`'Reprocess '` with a trailing space in the copy catalog).

**Counts:** 17 High, ~60 Medium, ~65 Low findings.

---

## Top 10 priority fixes

| # | Fix | Why first |
|---|-----|-----------|
| 1 | Add "Forgot password?" link to login (`app/(auth)/login.tsx`) | Password-reset flow is currently unreachable |
| 2 | Check the `{ error }` returned by `resetPasswordForEmail` / `updateUser` (`forgot-password.tsx:35`, `reset-password.tsx:31`) | Users are shown success when the operation failed; reset-password users believe a password works that was never set |
| 3 | Stop discarding committed drafts in the nav-away guard and resume-stash replace paths (`record.tsx:1273-1326`, `record.tsx:3961-3978`) | Deletes work the product promises is durable; direct "Lela bug" adjacency |
| 4 | Surface swipe auto-pause and durable-interruption finalize visibly (`record.tsx:1344-1363`, `record.tsx:1049-1070`) | Lost exam audio is the worst outcome this app can produce |
| 5 | Render the Apple sign-in button on iOS (`login.tsx`) | Handler exists; missing button is an App Store guideline 4.8 rejection risk |
| 6 | Fix `durable-recovery.tsx` nonexistent theme tokens (`bg-surface-base`, `text-content-strong`, `text-content-muted`) | The crash-recovery screen renders unthemed/broken-contrast |
| 7 | Darken light-mode `--color-content-tertiary` (stone-400 → ~stone-500) in `global.css` | 2.4:1 contrast across ~120 usages of real content (subtitles, empty states, help text) |
| 8 | Bake the Android clipping mitigation into `ui/Button.tsx` and `ui/Banner.tsx` CTA | Removes the incentive to bypass shared components; Banner currently violates the repo's own rule |
| 9 | Add a sign-out escape hatch to `DeviceLimitModal` | Users unwilling to revoke a colleague's device are permanently stuck |
| 10 | Fix `UploadOverlay` batch progress math (`completedCount` counts prior uploads) | Trust-eroding "Recording 2 of 2 / 50%" at the start of a batch |

---

## Cross-cutting themes

### A. Font scaling is disabled, not managed
17 `allowFontScaling={false}` sites and **zero** `maxFontSizeMultiplier` anywhere. Low-vision users get frozen 12–15px text on exactly the dense screens where they need scaling (SOAP actions, audio player, destructive-action labels, status badges). **Fix once globally:** replace with `maxFontSizeMultiplier={1.3}`; the render-patch in `app/_layout.tsx:41-61` is the ideal injection point for a global default cap.

### B. Live-region announcements are Android-only
State changes (recording started/paused, upload done, copy confirmations) rely on `accessibilityLiveRegion`, which iOS ignores. VoiceOver users get silence on recorder state transitions. **Fix:** call `AccessibilityInfo.announceForAccessibility` at the transition sites; add `accessibilityLiveRegion="polite"` to the copy-status texts that lack it (`ExportSheet.tsx:169`, `ClientEmailCard.tsx:155`, `TranslationCard.tsx:163`, `SoapNoteView.tsx:62-72`).

### C. Terminology fragmentation for un-submitted work
Users encounter four vocabularies for the same concept: "Save for Later" / "Saved Sessions" (stash), "Draft … pending upload" (banner), "Not Submitted" (home cards), "Saving recording…" (finish) — each with different recovery paths. Also "Records" (tab label) vs "Recordings" (every screen), and "CaptiVet" (`ProviderIssueBanner.tsx:38`) vs "Captivet" everywhere else. **Fix:** consolidate on two user-facing concepts (e.g. "Saved sessions" and "Not submitted") and align all banner/alert copy.

### D. Copy-confirmation feedback is three different patterns
Animated "Copied!" toast (SoapNoteView/TranscriptView), shared `Toast` (detail screen), and a tiny persistent caption line that never auto-clears (ExportSheet, ClientEmailCard, TranslationCard). **Fix:** standardize on the auto-dismissing toast pattern near the tapped control.

### E. Raw error strings leak to users
`[ApiError 500] <message>` on the home dashboard (`index.tsx:423-427`), raw `error.message` in the DeviceLimitModal revoke alert (`DeviceLimitModal.tsx:150-155`), raw server `errorMessage.slice(0,200)` on the failed recording detail (`[id].tsx:982-984`), raw upload error fallthrough (`record.tsx:2733-2737`). The MFA policy module already demonstrates the right pattern (code → safe copy). **Fix:** map known codes to friendly strings; put technical detail behind "Copy details for support."

### F. Shared-component bypass erodes consistency
54 raw `<Pressable>` in 18 files outside `ui/` vs 94 shared Button/IconButton usages. Role coverage on the raw ones is decent, but haptics are inconsistent (`patient/[id].tsx`, `RecordingAudioPlayer.tsx`, `PatientSlotCard.tsx` have zero haptics; `audio-editor.tsx` hand-rolls them). Root cause is partly #8 above — Button lacking the clipping fix forces bypasses. **Fix:** fix Button/Banner, then do an adoption pass; consider a `Chip`/`PressableRow` primitive for the icon-only and chip-shaped cases.

---

## Findings by area

### 1. Authentication (login, forgot/reset password, MFA, app lock, device limit)

**High**
- `app/(auth)/login.tsx` (whole file) — No "Forgot password?" link anywhere (no router/Link import at all); `forgot-password.tsx` is unreachable. Add a link under the password field.
- `app/(auth)/forgot-password.tsx:35-38` — `resetPasswordForEmail()` returns `{ error }` (supabase-js v2 doesn't throw); the error is ignored and `setEmailSent(true)` runs unconditionally — rate-limit/network failures show "Check your email." Destructure and branch on `error`.
- `app/(auth)/reset-password.tsx:31-54` — Same bug, worse: a failed `updateUser({ password })` (policy reject, expired recovery session) still shows "Password updated" and signs the user out — they now believe a password works that was never set. Check `error` before success.
- `app/(auth)/login.tsx:185-215` — Email/password inputs lack `autoComplete`/`textContentType`, so password-manager autofill never triggers on the primary sign-in form (forgot-password.tsx:104 proves the pattern exists). Add the autofill props.
- `src/components/DeviceLimitModal.tsx:167-173` — Hard-block modal with `onRequestClose={() => {}}` and only Revoke/Retry actions; a user unwilling to revoke a colleague's device is permanently stuck. Add a "Sign out" ghost button (AppLockGuard already models the escape hatch).
- `app/(auth)/login.tsx:236-249` — `handleSocial('apple')` is fully implemented and the Google button even guards on `socialProvider === 'apple'`, but no Apple button renders — iOS users get no Apple option and offering Google without Apple risks App Store guideline 4.8 rejection. Render an Apple button on iOS.

**Medium**
- `login.tsx:185-215` — No return-key chain (`returnKeyType="next"` → focus password → `"go"` submits); mfa.tsx:311-314 does this correctly. Add refs.
- `login.tsx:132-136` — Form isn't in a ScrollView; with keyboard open on small phones/landscape the Sign In button can be clipped with no way to reach it. Wrap in ScrollView + `keyboardShouldPersistTaps="handled"` like mfa.tsx:261.
- `forgot-password.tsx:2`, `reset-password.tsx:2` — Deprecated RN-core `SafeAreaView` (iOS-only) and no KeyboardAvoidingView on either screen. Migrate to safe-area-context + KAV + ScrollView.
- `reset-password.tsx:18-27` — Blocking `Alert.alert` validation (login/mfa use inline banners) and no show/hide-password toggle on the one screen where typos permanently matter. Use inline errors + the eye toggle.
- `reset-password.tsx:114-122` — Cancel calls `router.back()` without `clearPasswordRecovery()`; via the recovery deep link the back stack may be empty and `isPasswordRecovery` suppresses the authenticated redirect — user stranded in the auth stack. Clear recovery state and `router.replace`.
- `login.tsx:41-45,72` — Lockout message is a static snapshot with no countdown; button stays enabled. Add a ticking countdown or disable with remaining seconds.
- `DeviceLimitModal.tsx:150-155` — Raw API `error.message` in the revoke-failure alert. Map to friendly copy; log the raw error.
- `DeviceLimitModal.tsx:97-113` — Failed `retryDeviceRegistration()` gives zero feedback (footer text just disappears). Show "Still at the device limit."
- `src/components/DeviceRegistrationBanner.tsx:44-49` — Retry Pressable: no role/label/state, ~33-36pt target. Use shared Button `size="sm"` or add role + hitSlop.
- `DeviceRegistrationBanner.tsx:19-26` — Retry failure swallowed (`.catch(() => false)`); spinner stops, banner unchanged. Announce failure.
- `src/components/AppLockGuard.tsx:198-202` — Cold-start biometric renders a fully blank view (up to the 12s watchdog) — reads as a frozen app. Show logo + ActivityIndicator (no PHI).
- `app/(auth)/mfa.tsx:156-157` — Generic bootstrap failure sets `mode='challenge'` with no challenge started; Verify can only fail again. Show "Couldn't load verification — Retry."
- `forgot-password.tsx:47-78` — Success screen has no "Resend email"; non-delivery forces restarting the flow. Add resend with cooldown.
- `DeviceLimitModal.tsx:267` — `allowFontScaling={false}` on the destructive "Revoke" label. Use `maxFontSizeMultiplier`.

**Low**
- `login.tsx:146-153` — Subtitle `numberOfLines={1}` + `adjustsFontSizeToFit` shrinks instead of wrapping under large fonts. Allow 2 lines.
- `login.tsx:230-249` — "or continue with" divider precedes a single provider; Google button renders even when unconfigured (press → "not configured" error). Hide when `isGoogleSignInAvailable` is false.
- `app/(auth)/_layout.tsx:12-18` — Full-screen loading spinner has no accessibility label. Add one.
- `forgot-password.tsx:62` — "Click the link" → "Tap the link."
- `mfa.tsx:359-367` — TOTP setup key is long-press-select only; app already has `secureClipboard`. Add a "Copy setup key" button.
- `mfa.tsx:337,408` — "Restart" is ambiguous. Rename "Start over."
- `AppLockGuard.tsx:204-240` — No announcement when the lock engages; cancelled biometric gives no hint. Announce "App locked" + show "Try again" hint.
- `DeviceRegistrationBanner.tsx:37` — Title `numberOfLines={1}` truncates at large font scale. Allow 2 lines.
- `login.tsx:185` — No `autoFocus` on email (weigh against entry animation).
- `mfa.tsx:353-358` — QR code has no accessibility props; screen readers skip it silently. Label the container.

*Clipping gotcha:* correctly mitigated in `DeviceLimitModal.tsx:258-271` and `DeviceRegistrationBanner.tsx:53-58`; no new risky patterns in this slice.

---

### 2. Core recording flow (record.tsx, audio editor, stash/draft UX)

**High**
- `record.tsx:1344-1363` — Swiping/tabbing to another patient silently auto-pauses a live recording (selection haptic only); an accidental swipe mid-exam means the vet keeps talking while nothing records. Show a prominent "Recording for {patient} paused" toast/banner, or keep recording across slot switches.
- `record.tsx:1301-1326` + `discardCurrentSession` (1273-1289) — Nav-away guard counts already-drafted recordings as "unsubmitted… Leaving will discard them," and Discard actually deletes server + local drafts — contradicting the draft-save-on-finish contract (record.tsx:3751-3756's `trulyUnsaved` predicate treats drafted slots as durable). Exclude committed-draft slots from `unsavedCount` or change Discard to "Keep as draft."
- `record.tsx:3961-3978` — Resume-stash "Replace" runs full `discardCurrentSession()`, deleting auto-saved drafts the Load-Draft path (3722-3784) deliberately preserves via `preserveDraftSlotIds`. Pass the same preserve list here.
- `record.tsx:1049-1070` — Durable-capture interruption (call/alarm) silently finalizes the recording: haptic only, no banner, no pending-resume — the card flips to "Recording Complete" with no explanation, mid-exam. Show the explanatory banner the legacy path has (4240-4251).
- `src/components/UploadOverlay.tsx:80-95` — `completedCount` counts all session slots with `uploadStatus === 'success'`, including pre-batch uploads, so Submit All can start at 50% showing "Recording 2 of 2." Count only the current batch's slot IDs.

**Medium**
- `UploadOverlay.tsx:57-74` — `confirmedIdsRef` starts empty each open, so previously-uploaded slots fire a stale "{old patient} uploaded" toast at the start of a new upload. Seed the ref on `visible`.
- `UploadOverlay.tsx` (whole) — Full-screen scrim with no Cancel blocks the app for a potentially many-minute sequential 10-slot upload; only escape is killing the app. Add Hide/background or safe cancel for not-yet-started slots.
- `record.tsx:2229-2239` + `strings.ts:32-39` — Silent-check dialog says to verify audio "in Edit Recording," but Edit is blocked for durable recordings (record.tsx:4025-4031). Add a durable-specific body string.
- `src/components/PatientSlotCard.tsx:616-620` — "Processing usually takes 1-2 minutes." shows as soon as recording stops, before Submit, implying the SOAP note is already generating. Gate on `uploadStatus === 'success'`.
- `src/components/PatientTabStrip.tsx:37-71` — Recorded-not-submitted and uploaded both render the same green dot; indistinguishable at a glance. Use amber for recorded-not-submitted (matches Home's "Not Submitted").
- `PatientSlotCard.tsx:263,442-468` — In non-record-first mode the mic is just grayed out until 4 fields are filled; the reason lives only in the accessibilityLabel. Add a visible caption.
- `PatientSlotCard.tsx:338-343` — Slot form ScrollView has no keyboard avoidance; iOS keyboard can cover Breed/Appointment Type. Add KAV or `automaticallyAdjustKeyboardInsets`.
- `src/components/TrimOverlay.tsx:427-447`, `StaticWaveform.tsx:104-106`, `record.tsx:4286-4291` — `accessibilityRole="adjustable"` without `accessibilityActions`/handler: screen readers announce adjustable but swipes do nothing. Wire increment/decrement or downgrade the role.
- `PatientSlotCard.tsx:379`, `record.tsx:4240` — State announcements use Android-only `accessibilityLiveRegion`; iOS VoiceOver hears nothing. Use `AccessibilityInfo.announceForAccessibility`.
- `UploadOverlay.tsx:139-147` — `alert` + assertive live region with the live percentage in the label re-announces on nearly every tick. Announce once; let the inner progressbar carry the value.
- `PatientSlotCard.tsx:104-108`, `RecorderLiveReadout.tsx:19-23`, `audio-editor.tsx:22-26` — Timers are MM:SS with no hours; a 2-hour recording (explicitly supported) reads "120:00." Switch to H:MM:SS at ≥60min.
- `audio-editor.tsx:394-431` — Opening with multiple segments auto-concatenates without asking, sets `hasChanges=true` immediately (Done commits a merge the user never requested; Back shows "Discard Changes?" with no user edit). Make merge explicit or defer `hasChanges` to a real edit.
- `PatientSlotCard.tsx:361,503,541,573,599` — `allowFontScaling={false}` on Remove / "Delete & Start Over." Use `maxFontSizeMultiplier={1.3}`.
- Terminology fragmentation (see cross-cutting theme C).
- `record.tsx:4204` — "Saved Full" disabled button with no explanation of the 5-stash limit or remedy. Explain on tap or in the label.

**Low**
- `record.tsx:3613-3620` — "Save for Later?" confirmation on a non-destructive, reversible action adds friction; keep the confirm only for the stop-live-recorder variant.
- `record.tsx:2733-2737` — `uploadError` falls through to raw `error.message`. Map unknown errors to friendly copy.
- `record.tsx:4247-4249` — Banner always says "paused for call"; Android focus loss also fires for alarms/other apps. Generalize.
- `strings.ts:75` — "connect to Wi-Fi to sync" is wrong; cellular syncs too. "Connect to the internet."
- `audio-editor.tsx:1395-1401` — "No recording to edit." branch has no back button (header is in the main branch only). Render the header here too.
- `audio-editor.tsx:1499-1511, 236-251` — Merge arrow (~40pt) and segment-delete × (~36pt) under 44pt, nested in a draggable tab. Enlarge hitSlop.
- `audio-editor.tsx:1576-1591` — Nudge buttons ~36pt; they're also the accessible fallback for gesture-only trim handles. Reach 44pt.
- `TrimOverlay.tsx:14,530-546` — Fixed 64px time badge can clip "MM:SS.mmm." Use `minWidth` + auto-size.
- `WaveformEditor.tsx:156-261` — Pinch-zoom/two-finger-pan/double-tap are undiscoverable. Add a transient hint or zoom chip.
- `StashedSessionCard.tsx:36` — Hardcoded `'en-US'` locale for stash dates. Follow the device.
- `PatientTabStrip.tsx:184-196` — At 10-patient max the "+" silently disappears and `ADD_SLOT` no-ops. Keep a disabled "+" with "Max 10 patients."
- `audio-editor.tsx:1386-1392` — "Merging segments..." spinner has no cancel; FFmpeg concat on weak tablets can take long. Add cancel falling back to per-segment mode.

---

### 3. Recordings list, detail & SOAP consumption

**High**
- `src/components/RecordingCard.tsx:141` — Card `accessibilityLabel` is "Recording from {date}, status {status}" — the patient/client name is omitted and the label overrides children, so a screen-reader vet can't tell whose recording each row is. Include patient + client in the label.
- `src/components/TranscriptView.tsx:51-53` — Entire transcript renders as one `selectable` `<Text>`; a 1–2-hour consult transcript in a single Android TextView causes multi-second layout, janky scroll, and selection ANRs on the budget clinic tablets this app targets. Chunk into paragraph-level Text nodes (selectable per-chunk) or virtualize past a threshold.
- `app/(app)/(tabs)/recordings/index.tsx:479-481` — Post-submit banner renders `{submittedIds.length} of {submittedIds.length} submitted` (constant "N of N", can never show partial success) and dumps raw truncated UUIDs at the user. Show real per-recording status; use patient names.
- `src/components/RecordingAudioPlayer.tsx` — No playback-speed control (1.25/1.5/2x) on the player whose primary use is reviewing full consults. Add a rate toggle via expo-audio `setPlaybackRate`.

**Medium**
- `recordings/[id].tsx:124-141` — Poll backoff keys off lifetime `dataUpdateCount`, so post-reprocess polling starts near the 60s cap instead of 5s and the stepper feels frozen. Track attempts in a ref reset with `pollingStartedAtRef`.
- `src/components/ProcessingStepper.tsx:16` — `retry_scheduled` missing from `STATUS_ORDER` → every step renders pending with no current marker exactly when the user needs "retrying." Map it (or show a "Retrying…" row).
- `recordings/[id].tsx:722` — Back button hardcodes `router.navigate('/recordings')`, dumping vets who arrived from Home/patient-history onto the list. Use `router.back()` with a fallback.
- `ExportSheet.tsx:169`, `ClientEmailCard.tsx:155`, `TranslationCard.tsx:163` — Copy/share feedback is a tiny persistent caption that never auto-clears — third confirmation pattern on one screen (see theme D). Standardize on the toast.
- `ClientEmailCard.tsx:123` — Email preview capped at `numberOfLines={8}` with no expand; the vet can't read the full client-facing email before sending. Add expandable preview.
- `recordings/index.tsx:448` — FlatList lacks `keyboardShouldPersistTaps="handled"`; after searching, the first tap only dismisses the keyboard. Add it.
- `recordings/index.tsx:186-199` — "Needs Review" filter option appears only if the loaded page happens to contain one — the filter menu's contents shift as pages load. Always show (or gate on a stable capability).
- `RecordingCard.tsx:149-165, 205-214` — Interactive Pressables nested inside the card Pressable (unreliable under TalkBack/VoiceOver); patient-history link target ~28pt. Use `accessibilityActions` on the card; enlarge hitSlop.
- `SoapNoteView.tsx:257,276,340`, `TranscriptView.tsx:66`, `StatusBadge.tsx:105`, `RecordingAudioPlayer.tsx:574` — `allowFontScaling={false}` on Copy/Edit/Copy All/Retry and every status badge. Use `maxFontSizeMultiplier={1.3}`.
- Copy-status texts lack `accessibilityLiveRegion` (theme B).
- `ProcessingStepper.tsx:47-48, 98-106` — No live-region on step transitions; the 4.5s rotating warmth message would be noise if announced. Announce transitions politely; mark warmth text `importantForAccessibility="no"`.
- `SoapNoteView.tsx:243-280` vs `ExportSheet.tsx:113-139` — Copy/Edit are raw Pressables in SoapNote/Transcript but shared Buttons in the newer cards — two visual systems on one screen. Migrate to `Button variant="secondary" size="sm"` (after fixing Button, theme F).
- No offline cache for completed notes: React Query is memory-only (`src/lib/queryClient.ts:24`, 10-min gcTime, no persister) — a vet opening the app offline (barn call) sees empty lists/failures despite the offline-heavy draft design. Add `@tanstack/query-persist-client` for recordings/soapNote queries (mind per-user PHI scoping, rule 13).
- `TranscriptView.tsx:54-72` — Copy button sits below the full transcript; long transcript = scroll everything to copy. Move to a header row like SoapNoteView's Copy All.
- `RecordingCard.tsx:222-237` — `React.memo` comparator omits `patientId`/`pimsPatientId`; when a recording gets linked to a patient the history link never appears until a full refetch. Add to comparator.
- `RecordingCard.tsx:30, 39-41` and `:46-59` — `DraftLocationChip` ("On this device") and `AiLabeledChip` ("AI-labeled") in `self-end` flex-row chips lack the clipping mitigation their sibling `ReviewStatusChip` has. Apply the same fix.

**Low**
- `recordings/index.tsx:423-432` — Search has no clear button and no `returnKeyType="search"`. Add `clearButtonMode="while-editing"` + Android clear icon.
- `StatusBadge.tsx:82` — Unknown statuses fall back to a pulsing "Uploading" badge — actively misleading for future server statuses. Neutral fallback from the raw string.
- `TranslationCard.tsx:157` — Translations render as plain Text while source renders MarkdownText → literal `**bold**`. Use MarkdownText.
- `SoapNoteView.tsx:186-191` — "›" chevron read as punctuation by screen readers. Hide from accessibility.
- `RecordingAudioPlayer.tsx:640-657` — "Part n" chips `minHeight: 32` (< 44pt used elsewhere in the same player). Bump.
- `SoapNoteView.tsx:292` — Single-section accordion defaulting to Subjective makes reading a full note four taps; Plan is two accordions away. Allow multiple open or add Expand All.
- `recordings/[id].tsx:836-846` — "Processing..." (three ASCII dots) violates the strings.ts single-ellipsis convention and bypasses the catalog. Move to `strings.ts` as `'Processing…'`.
- `recordings/[id].tsx:839-846, 979-999` — Several detail-screen strings bypass the copy catalog. Relocate.
- `recordings/[id].tsx:697-704` — Client name clamped to 1 line in a 50%-width cell with no way to see the full value. Allow 2 lines.
- `recordings/[id].tsx:982-984` — Raw server `errorMessage.slice(0,200)` shown, truncates mid-word (theme E).
- `recordings/index.tsx:428` — Placeholder "Search by patient name..." undersells (also matches client name) and uses three dots. "Search patient or client…".
- `recordings/index.tsx:37-43` — No date grouping/sort; deep-history lookups rely on search + pagination. Consider "This week / Earlier" section headers.

*Clipping gotcha:* mitigations verified in place with the required comments across `StatusBadge`, `SoapNoteView`, `TranscriptView`, `RecordingAudioPlayer`, `ReviewStatusChip`, `ExportSheet`, `SuggestedTasksCard`, `RecordingCard` main labels. The two chips above are the only stragglers.

---

### 4. Home, patients, settings & secondary screens

**High**
- `app/(app)/durable-recovery.tsx:156-180` — Uses theme tokens that don't exist (`bg-surface-base`, `text-content-strong`, `text-content-muted`; verified absent from `tailwind.config.js`/`global.css`), so NativeWind drops the classes and the crash-recovery screen renders unthemed — broken contrast in dark mode on the screen a vet reaches after losing a recording. Replace with `bg-surface`, `text-content-primary`, `text-content-tertiary`.

**Medium**
- `index.tsx:243-267` + `_layout.tsx:223-224` — Up to five banners can stack on Home (device-registration + offline + durable-recovery + device-limit + provider-issue), pushing the hero Record CTA below the fold. Cap at one with priority order (recovery > device limit > provider issue) or collapse to "N alerts."
- `src/components/ui/Banner.tsx:111` — CTA renders single-word Text ("Manage", "Retry") in a flex-row with no clipping mitigation — the exact pattern the repo's UI Gotchas rule exists for. Fix inside Banner so every call site is covered.
- `src/components/ProviderIssueBanner.tsx:32-43` — Jargon-heavy message ("Z.ai GLM-4.6… rate limit (code 429)") and "CaptiVet" misspelling. Lead with user impact ("SOAP notes may be delayed"); fix spelling.
- `ProviderIssueBanner.tsx:96-109` — "Dismiss" acknowledges server-side on Settings but is component-local on Home (reappears next mount) — identical affordances, divergent outcomes. Unify or relabel.
- `patient/[id].tsx:472-510` — Edit mode omits a Species field even though the draft copies `species` and view mode shows it — silently read-only. Add the field/picker.
- `patient/[id].tsx:251-258` — Any fetch failure renders "Patient not found" with no retry — misleads offline users into thinking the record is gone. Branch error vs missing; add Retry.
- `patient/[id].tsx:302-315,323-336` — "Regenerate"/"Trigger manually" Pressables: no role/label/disabled state, sub-44pt targets. Add them (the `AiSummaryText` toggle at :52-59 models it).
- `index.tsx:423-427` — Home error card shows `[ApiError 500] <message>` (theme E).
- `app/(app)/_layout.tsx:136-154,187-209` — Half-auth and account-error recovery screens use raw Pressables with no roles/states and duplicated one-off button styles. Swap to shared Button.
- `recording-recovery.tsx:270-272,295-299` — Copy describes the mechanism, not the action ("protected during support staff sign-out," "verify they came from this organization"). Rewrite around outcomes.
- `src/components/DurableRecoveryBanner.tsx:29` — Light-only `bg-brand-50 border-brand-300` with no `dark:` override (the only one of 15 such sites missing it). Add `dark:bg-surface-sunken dark:border-border-default`.
- `(tabs)/_layout.tsx:115-118` + `settings.tsx` — Settings is a hidden tab so the tab bar shows (nothing highlighted) on Settings but disappears on its own child screens. Move settings.tsx into the `(app)` stack.
- `patient/index.tsx:93` — Search field's leading icon is `User`, not a magnifier; same icon reused for error/empty states. Use `Search`.
- `patient/[id].tsx:143,362-403` — Visits tab fetches `limit: 20` with no pagination or "showing 20 of N." Use infinite query or a "View all visits" row.

**Low**
- `index.tsx:401-408` — "View All" bare text link, sub-44pt. Add hitSlop.
- `patient/[id].tsx:63,310,330` — `allowFontScaling={false}` on action labels (theme A).
- `(tabs)/_layout.tsx:101` — Tab says "Records", screens say "Recordings" (theme C).
- `settings.tsx:422` — Privacy row uses `LifeBuoy` (support metaphor). Use `ShieldCheck`.
- `settings.tsx:311-333` — Section-closing margin lives on the conditional Subscription row → uneven gaps for non-admins. Apply to whichever item is last.
- `settings.tsx:53-59` — `SectionHeading` lacks `accessibilityRole="header"` (screen-reader section jumps). Add it.
- `devices.tsx:35` — Relative dates drop the year ("Mar 5") — ambiguous for the stale devices users most need to revoke. Include year when not current.
- `devices.tsx:131-133` — `MFA_REQUIRED` revoke path returns silently; if the global MFA flow doesn't surface, the tap appears dead. Add a toast or breadcrumb.
- `patient/index.tsx:41-54` — Each search keystroke is a new query key without `placeholderData: keepPreviousData` → list blanks to skeletons per refinement. Keep previous data.
- `patient/[id].tsx:485-489` — DOB is free-text "YYYY-MM-DD" with no validation/keyboard/picker. Add a picker or validate.
- `src/components/Toast.tsx:17,44-50` — Flat 2000ms duration, hardcoded `bottom: 48` ignoring safe-area, no queueing. Scale duration, use insets.
- `recording-recovery.tsx:336-367` — Four hand-styled raw TextInputs duplicating `TextInputField` without labels/required markers. Use the shared field.
- `durable-recovery.tsx:158-159` — Raw `text-xl` header and "Back" label vs the sibling `text-display` + "Go back" pattern. Align while fixing the token bug.

**Strengths (no action):** sign-out-with-unsent-work (`settings.tsx:206-260`) and delete-account are genuinely best-in-class destructive flows; the tab bar and shared list primitives carry proper roles/labels; home information hierarchy is right.

---

### 5. Design system & cross-cutting (src/components/ui, tokens, dark mode)

**High**
- `global.css:14` — Light-mode `--color-content-tertiary` is stone-400: **2.41:1 on surface** (WCAG AA requires 4.5:1), used in ~120 places for real content (ListItem subtitles, EmptyState descriptions, Select placeholder, help text). Dark mode passes. Darken to ~stone-500 (#78716c ≈ 4.6:1) or split into a placeholder-only `tertiary` and a compliant `subtle`.

**Medium**
- `src/components/ui/Button.tsx:130` — The shared Button implements none of the repo's documented Android clipping mitigations, and the workarounds have leaked outward as proof: `strings.ts:301` ships `'Reprocess '` with a trailing space that `ReprocessSheet.tsx:188` must `.trim()`, and SoapNoteView/TranscriptView rebuild Copy/Edit as raw Pressables specifically to apply the fix (losing Button's haptics). Bake the fix into Button's label Text; delete the string-level hack.
- 10 sites (`index.tsx:369-372`, `record.tsx:4246`, `patient/[id].tsx:274`, `PatientTabStrip.tsx:41-92`, `PatientSlotCard.tsx:98`, …) use static single-hue classes (`text-warning-500` = 2.15:1 on white, `text-success-500` = 2.28:1) bypassing the AA-checked `status-*` var pairs. Sweep onto `text-status-warning` etc.
- `app/_layout.tsx:259` — SplashGate hardcodes `backgroundColor: '#ffffff'` → full-screen white flash on every dark-mode Android cold start. Theme it (`Appearance.getColorScheme()` works pre-provider).
- 17 `allowFontScaling={false}` sites, 0 `maxFontSizeMultiplier` (theme A). Global fix at the `_layout.tsx:41-61` render patch.
- 54 raw `<Pressable>` outside `ui/` vs 94 shared button usages, with inconsistent haptics (theme F).
- `patient/[id].tsx:95-110` and `recording-recovery.tsx:336-368` — Two local reimplementations of `TextInputField` (one missing accessibilityLabel and focus borders; multiline already works via `...rest`). Port both.
- `src/components/ui/Sheet.tsx:80` — No keyboard avoidance; `MetadataReviewCard` puts five inputs in one sheet — iOS keyboard covers the lower fields. Wrap in KAV (`behavior="padding"`) + `keyboardShouldPersistTaps="handled"`.

**Low**
- 13 hex literals remain outside `ui/`/config — all in boot-path fallbacks (`app/_layout.tsx` ErrorBoundary/SplashGate/CONFIG_MISSING, tab-bar `shadowColor`). Source ErrorBoundary/SplashGate from the theme constants; CONFIG_MISSING can stay.
- `tailwind.config.js` / `global.css` / `src/constants/colors.ts` are triple-maintained with no drift check. Add a tiny test asserting parity.
- `ui/SegmentedControl.tsx:47,111` — Duplicate nested `radiogroup` when scrollable. Drop the inner role.
- 37 raw `ActivityIndicator` vs Skeleton in 6 files — no documented convention. Document: Skeleton for content, spinner for in-button busy.
- `app/_layout.tsx:349-352` — StatusBar `backgroundColor` passed only on iOS where it's a no-op — dead code that reads as a bug. Delete with a comment.
- `ui/Sheet.tsx` — No drag handle/swipe-dismiss; scrim slides with panel. Acceptable v1; split scrim fade from panel slide if polish is wanted.
- `ui/Banner.tsx:93-115` — CTA/dismiss ~34pt effective targets, below the system's own `TOUCH_TARGET`. Use shared `HIT_SLOP` + `min-h-[44px]`.
- Badge/Banner/StatusBadge use three overlapping variant vocabularies (`brand|success|…` vs `info|warning|error` vs `info|warning|success|danger`). Converge on one enum.
- `ui/Select.tsx` — No search/filter; fine at current option counts. Note `searchable` as the growth path.
- 18 raw `text-xs/sm/lg` classes + 6 inline `fontSize:` remain vs the 8-step semantic scale (7 in `app/(app)/_layout.tsx`, 5 in `UploadOverlay.tsx`, 3 each in `DeviceRegistrationBanner`/`durable-recovery`). Sweep; the 11px tab bar is a legitimate exception.
- `ui/ScreenContainer.tsx` — `RefreshControl` takes no `tintColor`/`colors`, ignoring brand/dark theme (patient/[id] hand-themes its own). Default from `useThemeColors()`.

**Strengths (no action):** real, well-architected dark mode (`darkMode: 'class'`, CSS-var flip, persisted preference, themed status bar; only 20 `dark:` overrides needed because the var system carries it); 528 semantic-token class usages and 0 legacy palette classes outside `ui/`; uniform prop naming (`label/required/error/helpText`, `onValueChange`, `haptic`) with centralized `runMaybeAsync*` crash-safety; strong default accessibility in all 16 primitives; `strings.ts` adoption effectively complete for feature screens.

---

## Suggested remediation phases

**Phase 1 — correctness & data safety (small diffs, highest stakes):**
Auth plumbing (#1, #2, #5 from Top 10), draft-discard paths (#3), silent recording transitions (#4), durable-recovery tokens (#6), DeviceLimitModal escape (#9), UploadOverlay math (#10).

**Phase 2 — one-file fixes that propagate everywhere:**
`content-tertiary` token (#7), Button + Banner clipping fix (#8), global `maxFontSizeMultiplier` via the render patch, `status-*` color sweep (10 sites), SplashGate dark theming, Sheet keyboard avoidance.

**Phase 3 — consistency passes:**
Terminology consolidation (stash/draft/not-submitted, Records→Recordings, CaptiVet→Captivet), copy-confirmation standardization on Toast, error-string mapping (theme E), raw-Pressable → shared-Button adoption, copy-catalog stragglers, `TextInputField` adoption in the two reimplementing screens.

**Phase 4 — bigger UX investments:**
Playback speed control, transcript chunking/virtualization, offline persistence for completed notes (React Query persister with per-user scoping), banner priority/collapse system on Home, iOS VoiceOver announcements for recorder state, audio-editor explicit-merge flow.

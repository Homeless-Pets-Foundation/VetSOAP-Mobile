# Captivet Mobile — UI/UX Audit Implementation Plan

**Date:** 2026-07-17
**Companion to:** `docs/ui-ux-audit-2026-07-17.md` (the audit; ~140 findings: 17 High, ~60 Medium, ~65 Low)
**Branch:** `claude/mobile-app-ui-ux-audit-616x7n`
**Scope:** Implements **all** audit recommendations, organized into 31 work packages (WP1–WP31), each sized for one commit, sequenced so correctness/data-safety fixes land first and foundational design-system changes land before the screens that consume them.

---

## Context

The audit found that the app's foundations are strong (mature token system, real dark mode, exceptional recording-flow data safety) but problems cluster at the seams: broken auth plumbing (unreachable forgot-password flow, swallowed Supabase errors), discard paths that destroy already-durable drafts, silent recording-state transitions, half-wired accessibility patterns (contrast, font scaling, iOS announcements), and a shared Button that lacks the project's own Android clipping fix — which pushes screens back to raw Pressables. This plan converts every finding into concrete, ordered work.

## Global conventions (apply to every WP — from CLAUDE.md)

- Never pass an async fn to a void callback (`onPress`, `Alert` buttons, `onRefresh`, `onValueChange`) — wrap with `.catch()` or use `runMaybeAsyncEvent` from `src/components/ui/styles.ts` (rule 2).
- Every fire-and-forget Promise gets `.catch(() => {})`, including `Haptics.*Async` (rule 4). Loading flags reset in `finally` (rule 5). `console.error` behind `__DEV__` (rule 12).
- All new user-facing strings go in `src/constants/strings.ts` (one `as const` object per feature area; single `…` ellipsis character).
- Lazy-`require()` optional native modules (`expo-apple-authentication`) — never static import (rule 19).
- Clipping-mitigation sites keep the mandatory inline comment (UI Gotchas).
- Guard `new Date()` before formatting (rule 11). Never put PHI in analytics/Sentry events.

## Verification baseline (every WP)

`npm run typecheck` + `npm test` + `npm run lint`, plus the targeted manual check listed per WP.
Emulator limits (CLAUDE.md): the silent-audio check blocks real Submit on emulator (verify upload paths by count-doesn't-bump or physical device); Android single-word clipping does **not** reproduce on emulator/iOS (verify by pattern + physical Android); haptics no-op on emulator. Max-font-scale checks: `adb.exe shell settings put system font_scale 1.6` (reset to `1.0` after).

---

## Resolved design decisions (apply throughout)

1. **Swipe auto-pause (WP2):** keep the auto-pause — single-recorder ownership via `recorderBoundToSlotId` is load-bearing architecture. Add the visible toast + `AccessibilityInfo.announceForAccessibility` instead of recording across slot switches.
2. **Global font-scale cap (WP11):** inject `maxFontSizeMultiplier: 1.3` in the existing `app/_layout.tsx:41-61` render patch, only when the element doesn't already set it — explicit per-element values always win. Then delete the 17 `allowFontScaling={false}` sites.
3. **Settings route move (WP21):** do it. The URL stays `/settings` (route groups don't affect paths), so the two `router.push('/settings')` sites (`app/(app)/(tabs)/index.tsx:221`, `src/components/ProviderIssueBanner.tsx:105`) need no change.
4. **Transcript chunking (WP26):** chunk only above ~6,000 chars (below: keep today's single selectable Text and its long-press select-all). Above: split on blank-line boundaries (fallback ~1,500-char sentence groups) into per-chunk selectable Texts; the header-row Copy button becomes the whole-transcript copy path.
5. **Offline persistence PHI scoping (WP28):** AsyncStorage persister is acceptable per the 2026-05-29 owner decision (not HIPAA; drafts already persist on disk), but user-scoped like `draftStorage` (rule 13): key `captivet_rq_cache_{userId}`, activated only after auth resolves, allowlisted query keys only, `removeClient()` on sign-out/user switch.
6. **UploadOverlay escape (WP6):** add "Hide" (not Cancel) — the upload loop lives in `record.tsx`; hiding is safe, and a compact progress banner remains. True cancel of in-flight R2 uploads is out of scope.

---

# PHASE 1 — Correctness & data safety (WP1–WP9)

## WP1 — Stop destroying committed drafts in discard paths
**Audit:** High #3 (nav-guard + resume-stash delete durable drafts).
**Files:** `app/(app)/(tabs)/record.tsx`, `src/constants/strings.ts`.
1. Extract a shared `isTrulyUnsavedSlot(slot)` predicate from the `trulyUnsaved` logic at `record.tsx:3751-3756` (has recoverable audio + not uploaded + **no `draftSlotId`**, or live recorder). Use it for both the inline `trulyUnsaved` and the `unsavedCount` computation at 1301-1304 — drafted slots stop counting as "unsaved" in the nav-away guard.
2. Nav-away guard (1301-1326): compute `preserveDraftSlotIds = slots.filter(s => s.draftSlotId).map(s => s.draftSlotId)` and pass to `discardCurrentSession({ preserveDraftSlotIds })` in the Discard branch — the function already supports this (signature at 1218; the Load-Draft path at 3721-3786 already uses it). Update alert copy: drafts stay in "Not Submitted"; only truly-unsaved audio is discarded.
3. Resume-stash Replace (3961-3978): pass the same preserve list into its `discardCurrentSession()` call; adjust "Replace Current Session?" body to say drafts are preserved.
4. New strings: `DISCARD_SESSION_COPY` (title/body builders/actions) + updated replace-session copy (pre-work for WP15's migration).
**Constraints:** Alert handlers calling async `discardCurrentSession` wrap with `.catch()`. Don't touch post-upload draft cleanup.
**Verify:** record → Finish (draft) → switch tab → no guard; add a second unfinished slot → guard fires with count 1 → Discard → drafted slot still in "Not Submitted"; Resume stash → Replace → prior draft survives.

## WP2 — Visible feedback for silent recorder transitions
**Audit:** High #4 (silent swipe auto-pause; silent durable-interruption finalize).
**Files:** `app/(app)/(tabs)/record.tsx`, `src/constants/strings.ts`.
1. Import `Toast` (`src/components/Toast.tsx` — declarative `{message, visible, onHide}`) into record.tsx; add `pauseToast` state; render near the interruption banner (4240-4251).
2. In `selectPatientIndex` (1344-1363) / `handleScrollEnd` (1365-1373): after auto-pausing a live recording, set the toast (`RECORDER_TRANSITION_COPY.autoPaused(patientLabel)`) and call `AccessibilityInfo.announceForAccessibility` (sync; works both platforms).
3. Durable interruption branch (1049-1070): after finalizing, set a new `durableInterruptionNotice` state; extend the banner block to render durable copy ("A call interrupted this recording. The audio was saved — tap Continue Recording to add more."), dismissible + announced.
4. Generalize legacy banner copy (4247-4249): "paused for call" → interruption-neutral wording.
5. New strings: `RECORDER_TRANSITION_COPY = { autoPaused(name), interruptedPaused, interruptedSaved }`.
**Constraints:** patient names in on-screen strings only, never analytics events. Toast `onHide` must be a stable callback.
**Verify:** start recording → swipe to next patient → toast + paused state. Durable interruption verified by code review/state wiring (needs a real incoming call).

## WP3 — Auth false-success and recovery-state plumbing
**Audit:** Highs #2 (swallowed `{ error }`) + reset-Cancel stranding + MFA bootstrap dead-end.
**Files:** `app/(auth)/forgot-password.tsx`, `app/(auth)/reset-password.tsx`, `app/(auth)/mfa.tsx`, `src/constants/strings.ts`.
1. `forgot-password.tsx:35-38`: `const { error } = await supabase.auth.resetPasswordForEmail(...)` (supabase-js v2 returns, doesn't throw); on error show inline error banner, don't `setEmailSent(true)`. Map rate-limit vs generic copy. `finally` resets `isLoading`.
2. `reset-password.tsx:31`: same for `supabase.auth.updateUser({ password })`; on error show inline banner ("Your reset link may have expired — request a new one"), skip success+sign-out path.
3. Reset Cancel (114-122): call `clearPasswordRecovery()` (from `useAuthReadiness()`) then `router.replace('/(auth)/login')` — lets the `app/(auth)/_layout.tsx:22` redirect guard operate.
4. `mfa.tsx:156-157`: generic bootstrap failure gets an explicit error state ("Couldn't load verification" + Retry rerunning bootstrap) instead of falling through to `mode='challenge'`.
5. New strings: `PASSWORD_RESET_COPY`, `MFA_BOOTSTRAP_COPY`.
**Constraints:** rule 25 — never show raw Supabase/MFA server text.
**Verify:** airplane mode → submit forgot-password → error banner, not "Check your email".

## WP4 — Login screen completeness
**Audit:** Highs #1 (no forgot-password link), #5 (missing Apple button), #4 (autofill) + keyboard/lockout mediums.
**Files:** `app/(auth)/login.tsx`, `src/auth/socialAuth.ts`, `src/constants/strings.ts`.
1. `socialAuth.ts`: export the currently-private `isGoogleSignInConfiguredForCurrentPlatform()` (122-126). Add `isAppleSignInAvailable(): Promise<boolean>` — lazy-`require('expo-apple-authentication')` in try/catch (rule 19), `Platform.OS === 'ios' && await isAvailableAsync()`, false on throw.
2. Add "Forgot password?" link under the password field → `/(auth)/forgot-password` (ghost text button, `HIT_SLOP`).
3. Apple button: on-mount `isAppleSignInAvailable().then(setAppleAvailable).catch(() => {})`; when true, lazy-require and render the native `AppleAuthenticationButton` (SIGN_IN, theme-adaptive style, height 44, cornerRadius matching `rounded-btn`) above Google; `onPress={() => { handleSocial('apple').catch(() => {}); }}` (handler exists at 89-128). Native button = HIG-compliant, no invented glyph.
4. Gate the Google button on the exported config check; hide the "or continue with" divider when no provider renders.
5. Autofill: email `autoComplete="email" textContentType="username" keyboardType="email-address" autoCapitalize="none"`; password `autoComplete="current-password" textContentType="password"` (pattern proven at forgot-password.tsx:104).
6. Keyboard: wrap form in `ScrollView keyboardShouldPersistTaps="handled"` inside the existing KAV (copy `mfa.tsx:261-269`); refs for email `returnKeyType="next"` → focus password; password `returnKeyType="go"` → submit.
7. Lockout countdown (41-45, 72): store `lockoutUntil` timestamp; 1s interval renders "Try again in {n}s" + disables the button; clear interval on unmount.
8. Lows: subtitle `numberOfLines={2}`, drop `adjustsFontSizeToFit`; leave `autoFocus` off.
**Verify:** Android emulator: no Apple button, Google visibility matches config, link navigates, return-key chain works. iOS via Mac mini sim build when available.

## WP5 — DeviceLimitModal escape hatch + honest feedback
**Audit:** High #9 + revoke/retry feedback mediums.
**Files:** `src/components/DeviceLimitModal.tsx`, `src/constants/strings.ts`.
1. Footer (actual location 279-286): add `Button variant="ghost"` "Sign out" wired to `useAuthActions().signOut` (`.catch(() => {})`) — AppLockGuard models this escape hatch. Sign-out preserves drafts per rule 8 (standard path, nothing extra).
2. Failed `retryDeviceRegistration()` (97-113): render "Still at the device limit. Revoke a device below or sign out." instead of silently clearing footer text.
3. Revoke failure (150-155): mapped copy instead of raw `error.message`; raw error to `__DEV__` log + Sentry breadcrumb.
4. Remove `allowFontScaling={false}` at 267 (global cap arrives in WP11).
**Verify:** typecheck + code review (modal is hard to reach on demand).

## WP6 — UploadOverlay batch correctness + Hide
**Audit:** High #10 (inflated progress), stale-toast + no-escape mediums, assertive re-announce.
**Files:** `src/components/UploadOverlay.tsx`, `app/(app)/(tabs)/record.tsx`, `src/constants/strings.ts`.
1. New prop `batchSlotIds: string[]` — `handleSubmitSingle` (3265-3335) passes `[slot.id]`; `handleSubmitAll` (3337-) passes the eligible list; derive `totalSlotsToUpload` from it.
2. `completedCount` (80-95): count only ids ∈ `batchSlotIds` with `uploadStatus === 'success'`. Extract as exported `countBatchCompleted(slots, batchSlotIds)` for testability.
3. `confirmedIdsRef` (57-74): seed with already-successful slot ids when `visible` flips true (kills stale "{old patient} uploaded" toasts).
4. Accessibility (139-147): announce "Uploading N recordings" once on open; drop the live percentage from the alert label; the inner `progressbar` (176-180) keeps `accessibilityValue`.
5. Hide: `onHide` prop + `uploadOverlayHidden` state in record.tsx; while hidden with uploads in flight, render a compact one-line progress `Banner` ("Uploading {done} of {total}…") that reopens the overlay; reset on batch completion.
**Strings:** additions to `UPLOAD_OVERLAY_COPY` (`hide`, `backgroundProgress(done, total)`, announce) — short active-voice phrasing (narrow-card clipping rule).
**Verify:** new `tests/upload-overlay-batch.test.mjs` for `countBatchCompleted`; overlay open/Hide behavior on emulator.

## WP7 — Fix crash-recovery theming
**Audit:** High #6 (nonexistent tokens) + dark-mode banner hole.
**Files:** `app/(app)/durable-recovery.tsx`, `src/components/DurableRecoveryBanner.tsx`.
1. Replace nonexistent tokens at 156/159/162/168/178/180: `bg-surface-base`→`bg-surface`, `text-content-strong`→`text-content-primary`, `text-content-muted`→`text-content-tertiary`.
2. Align header with siblings: `text-xl`→`text-display`, "Back"→"Go back".
3. `DurableRecoveryBanner.tsx:29`: add `dark:bg-surface-sunken dark:border-border-default`.
**Verify:** dark-mode render of the recovery screen; `tests/dark-mode-guard.test.mjs` stays green.

## WP8 — Recordings detail correctness cluster
**Audit:** stepper `retry_scheduled` gap, poll backoff, hardcoded back nav.
**Files:** `app/(app)/(tabs)/recordings/[id].tsx`, `src/components/ProcessingStepper.tsx`, `src/constants/strings.ts`.
1. `ProcessingStepper.tsx:16`: add `retry_scheduled` to `STATUS_ORDER` (it's a real status — `src/types/index.ts:8`; `StatusBadge` maps it warning/inProgress) mapped to the transcribing/generating rank; row label "Retrying…" via `PROCESSING_STEP_LABELS`.
2. Poll backoff (120-142): `pollAttemptsRef = useRef(0)` incremented per tick, drives the interval instead of lifetime `dataUpdateCount`; reset to 0 everywhere `pollingStartedAtRef` resets (267, 291, 830-832).
3. Back buttons (720-728 and the isError branch at 613): `router.canGoBack() ? router.back() : router.replace('/recordings')`.
**Verify:** open detail from Home → back returns to Home.

## WP9 — Recordings list truth + card accessibility
**Audit:** High #12 (N-of-N banner), High (a11y label omits patient), memo staleness, chip clipping.
**Files:** `app/(app)/(tabs)/recordings/index.tsx`, `src/components/RecordingCard.tsx`, `src/constants/strings.ts`.
1. Submitted banner (473-487): use the existing `submittedRecordingsById` Map + `submittedRecordingQueries` to render per-recording rows (patient name + live `StatusBadge`) and a real "{succeeded} of {total} uploaded" count; drop the raw UUID line.
2. `RecordingCard.tsx:141`: `accessibilityLabel` includes patient + client + date + status (same fields the visual title uses).
3. Memo comparator (222-237): add `patientId` + `pimsPatientId`.
4. Apply the clipping mitigation (trailing space + `flexShrink: 0, paddingRight: 2` + required comment) to `DraftLocationChip` (24-44) and `AiLabeledChip` (46-60), matching `ReviewStatusChip`.
**Verify:** submit-all flow shows named per-recording rows.

---

# PHASE 2 — One-file foundations that propagate (WP10–WP14)

## WP10 — Bake clipping mitigation into Button + Banner; delete the string hack
**Files:** `src/components/ui/Button.tsx`, `src/components/ui/Banner.tsx`, `src/constants/strings.ts`, `src/components/ReprocessSheet.tsx`, new `tests/ui-clip-guard.test.mjs`.
1. `Button.tsx:125-132` (children is a required string): label Text renders `` {`${children} `} `` with `style={{ flexShrink: 0, paddingRight: 2 }}` + the mandatory comment; icon wrapper gets `flexShrink: 0`. `accessibilityLabel` keeps un-padded `children` (already at :112).
2. `Banner.tsx` CTA (93-113): same mitigation on the CTA Text; CTA + dismiss (114-124) get `hitSlop={HIT_SLOP}` (from `./styles`) and ≥44pt targets.
3. `strings.ts:301`: `'Reprocess '` → `'Reprocess'`; remove the `.trim()` at `ReprocessSheet.tsx:188`.
4. New `tests/ui-clip-guard.test.mjs` (grep-the-source, per `dark-mode-guard.test.mjs`): Button + Banner contain the mitigation; no strings.ts value ends with a trailing space.
**Verify:** `npm test`; physical-Android visual check deferred (emulator hides this bug class — note in commit).

## WP11 — Global font-scale cap; remove `allowFontScaling={false}`
**Files:** `app/_layout.tsx` + the remaining 16 sites (`app/(app)/(tabs)/patient/[id].tsx` 63,310,331,425,464; `src/components/PatientSlotCard.tsx` 361,503,541,572,598; `SoapNoteView.tsx` 257,275,340; `StatusBadge.tsx:105`; `TranscriptView.tsx:67`; `RecordingAudioPlayer.tsx:575`), new `tests/font-scaling-guard.test.mjs`.
1. Extend the render patch (41-61, which already clones Text/TextInput elements to inject Inter): merge `maxFontSizeMultiplier: 1.3` into the same `cloneElement` **only when the element doesn't define it** — explicit values win. Keep inside the existing try/catch (rule 1); update the comment.
2. Delete all remaining `allowFontScaling={false}` sites.
3. New `tests/font-scaling-guard.test.mjs`: zero `allowFontScaling={false}` in `app/` + `src/components`; `maxFontSizeMultiplier` present in `app/_layout.tsx`.
**Risk handling:** verify record/recordings/settings at `font_scale 1.6`; if a specific pill breaks, give it an explicit smaller `maxFontSizeMultiplier` (respected by the patch), never restore `allowFontScaling={false}`.

## WP12 — Theme tokens: contrast fix, status sweep, boot-path theming, parity fence
**Audit:** High #7 (content-tertiary 2.4:1), 10 status-bypass sites, SplashGate white flash, ErrorBoundary hexes, dead StatusBar prop.
**Files:** `global.css`, `src/constants/colors.ts`, the 10 sites (`app/(app)/(tabs)/index.tsx:369,371,372`; `app/(app)/(tabs)/patient/[id].tsx:274`; `app/(app)/(tabs)/record.tsx:4246`; `src/components/PatientSlotCard.tsx:98`; `src/components/PatientTabStrip.tsx:41,52,60,92`), `app/_layout.tsx`, new `tests/theme-token-guard.test.mjs` (+ baseline JSON).
1. `global.css:14`: `--color-content-tertiary: 168 162 158` → `120 113 108` (stone-500, ~4.6:1). Dark value (:55) unchanged. Mirror `LIGHT_THEME_COLORS.contentTertiary` in `colors.ts`.
2. Sweep the 10 sites onto the AA-checked utilities that already exist at `global.css:88-104` (`text-status-warning`, `bg-status-success`, etc.); icon `color=` props source from `useThemeColors()` status colors.
3. SplashGate (`app/_layout.tsx:259`): `Appearance.getColorScheme() === 'dark' ? DARK_THEME_COLORS.surface : LIGHT_THEME_COLORS.surface` (constants import; works pre-provider, class component safe). ErrorBoundary hexes (169-188): same constants. CONFIG_MISSING (492-503) stays hardcoded (renders before everything — audit-sanctioned).
4. ThemedStatusBar (341-354): delete the iOS-only dead `backgroundColor` prop with a one-line comment.
5. New `tests/theme-token-guard.test.mjs`: (a) parity — regex-extract `--color-*` names from light + dark blocks, assert sets match and every `colors.ts` key has a var; (b) fence — grep `app/` + `src/components` (excl. `ui/`) for `(text|bg|border)-(success|warning|danger|info)-[0-9]{2,3}` against a baseline JSON (0 after the sweep; whitelist any legitimate non-status tints found).
**Verify:** dark-mode cold start without white flash; light-mode subtitle contrast.

## WP13 — UI primitive fixes: Sheet keyboard, SegmentedControl roles, RefreshControl theming
**Files:** `src/components/ui/Sheet.tsx`, `src/components/ui/SegmentedControl.tsx`, `src/components/ui/ScreenContainer.tsx`.
1. `Sheet.tsx:80`: wrap content in `KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}`; `keyboardShouldPersistTaps="handled"` on the ScrollView.
2. `SegmentedControl.tsx`: remove the duplicate `radiogroup` role from the outer ScrollView (107-115); keep the inner (47-48).
3. `ScreenContainer.tsx:35-40`: default `RefreshControl` `tintColor`/`colors`/`progressBackgroundColor` from `useThemeColors()` (override still possible).
**Verify:** MetadataReviewCard sheet with keyboard open — lower fields reachable; brand-colored refresh spinner in dark mode.

## WP14 — Toast upgrades + shared CopiedToast extraction
**Files:** `src/components/Toast.tsx`, new `src/components/ui/CopiedToast.tsx`, `src/components/SoapNoteView.tsx`, `src/components/TranscriptView.tsx`.
1. `Toast.tsx`: `useSafeAreaInsets()` → `bottom: Math.max(48, insets.bottom + 16)`; default duration scales with message length (`Math.min(4000, 1500 + message.length * 30)`); keep the declarative contract (no global host — out of scope).
2. New `CopiedToast.tsx`: extract the duplicated inline mini-toast (`SoapNoteView.tsx:62-72`, `TranscriptView.tsx:42-49`); props `visible` + optional `label`; includes `accessibilityLiveRegion="polite"` **and** `AccessibilityInfo.announceForAccessibility(label)` on show (theme B/D groundwork).
3. Swap both consumers to it.

---

# PHASE 3 — Consistency passes (WP15–WP24)

## WP15 — Terminology + copy-catalog consolidation (+ strings fence)
**Audit:** theme C, catalog stragglers, stash-limit UX, silent-check durable variant.
**Files:** `src/constants/strings.ts`, `app/(app)/(tabs)/record.tsx`, `src/hooks/useStashedSessions.ts`, `src/lib/stashStorage.ts`, `app/(app)/(tabs)/_layout.tsx`, `app/(app)/(tabs)/recordings/[id].tsx`, `src/components/ProviderIssueBanner.tsx`, new `tests/strings-catalog-guard.test.mjs` (+ baseline JSON).
1. Tab label `(tabs)/_layout.tsx:101`: "Records" → "Recordings". `ProviderIssueBanner.tsx:38`: "CaptiVet" → "Captivet". `strings.ts:75`: Wi-Fi → "connect to the internet to sync".
2. Migrate inline stash/session alert copy into `strings.ts` (`STASH_COPY` + WP1's `DISCARD_SESSION_COPY`); consolidate vocabulary per theme C: **"Saved sessions"** (stash) and **"Not submitted"** (drafts); align banner/alert bodies.
3. `SILENT_CHECK_COPY`: add `bodyDurable` (no "Edit Recording" reference); `record.tsx:2229-2239` selects it when `slot.durable` is present.
4. `recordings/[id].tsx` stragglers (836-846, 979-999) → `RECORDING_DETAIL_COPY`; "Processing..." → "Processing…".
5. Export `MAX_STASHES` from `stashStorage.ts:4`; `useStashedSessions.ts:464` imports it (drop literal `5`). "Saved Full" (record.tsx:4204): label references the limit; tapping the disabled state explains "Resume or delete one to save another."
6. New `tests/strings-catalog-guard.test.mjs`: forbidden-literal fence (e.g. `CaptiVet`, migrated alert titles outside strings.ts, ASCII `...` in migrated files) against a baseline JSON.

## WP16 — Friendly error mapping (theme E)
**Files:** new `src/lib/errorCopy.ts`, `app/(app)/(tabs)/index.tsx:417-433`, `app/(app)/(tabs)/recordings/[id].tsx:976-1000`, `app/(app)/(tabs)/record.tsx:2733-2737`, `src/constants/strings.ts`, new `tests/error-copy.test.mjs`.
1. `friendlyErrorMessage(error, context)`: maps `ApiError` status/code → `ERROR_COPY` strings (network/5xx/timeout/default), following the `mfaPolicy.ts` pattern; never raw server text; keys off code/status only (Monitoring rule: no message pattern-matching).
2. Home error card: friendly one-liner + "Copy details for support" ghost action via `secureClipboard` (raw message behind the tap, not on screen).
3. Detail failed state: friendly headline + same copy-details action instead of `errorMessage.slice(0,200)`.
4. `record.tsx` uploadError fallthrough: route unknown errors through the mapper; phase-tagged telemetry untouched.

## WP17 — Raw Pressable → shared Button adoption
**Files:** `app/(app)/_layout.tsx` (127-156, 187-218), `src/components/SoapNoteView.tsx` (243-280), `src/components/TranscriptView.tsx` (54-72), `app/(app)/(tabs)/patient/[id].tsx` (302-336), `app/(app)/(tabs)/index.tsx` (400-408).
1. Half-auth + account-error screens: raw Pressables → `Button` (primary Retry, ghost Sign out) — roles/haptics/targets come free.
2. SoapNoteView/TranscriptView Copy/Edit/Copy All → `Button variant="secondary" size="sm"`; delete the local trailing-space hacks (Button now owns the mitigation per WP10); keep `CopiedToast` wiring.
3. patient/[id] Regenerate/"Trigger manually" → `Button variant="ghost" size="sm"` (labels modeled on the `AiSummaryText` toggle at 40-72).
4. Home "View All": add `hitSlop={HIT_SLOP}` + `accessibilityRole="link"`.
**Constraint:** Button's `onPress` already routes through `runMaybeAsyncEvent` — pass handlers directly, no double-wrapping.

## WP18 — Form-field unification + patients correctness
**Files:** `app/(app)/(tabs)/patient/[id].tsx`, `app/(app)/recording-recovery.tsx`, `src/constants/strings.ts`.
1. Replace the local `EditableField` (84-113) with shared `TextInputField`/`FormField` (multiline passes via rest props).
2. Add **Species** to edit mode (472-510), reusing the record form's species selector pattern; writes the existing `profileDraft.species`.
3. DOB (485-489): `keyboardType="numbers-and-punctuation"` + `YYYY-MM-DD` regex + `!isNaN(new Date(v).getTime())` (rule 11) inline error; full date picker deferred (code comment).
4. Error-vs-missing (251-258): fetch failure → `friendlyErrorMessage` + Retry (refetch); only true 404 → "Patient not found".
5. `recording-recovery.tsx` (336-367): four raw TextInputs → `TextInputField` with labels/required markers; rewrite mechanism copy (270-299) around outcomes → `RECOVERY_COPY` in strings.ts.
6. Remove patient/[id]'s hand-themed RefreshControl (defaulted by WP13).

## WP19 — Forgot/reset password modernization
**Files:** `app/(auth)/forgot-password.tsx`, `app/(auth)/reset-password.tsx`, `src/constants/strings.ts`.
1. Both: RN-core `SafeAreaView` → `react-native-safe-area-context`; add KAV + `ScrollView keyboardShouldPersistTaps="handled"` (copy `mfa.tsx:261-269`).
2. reset-password: `Alert.alert` validation (18-27) → inline `TextInputField` errors; add the eye-toggle `rightAccessory` (copy login's).
3. forgot-password success screen: "Resend email" with 30s cooldown; "Click the link" → "Tap the link" (:62).

## WP20 — Auth guards & MFA polish
**Files:** `src/components/AppLockGuard.tsx`, `src/components/DeviceRegistrationBanner.tsx`, `app/(auth)/mfa.tsx`, `app/(auth)/_layout.tsx`, `src/constants/strings.ts`.
1. AppLockGuard (198-202): cold-start renders wordmark + ActivityIndicator (no PHI) instead of blank; announce "App locked" on lock engage; cancelled biometric shows a "Try again" hint. **Do not restructure the biometric handler** (its try/catch + finally is crash-rule-protected) — only the rendered view.
2. DeviceRegistrationBanner: Retry → shared `Button size="sm"` (fixes role/target); surface retry failure (replace the `.catch(() => false)` swallow with visible "Retry failed" state); title `numberOfLines={2}`.
3. mfa.tsx: "Copy setup key" via `secureClipboard` + `CopiedToast` (359-367); "Restart" → "Start over" (337, 408); QR container gets a descriptive `accessibilityLabel` (353-358).
4. `(auth)/_layout.tsx:12-18`: spinner `accessibilityLabel="Loading"`.

## WP21 — Settings/devices/provider banner + settings route move
**Files:** `app/(app)/(tabs)/settings.tsx` → `app/(app)/settings.tsx` (git mv), `app/(app)/(tabs)/_layout.tsx`, `app/(app)/_layout.tsx`, `app/(app)/devices.tsx`, `src/components/ProviderIssueBanner.tsx`, `src/constants/strings.ts`.
1. Route move (decision #3): `git mv`; delete the hidden `Tabs.Screen` (114-118); register in the `(app)` Stack like sibling screens. Verify both `push('/settings')` sites and settings' child pushes resolve.
2. settings.tsx: `SectionHeading` gets `accessibilityRole="header"` (53-59); move the section-closing margin off the conditional Subscription row (310-333); `LifeBuoy` → `ShieldCheck` on the Privacy row (417-425).
3. devices.tsx: `formatRelativeTime` includes the year when not current (23-36, rule 11 guard); `MFA_REQUIRED` silent return (121-141) → Toast "Verify with MFA to revoke devices".
4. ProviderIssueBanner (32-43): rewrite to lead with impact ("SOAP notes may be delayed…"), demote provider/model/code detail; unify dismiss semantics (96-109) — Home's dismiss calls the same server-acknowledge mutation Settings uses (fall back to relabeling Home's as "Hide" only if auth scope prevents acknowledge; prefer unify).

## WP22 — Recordings list & patients search polish
**Files:** `app/(app)/(tabs)/recordings/index.tsx`, `app/(app)/(tabs)/patient/index.tsx`, `src/components/StatusBadge.tsx`, `app/(app)/(tabs)/recordings/[id].tsx`.
1. recordings list: FlatList `keyboardShouldPersistTaps="handled"` (448); search input (415-433) `returnKeyType="search"`, iOS `clearButtonMode="while-editing"`, Android clear-X when non-empty; placeholder → "Search patient or client…" (strings.ts).
2. Needs-review filter (182-199): always include the option (static list), independent of loaded pages.
3. `StatusBadge.tsx:82`: unknown status → neutral badge with title-cased raw string, no pulse.
4. patient/index: `User` icon → `Search` (:93); query (31-54) gets `placeholderData: keepPreviousData`.
5. recordings/[id]: client-name cell `numberOfLines={2}` (697-704).

## WP23 — Record-flow polish (slot card, tab strip, timers, stash friction)
**Files:** `src/components/PatientSlotCard.tsx`, `src/components/PatientTabStrip.tsx`, `src/components/RecorderLiveReadout.tsx`, `app/(app)/audio-editor.tsx` (timer), `src/components/StashedSessionCard.tsx`, `app/(app)/(tabs)/record.tsx` (3613-3620), new `src/lib/formatClock.ts` + `tests/format-clock.test.mjs`.
1. `formatClockDuration(seconds)`: MM:SS under 60min, H:MM:SS at ≥60min; adopt in `PatientSlotCard:104-108`, `RecorderLiveReadout:19-23`, `audio-editor:22-26`. Pure fn + test.
2. PatientSlotCard: gate "Processing usually takes 1-2 minutes." on `uploadStatus === 'success'` (616-620); visible caption under the disabled mic in non-record-first mode (263, 442-468); slot ScrollView keyboard insets (338-343, iOS `automaticallyAdjustKeyboardInsets`).
3. PatientTabStrip (37-71): recorded-not-submitted dot → `bg-status-warning` (amber; uploaded stays green — matches Home's "Not Submitted"); at 10-slot max (184-196) keep a **disabled** "+" with `accessibilityState={{ disabled: true }}` and a tap-toast "Maximum 10 patients per session".
4. record.tsx:3613-3620: drop the "Save for Later?" confirm when no recorder is live; keep it for the stop-live-recorder variant.
5. StashedSessionCard.tsx:36: remove hardcoded `'en-US'` locale (rule 11 guard).

## WP24 — Audio editor polish + adjustable-role wiring
**Files:** `app/(app)/audio-editor.tsx`, `src/components/TrimOverlay.tsx`, `src/components/StaticWaveform.tsx`, `app/(app)/(tabs)/record.tsx` (4286-4291), `src/components/WaveformEditor.tsx`.
1. Explicit merge (394-431): don't auto-concat on multi-segment open — offer "Merge N segments to edit" / Cancel; set `hasChanges=true` only after a real user edit (fixes phantom "Discard Changes?").
2. "No recording to edit." branch (1395-1401): render the standard header with back button.
3. Touch targets: merge arrow + segment-delete × (1499-1511, 236-251) and nudge buttons (1576-1591) → hitSlop to ≥44pt effective.
4. TrimOverlay time badge (14, 530-546): `minWidth` instead of fixed 64px width.
5. Adjustable roles: wire `accessibilityActions={[{name:'increment'},{name:'decrement'}]}` + handler (copy the `RecordingAudioPlayer.tsx:195-220` template — the repo's only existing instance) into TrimOverlay handles (427-447) and the record-screen pagination dots (record.tsx:4286-4291, or downgrade that role); `StaticWaveform` (104-106, non-interactive) → role `image` with descriptive label.
6. Zoom discoverability (WaveformEditor 156-261): one-time "Pinch to zoom" hint chip (seen-flag in AsyncStorage — non-secure data, fine).
7. "Merging segments…" (1386-1392): add Cancel via `FFmpegKit.cancel(sessionId)` falling back to per-segment mode; if cancel proves unreliable in testing, ship without it and add "This can take a minute on older tablets."
**Constraint:** rule 6 — do not alter recorder-hook error handling; FFmpeg ops keep existing try/catch structure.

---

# PHASE 4 — Bigger UX investments (WP25–WP31)

## WP25 — Playback speed control
**Files:** `src/hooks/useAudioPlayback.ts`, `src/components/RecordingAudioPlayer.tsx`, `src/constants/strings.ts`.
1. Hook: expose `playbackRate` + `setPlaybackRate(rate)` calling expo-audio `player.setPlaybackRate(rate, 'high')` in try/catch (native audio ops throw — rule 6 spirit); re-apply the current rate after `player.replace()` source swaps (multi-part recordings).
2. UI (585-635): cycle chip 1x → 1.25x → 1.5x → 2x beside the transport controls, `accessibilityLabel` "Playback speed, {rate}x", ≥44pt. Also bump the "Part n" chips (640-657) `minHeight` 32 → 44.
3. `AUDIO_PLAYER_COPY.speed(rate)` in strings.ts.
**Verify:** play a local draft at 2x on emulator.

## WP26 — Transcript chunking + copy ergonomics
**Files:** `src/components/TranscriptView.tsx`, new `tests/transcript-chunking.test.mjs`.
1. Per decision #4: exported `chunkTranscript(text)` — threshold ~6,000 chars; split on `\n\n+`, fallback ~1,500-char sentence groups; render chunks as separate `selectable` Texts; below threshold keep the single Text (51-53).
2. Move Copy into a header row mirroring SoapNoteView's Copy All (shared Button post-WP17 + `CopiedToast`).
3. Test: threshold behavior, round-trip content preservation, boundary handling.

## WP27 — Copy-feedback standardization + card upgrades
**Files:** `src/components/ExportSheet.tsx`, `src/components/ClientEmailCard.tsx`, `src/components/TranslationCard.tsx`.
1. Replace persistent status captions (169 / 155 / 163) with the shared `CopiedToast`/`Toast` pattern (auto-dismissing, near the control); error strings keep an inline mapped display (Toast is `pointerEvents="none"`).
2. `ClientEmailCard:123`: expandable preview ("Show more"/"Show less" toggling `numberOfLines={8}`).
3. `TranslationCard:157`: plain Text → `MarkdownText` (exists; `toPlainText` stays for the copy path).
4. Live-region + announce come free from WP14's CopiedToast.

## WP28 — Offline persistence for completed notes
**Files:** `src/lib/queryClient.ts`, `src/auth/AuthProvider.tsx`, `app/_layout.tsx` (provider wiring), `package.json`.
**New deps:** `@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister` (v5, matching `^5.101.1`); install with `npm install --legacy-peer-deps` (EAS lockfile rule). AsyncStorage 2.2.0 already installed.
1. `createUserPersister(userId)` → `createAsyncStoragePersister({ storage: AsyncStorage, key: \`captivet_rq_cache_${userId}\`, throttleTime: 2000 })`.
2. Activate persistence only once `userId` is known (mirror `draftStorage.setUserId` timing in `fetchUser()`); `buster` = appVersion + userId; `maxAge` 7 days; `shouldDehydrateQuery` allowlist: recordings list/detail, soapNote, patients — never auth/session/devices/subscription.
3. Sign-out/user-switch: `persister.removeClient()` for the outgoing user alongside the existing `queryClient.clear()` (persisted cache is transient per rule 8 — unlike drafts, it does not survive logout).
4. Per-query `gcTime` ≥ maxAge for allowlisted keys (React Query won't persist past gcTime); not global.
**Constraints:** rule 13 scoping discipline; rule 1 — create the persister lazily in an effect with try/catch, never at module load.
**Verify:** load list online → kill app → airplane mode → relaunch → cached list renders; sign out → relaunch offline → no cross-user data.

## WP29 — iOS VoiceOver announcement sweep + card actions
**Files:** `app/(app)/(tabs)/record.tsx`, `src/components/PatientSlotCard.tsx` (:379), `src/components/ProcessingStepper.tsx` (47-48, 98-106), `src/components/RecordingCard.tsx` (148-165, 205-214).
1. Recorder transitions (start/pause/resume/finish): `AccessibilityInfo.announceForAccessibility` at the transition sites (generic copy, no PHI); keep the Android `accessibilityLiveRegion` attributes.
2. ProcessingStepper: announce step transitions politely (effect watching current step); mark the rotating warmth text `importantForAccessibility="no"` so it isn't announced noise.
3. RecordingCard: replace nested inner Pressables with `accessibilityActions` on the card (default activate = open; custom "Open patient history"); enlarge the visible history-link hitSlop to ≥44pt.

## WP30 — Home banner priority system
**Files:** `app/(app)/(tabs)/index.tsx` (242-267), `app/(app)/_layout.tsx` (223-224), new `src/components/BannerStack.tsx` (or `useBannerPriority` hook).
1. Priority-ordered selector: durable-recovery > device-limit > device-registration > provider-issue > offline. Render only the top-priority banner; if others are active, a collapsed "+N more alerts" row expands the stack on tap.
2. The two globally-mounted banners keep living in `_layout.tsx` but their visibility gates through the shared priority hook so Home shows at most one + the collapse row.
**Verify:** force offline + provider issue simultaneously → single banner + "+1 more".

## WP31 — Remaining lows: pagination, grouping, design-system sweep
**Files:** `app/(app)/(tabs)/patient/[id].tsx`, `app/(app)/(tabs)/recordings/index.tsx`, `src/components/ui/Badge.tsx`/`Banner.tsx` + `src/components/StatusBadge.tsx` (types), `app/(app)/_layout.tsx`, `src/components/UploadOverlay.tsx`, `src/components/DeviceRegistrationBanner.tsx`, `app/(app)/durable-recovery.tsx`, `src/components/ui/Select.tsx` + `Sheet.tsx` + `Skeleton.tsx` (comments).
1. Visits pagination (138-145, 360-403): `useInfiniteQuery` + "Load more visits" row if the API supports it; else a "Showing 20 most recent" caption + View-all raise-limit.
2. Recordings date grouping (optional Low): "This week / Earlier" section headers only if it doesn't disturb pagination; otherwise document as deferred in the commit message.
3. Variant-vocab convergence: converge Badge/Banner/StatusBadge on one `info|success|warning|danger` enum via type aliases that accept legacy names (mapped internally) — no call-site behavior change.
4. Raw text-size sweep: replace remaining raw `text-xs/sm/lg` classes (`durable-recovery.tsx:180,182`; `UploadOverlay.tsx:161,169,170,189,197`; `DeviceRegistrationBanner.tsx:37,40,54`) and inline `fontSize:` numbers in `(app)/_layout.tsx` screens with the semantic scale (`caption`/`body-sm`/`body`/`body-lg`); the 11px tab bar stays with a comment.
5. Convention comments (no behavior): `Select.tsx` — `searchable` as growth path; `Sheet.tsx` — scrim/panel split as future polish; `Skeleton.tsx` — "Skeleton for content, spinner for in-button busy".
**Verify:** full emulator smoke Home → Record → Recordings → Settings; all fences green.

---

## Dependency graph / sequencing

- **WP1–WP9** are independent of the foundations and of each other; commit in the order given (WP2 uses the existing Toast; WP14 later upgrades it with no API change).
- **WP10 before WP17 and WP27** (Button adoption relies on the baked-in clipping fix). **WP14 before WP26/WP27** (shared CopiedToast). **WP16 before WP18** (`friendlyErrorMessage` reuse).
- Fence tests land in the same commit as their sweeps (WP12, WP15).
- **New deps only in WP28**; `expo-apple-authentication` is already installed (WP4 only adds the lazy-require usage).
- New tests (all Node-runner, grep-the-source or pure-logic style per `tests/dark-mode-guard.test.mjs`): `ui-clip-guard`, `font-scaling-guard`, `theme-token-guard` (+ baseline), `strings-catalog-guard` (+ baseline), `error-copy`, `format-clock`, `transcript-chunking`, `upload-overlay-batch`.

## Audit-phase coverage map

| Audit remediation phase | Work packages |
|---|---|
| Phase 1 — correctness & data safety | WP1–WP9 |
| Phase 2 — one-file propagating fixes | WP10–WP14 |
| Phase 3 — consistency passes | WP15–WP24 |
| Phase 4 — bigger UX investments | WP25–WP31 |

## End-to-end verification (after all WPs)

1. `npm run typecheck && npm test && npm run lint` — all green including the eight new fences/logic tests.
2. Emulator full-flow smoke (per CLAUDE.md Emulator Testing): sign-in (autofill props visible in inspector), record a two-patient session, swipe mid-recording (pause toast), Finish (draft), nav away (no false discard warning), Save for Later, Resume (drafts preserved), Submit (overlay batch math correct up to the emulator's silent-check limit), Recordings list (search one-tap, named submitted banner), detail (back returns to origin), SOAP note (Button-based actions, playback speed), Settings (moved route, tab bar consistent), dark mode + `font_scale 1.6` passes on record/recordings/settings.
3. Physical-Android check for the clipping class (emulator hides it): Button/Banner labels, chips.
4. Offline check: cached recordings list renders in airplane mode after WP28; sign-out clears it.

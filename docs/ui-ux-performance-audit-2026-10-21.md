# Captivet Mobile — UI/UX & Performance Audit

**Date:** 2026-10-21 · **Code:** `main` @ `d1eab53` (v1.13.23)
**Supersedes for planning purposes:** `docs/ui-ux-audit-2026-07-17.md` (its status is tracked in §8)
**Scope:** every screen in `app/`, every component in `src/components/`, plus cross-cutting rendering, startup, network, persistence, battery, accessibility, platform conventions, tablet support and design-system health.

**Method:**
- Six parallel review passes:
  1. Rendering and list performance.
  2. Startup, network, memory and battery.
  3. Accessibility and platform conventions.
  4. Task flows and information architecture.
  5. Design-system consistency.
  6. Verification of the July audit's status.
- Every High finding was then re-checked by reading the current code.
- Measured inputs:
  - Production Android export (`expo export`, with and without Hermes bytecode), attributed to packages through the source map.
  - Bundle size re-measured with Expo tree shaking turned on.
  - Contrast ratios computed from `global.css`.
  - Tailwind compiled to confirm which class names produce no CSS.
- Baseline at audit time: `tsc --noEmit` clean; `npm test` **1410/1410 passing**.

**What this audit cannot tell you:** it is a static code review. Nothing was run on a device. Timings marked *est.* are reasoned from code and hardware class, not measured. Items marked **Needs device check** or **Needs profiling** should be confirmed before you prioritize them by cost. §9 gives the measurement plan.

**Severity:**
- **High:** loses or hides work, misleads the user about state, blocks a user group, or causes seconds of delay or jank on target hardware.
- **Medium:** real friction, avoidable cost on a hot path, or an AA failure with a workaround.
- **Low:** polish.

---

## 1. Bottom line

The July audit worked. All 17 of its High findings are fixed, 62 of 66 Mediums and 52 of 58 Lows. Guard tests now enforce many of those fixes. The rule-level discipline is better than in most production RN apps:
- every primitive bakes in roles, haptics, async-safety and the Bold-text mitigation;
- reduce-motion is respected everywhere through Reanimated;
- recorder metering never touches React state.

**The remaining risk is not in rule compliance.** It sits where systems interact, which no per-file guard can see:

1. **Three app-wide behaviours break core jobs.**
   - The clipboard is wiped the moment the app leaves the foreground, so "copy note → paste into PIMS/Mail/authenticator" fails on the same device.
   - The biometric re-lock *unmounts the whole app*, which stops a screen-off recording and throws away the session.
   - A Saved-for-Later recording is shown as "Audio Not on This Device" next to a red **Delete Draft** button.
2. **The unsent-work model is incoherent.** Work can live in five places with different names, limits and counts. The 30-day cleanup is a one-tap bulk delete with no list, and the 23-day heads-up that rule 13 promises only runs in `__DEV__`.
3. **After Finish, the screen says "done".** A green "Recording Complete" badge, a primary-large "Continue Recording" button and a "syncing to server…" banner all suggest it is done or auto-uploading. Nothing is processed until Submit, which may be below the fold.
4. **Performance cost comes from architecture, not hot loops.**
   - Cold start chains roughly three network round trips in series before the first usable screen.
   - The offline query cache keeps every opened transcript for 7 days and re-serializes the whole snapshot during polling.
   - Six handlers in the 7,900-line `record.tsx` re-render every mounted patient card on each keystroke and upload tick.
   - The JS bundle is 8.0 MB, 15% of it unused icons.
5. **Accessibility and tablet gaps remain.**
   - iOS VoiceOver can't operate the audio editor's trim handles, the seek bar or the patient pager.
   - Brand teal and danger red fall below AA.
   - Input outlines are 1.5:1.
   - The "portrait lock" the layouts depend on doesn't hold on iPads or Android 16 tablets, and the Record screen has no width constraint.

### Challenge to the framing

"Did we follow best practices?" mostly gets a yes, and that is the trap. The guard tests fence the patterns you have already been burned by. They can't catch:
- a className that doesn't exist (four auth titles render at 14px today);
- a security-era behaviour (clipboard wipe) left in place after the owner decided these records aren't HIPAA;
- a state model that grew into five buckets.

The next step up isn't more rules. It's **(a) device measurements against explicit budgets** (§9) and **(b) watching 2–3 vets do a real appointment**. Several findings below (H6, H7, M-UX-4) are predictions about behaviour that only observation will confirm or kill.

---

## 2. Measured numbers

| Metric | Value | Note |
|---|---|---|
| Android JS bundle (minified, no bytecode) | **8.04 MB** | Hermes `.hbc` is 7.9 MB |
| `lucide-react-native` share | **1.18 MB (15%)** | 68 icons used out of ~1,700 bundled; the whole barrel is evaluated at startup |
| Bundle with `EXPO_UNSTABLE_TREE_SHAKING=1` + `EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1` | **6.44 MB (−20%)** | lucide drops out of the top list; experimental flag, needs regression testing |
| Other large contributors | reanimated 721 KB, react-native 708 KB, zod 501 KB, Sentry (core + RN + replay + feedback + browser) ~840 KB, PostHog 418 KB | Sentry replay/feedback (~180 KB) ship although replay is disabled |
| Material Symbols fonts in the asset list | **7 × ~960 KB ≈ 6.8 MB** | Pulled in by `expo-router → expo-symbols → @expo-google-fonts/material-symbols`; the app uses no `NativeTabs`/`SymbolView`. Confirm with `unzip -l` on a release APK. |
| `record.tsx` | 7,924 lines, 103 KB minified | ~22 `useState`, 53 `useRef`, 69 `useCallback`, 28 `useEffect` in one component |
| Inter.ttf | 876 KB variable font | a Latin subset would save ~0.6 MB of app size |
| Inline requires | **off** (Expo default `inlineRequires: false`; `metro.config.js` doesn't override) | the whole static import graph runs before first paint |

---

## 3. Top 15 priority fixes

| # | Fix | Where | Why first |
|---|---|---|---|
| 1 | Stop wiping the clipboard on background (keep or drop the 30s timer) | `src/lib/secureClipboard.ts:9-19` | The primary job, copying the note out, fails on the same device; "Open in Mail" copies, then clears |
| 2 | Render the app lock as an overlay over still-mounted children, and skip the resume lock while a recorder is live | `src/components/AppLockGuard.tsx:340-388`, `app/(app)/_layout.tsx:198` | Unlocking after a screen-off exam stops the recording and drops the session |
| 3 | Treat stash-held `serverDraftId`s as local, and route those cards to Saved Sessions | `recordings/[id].tsx:642-657`, `useLocalDraftRecordings.ts`, `RecordingCard.tsx` | The app tells the vet their saved work isn't on the device and offers Delete |
| 4 | Replace the 30-day bulk-delete alert with a review list (per-item Submit/Delete) and ship the 23-day heads-up | `record.tsx:7140-7189` | One tap irreversibly deletes N unsent recordings, unlisted, on Record-tab mount |
| 5 | Guard unsaved SOAP section edits with `usePreventRemove` | `SoapNoteView.tsx:93-94`, `recordings/[id].tsx:912-946` | Typed clinical text is silently lost on Back or swipe |
| 6 | Post-Finish hierarchy: amber "Recorded — not submitted", Submit as the only primary, banner copy that says "not submitted" | `PatientSlotCard.tsx:469, 633-639`, `strings.ts:469-470` | Vets leave believing the recording was sent |
| 7 | Run `registerDevice()` in parallel with `/auth/me`; fall back to the cached profile on the first retryable failure; 10s cold-start timeout | `AuthProvider.tsx:1161-1172, 1228-1256` | One extra round trip on every cold start; ~127s before offline drafts are reachable on captive Wi-Fi |
| 8 | Bound the persisted query cache (strip `transcriptText`, cap detail entries, persist only on success of persisted keys, longer debounce) | `src/lib/queryPersistence.ts:42-58, 196-222` | Unbounded growth, whole-snapshot `JSON.stringify` during polling, silent failure past AsyncStorage's Android limits |
| 9 | Read `sessionRef.current` inside the six slot handlers; skip no-op progress dispatches; hoist `EMPTY_TEMPLATES` | `record.tsx:2013, 2092, 2902, 2961, 3051, 7419, 3946-3955`; `useTemplates.ts:19` | Every keystroke and upload tick re-renders every mounted patient card |
| 10 | `useMemo` the TrimOverlay gestures; take the per-frame badge `setState` off the JS thread | `TrimOverlay.tsx:135-268, 349-365` | The editor's main interaction fights the JS thread at 60 Hz |
| 11 | Set `accessible` + `accessibilityValue` on adjustable/progress Views (trim handles, seek bar, pager, progress bars, stepper) | `TrimOverlay.tsx:427,450`, `RecordingAudioPlayer.tsx:220`, `record.tsx:7812`, … | VoiceOver can't adjust the trim start, scrub, or read progress |
| 12 | Turn on `inlineRequires` and fix the lucide barrel (tree shaking or per-icon imports); stub the unused Material Symbols fonts | `metro.config.js` | Measured −1.6 MB of JS (−20%) and ~6.8 MB of app size; startup gain to be profiled |
| 13 | Darken light `--brand-500` (or use `brand-600` for fills and links) and `danger-600` for the danger button; add an input-border token ≥3:1 | `global.css:19-20`, `ui/Button.tsx:44-46`, `TextInputField.tsx:43-47` | Every primary CTA is 4.43:1, danger 3.76:1, input outlines 1.49:1 |
| 14 | Tablet: constrain the Record content to `CONTENT_MAX_WIDTH`; re-align the pager when the width changes; stop assuming portrait | `PatientSlotCard.tsx:410-416`, `record.tsx:7638-7647, 1968-1980`, `app.config.ts:220` | Target hardware is clinic tablets; a misaligned pager risks typing into the wrong patient's form |
| 15 | Fix the two class names that don't exist, and add a guard that fails on any className producing no CSS | `forgot-password.tsx:109,175`, `reset-password.tsx:140`, `mfa.tsx:279` (`text-heading-lg`); `RecordingAudioDownload.tsx:251` (`border-border-subtle`) | Auth titles render smaller than body text; a black hairline in dark mode; the guard closes the whole class of bug |

---

## 4. Findings — UX, flows and information architecture

### High

**UX-H1. The clipboard is cleared as soon as the app backgrounds or goes inactive.** Verified.
- **Where:** `src/lib/secureClipboard.ts:9-19`. The listener fires on any `AppState` other than `active`. On iOS that includes `inactive`, so even opening the app switcher or Control Center wipes it.
- **Breaks:**
  - **Copy All** → switch to ezyVet → paste gives nothing.
  - `ClientEmailCard` "Open in Mail" copies the body, then opens Mail. Opening Mail backgrounds the app and clears the clipboard, while the UI says "Draft copied. Open your mail app and paste it." (`ClientEmailCard.tsx:66-91`, `strings.ts:492-493`).
  - Same-device MFA setup: the copied setup key is wiped when switching to the authenticator app (`mfa.tsx:425-436`).
- **Owner-decision conflict:** the file's comment says "PHI should not linger". That predates the 2026-05-29 decision that these records aren't HIPAA.
- **Fix:** remove the clear-on-background. Keep the 30s timer only if you still want it; consider 2–5 minutes. Add an `otpauth://` "Open in authenticator" button to MFA setup.
- **Needs device check:** paste behaviour per platform.

**UX-H2. The biometric re-lock unmounts the entire signed-in tree.** Verified code path; **Needs device check**.
- **Where:** `AppLockGuard` wraps the whole `(app)` Stack (`app/(app)/_layout.tsx:198`). On resume after ≥30s in background with lock enabled, it returns the lock screen *instead of* `children` (`AppLockGuard.tsx:340-388`). `record.tsx` intentionally keeps recording through screen-off (`:4960-4972`), but its unmount effect stops durable capture (`:2493-2545`).
- **What happens:**
  1. The vet records with the phone pocketed and the screen off.
  2. On unlock, the lock screen mounts and the Record screen unmounts, so recording stops.
  3. After biometrics they land on Home, with the in-memory session gone.
- The same reset hits any open screen (an unsaved SOAP edit, a half-filled form) after a ≥30s trip to another app.
- **Fix:**
  - Render the lock as an opaque, accessibility-modal overlay above mounted children (`accessibilityViewIsModal`, plus `importantForAccessibility="no-hide-descendants"` on the content).
  - Defer the resume lock while a recorder is bound (`recordingActivity`).
  - Keep the cold-start lock as-is.

**UX-H3. Saved-for-Later recordings show as "Audio Not on This Device" with a red Delete Draft.** Verified.
- **Why:** Stashing deletes the local draft but keeps the server draft row (by design, CLAUDE.md Draft-Save-on-Finish §2). The detail screen only looks in `draftStorage` (`recordings/[id].tsx:642-657`). `useLocalDraftRecordings`/`draftRecordings.ts` have no stash awareness.
- **What the user sees:** Home/Recordings show "Not Submitted · Not on this device". The detail screen says the draft "was started on another device… delete it here to clean up" (`strings.ts:351-354`) beside **Delete Draft** (`[id].tsx:~1547`).
- **Fix:** include stash slots' `serverDraftId`s in the draft-presence map and route those cards to Saved Sessions. On the detail screen, run `findLocalRecoveryAnchor` for drafts too and show "Open saved session" instead of Delete when a stash holds it.

**UX-H4. The 30-day "Recordings Expiring" alert is a one-tap bulk delete.** Verified.
- **Where:** `record.tsx:7140-7189`.
- **Problems:**
  - The modal fires on Record-tab mount (i.e. as an exam starts).
  - It says "Submit them now, or delete…?" but offers only *Keep for now* / *Delete*: no Submit, no list of which recordings.
  - *Delete* removes every expired draft, server rows included, and every expired stash, with no second confirm and no result feedback.
  - The 23-day heads-up rule 13 promises exists only as a `__DEV__` `console.log` (`:7186-7188`).
- **Fix:**
  - Replace it with a non-modal Attention/Home row ("3 unsent recordings are 30+ days old · Review") that opens a list with per-item Submit/Delete.
  - Ship the 23-day heads-up and an age chip on Not Submitted cards.
  - Never prompt on Record mount.

**UX-H5. Unsaved SOAP edits are discarded silently.** Verified.
- **Where:** `SoapNoteView.tsx:93-94` holds the edit in local state. No back path in `recordings/[id].tsx:912-946` guards it; `usePreventRemove` exists only in `record.tsx` and `audio-editor.tsx`. The profile and patient edit forms have the same gap.
- **Fix:** lift a dirty flag (`isEditing && draft !== content`) to the screen and add `usePreventRemove` with a Discard/Keep editing confirm.

**UX-H6. After Finish, the screen reads as "done / auto-uploading".** Verified.
- **The signals:**
  - A green `success` "Recording Complete" badge (`PatientSlotCard.tsx:469`).
  - **Continue Recording** as `primary size="lg"`, first in the stack (`:633-639`).
  - In record-first mode, the details and foreign-language cards sit between the recorder and Submit (`:785-786`). Submit & Generate is *also* primary-lg (`:1002-1004`), often below the fold; with several slots, Submit All adds a third primary.
  - The amber banner says "Draft saved locally — syncing to server…" / "pending upload — connect to the internet to sync" (`strings.ts:469-470`). The vet hears "it will upload and process on its own". It only creates a placeholder row.
- **Fix:**
  - Amber "Recorded — not submitted".
  - **Submit & Generate SOAP Note** as the only primary, directly under the timer or as a sticky footer; Continue and Edit become secondary.
  - Banner: "Saved on this device — not submitted. Tap Submit to generate the SOAP note." Make it tap through to the draft, and hide it for drafts not in the current session.

**UX-H7. Unsent work lives in five places with different names, limits and counts.** Verified.
- **The five places:**
  1. Drafts ("Not Submitted", unlimited).
  2. Saved Sessions (Record tab only, max 5, hidden while the session has unsaved work, `record.tsx:7423`).
  3. Recovered Recordings (Home banner only, `index.tsx:459`).
  4. Local Recovery vault (Settings + Home).
  5. The live session.
- **The counts disagree:**
  - The sign-out warning counts a 4-patient saved session as 1 and ignores recoveries (`localRecordings.ts:24-45`, `unsentCount.ts:23-25`).
  - The Attention feed says "1 saved session".
  - Home lists the stashed server rows as "Not on this device" (UX-H3).
- Finish already auto-drafts, so Save for Later mostly moves work between two near-identical buckets.
- **Fix (product decision):**
  - One user concept ("Unsent"), grouped by patient, with a location chip.
  - Save for Later becomes "clear the screen, keep as unsent".
  - One canonical list (Recordings → Not Submitted) that includes stashes, recoveries and vault items.
  - Counts by patient-recording everywhere.

### Medium

| ID | Finding | Where | Recommended change |
|---|---|---|---|
| UX-M1 | Recovered audio has to be identified blind. Cards read "Unsaved recording · 3:42"; Review & Submit opens a blank form; no preview playback, so it's easy to attach the wrong patient | `durable-recovery.tsx:84,196-219`; `recording-recovery.tsx` | 10–15s preview player per card; carry through any known form data or stash name |
| UX-M2 | The vault's "Appointment type" is free text but the schema is an enum, so submit fails later | `recording-recovery.tsx:359` vs `validation.ts:10,21-26` | Reuse `APPOINTMENT_TYPE_OPTIONS` Select from `PatientForm` |
| UX-M3 | Durable recoveries are surfaced only on Home (the banner comment says Home + Record); not in the Attention feed, Settings, or the sign-out count | `index.tsx:459`, `DurableRecoveryBanner.tsx` | Show on Record too; add a feed row and a Settings entry; include in unsent counts |
| UX-M4 | Phone-call interruption: the legacy path auto-resumes, the durable path stops and waits for a tap. The backend is invisible to the user, so they keep dictating unrecorded | `strings.ts:460-465`, `record.tsx:7750-7777` | Auto-resume durable capture too, or a loud full-width "Recording stopped — tap to resume" plus haptic on return |
| UX-M5 | Offline is discovered by failing. `OfflineBanner` only reflects a cached profile; the submit error doesn't say the recording is safe; no queue or "Submit all unsent" | `OfflineBanner.tsx`, `strings.ts:303,816` | Global connectivity strip; "Saved on this device; submit when back online"; batch-submit drafts on reconnect |
| UX-M6 | Detail screen: the first control above the note is **Regenerate SOAP**; a full player card pushes the note down; Copy All appears twice; Retry, Regenerate and Reprocess are three "re-run" concepts, none warning that edits will be lost | `recordings/[id].tsx:1291,1745-1760,1794` | Copy All (primary) in the note header only; Regenerate moves under Tools with Reprocess; collapse the player to one row for completed notes |
| UX-M7 | Reading a full note: one section open at a time (opening Plan collapses Assessment); the editor shows raw markdown; raw `error.message` on save failure | `SoapNoteView.tsx:133-147,276,344` | Expand all by default or allow several open; plain-text edit; friendly errors |
| UX-M8 | Export to PIMS is disconnected from copy. Copy All doesn't mark it exported; the PIMS choice isn't remembered; lists don't show exported state | `ExportSheet.tsx:43-55,85-99,155-190` | "Copy & mark exported" in one tap; remember the clinic's PIMS; "Exported" chip on `RecordingCard` |
| UX-M9 | Home shows the same unsent drafts three times (Attention row, uncapped Not Submitted list, status pill) | `index.tsx:313-327,577-594` | Suppress the local-drafts Attention row when the list is visible; cap the list at ~3 + "Show all unsent" |
| UX-M10 | Entry points land on screens that don't show what was promised. "Open drafts" lands on Recordings with filter = All; "Open saved sessions" lands on Record where Saved Sessions may be hidden; sign-out "Review" goes to Record, but the counted drafts are on Home/Recordings | `attentionFeed.ts:1001-1018`, `AttentionFeedSection.tsx:36-39`, `settings.tsx:232-236` | Accept `?status=draft` on Recordings; always show a collapsed "Saved Sessions (N)" row; route Review to the unified unsent list |
| UX-M11 | **Challenge:** for any practice with >100 recordings, "Needs Attention" is always on, often showing only "View recent attention ›", with a "Checking…" flash and layout shift on each cold open. A section that is always there and usually empty trains people to ignore it | `useAttentionFeed.ts:322`, `attentionFeed.ts:1224-1228`, `AttentionFeedSection.tsx:226-237` | Keep the honesty, drop the alarm: one quiet line ("Recent check: nothing found in the last 100 updates") |
| UX-M12 | Attention status copy is written for engineers ("Some recording timing data could not be checked") | `strings.ts:927-933` | "Couldn't finish checking — Retry", with detail behind "Copy details" |
| UX-M13 | The minimum-version gate is found mid-exam: OK-only alert on Start, with no store link | `record.tsx:2138-2144` | Persistent Home/Record banner once the floor is known, with a store deep link |
| UX-M14 | For support staff, the Home hero opens a long, alarming alert | `index.tsx:356-365,536-568` | Swap the hero for their real job for this role |
| UX-M15 | Raw server error text still reaches screens: the Recordings list shows "[ApiError 500] …", plus detail load/delete/regenerate, SOAP save, and patient detail | `recordings/index.tsx:598-604`, `[id].tsx:448,858,986`, `SoapNoteView.tsx:144`, `patient/[id].tsx:244-247` | Route through `friendlyErrorMessage` + "Copy details for support", as Home already does |
| UX-M16 | Upload-recovery copy is jargon ("new upload identity", "conflicted server attempt") | `PatientSlotCard.tsx:947-948`, `record.tsx` restart/recovery alerts | Plain outcomes: "Your audio is safe. Tap to try again — this won't create a duplicate." |
| UX-M17 | Status colours are overloaded. Amber means in progress (Transcribing), needs action (Not Submitted, Awaiting Details) *and* paused; Generating is green; every in-progress pill gets a teal glow; the tab strip shares one amber dot for paused and recorded-not-submitted, with no error dot | `StatusBadge.tsx:17-28,107-110`, `PatientTabStrip.tsx:38-100` | Blue = in progress, amber = needs you, red = failed, green = done; add an error dot; check parity with Connect |
| UX-M18 | "Awaiting Details" is a dead end on mobile ("Complete the details on the web app"), yet it counts as needing attention | `strings.ts:349-350`, `[id].tsx` gates `MetadataReviewCard` on `completed` | Offer the existing metadata sheet for `pending_metadata` |
| UX-M19 | A patient's page has no "Record visit" action | `patient/[id].tsx` | CTA that pre-fills patient, client, species and PIMS ID |
| UX-M20 | Silence is detected only at submit; a 20-minute exam on a blocked mic is discovered after Finish | `record.tsx` `checkSilentAudio`; `RecorderLiveReadout.tsx` | Live "No audio detected" hint after ~10s near the noise floor |
| UX-M21 | Multi-patient blockers don't name the patient ("Add Required Details", count-only alert); the record-first multi-patient alert has two choices that both just dismiss | `SubmitPanel.tsx:90-107`, `record.tsx:6415-6420,6580-6588` | Name the patients and jump to the first; make the choices do different things or drop the alert |
| UX-M22 | Metadata review uses near-synonym actions ("Save & finish review" / "Keep current details" / "Edit Details") over three stacked lists | `MetadataReviewCard.tsx`, `strings.ts:750-751` | "Looks right" / "Fix details"; one per-field list |

### Low
- **Upload overlay labels:** says "Processing…" at ≥95% while still uploading; "Uploaded Successfully… check your recordings list" has no link (`UploadOverlay.tsx`, `PatientSlotCard.tsx:1034-1037`).
- **Record screen chrome:** a repeated title, subtitle and "Record" card title cost ~80px on phones every visit (`PatientSlotCard.tsx:451`).
- **Mislabelled button:** the draft detail card titled "Finish Recording" has a **Continue Recording** button that actually opens review/submit (`[id].tsx:1489-1510`).
- **Clinic Quality card:**
  - "7 min to 90%" reads like a progress bar.
  - "rec" is abbreviated, and spoken as "rec".
  - Raw role strings (`support_staff`).
  - Tiles don't tap through.
  - *Challenge:* every vet sees colleague-level counts.
- **Developer strings in the vault:** `item.kind.replace('_',' ')`, "User 1a2b3c4d" (`recording-recovery.tsx:317`).
- **Permission screen:** the 4s mic-permission watchdog can show "Microphone Access" when access is already granted (`record.tsx:7883`).
- **Modal for a success:** "Trim Applied" is an Alert; use a toast.
- **No undo** on suggested-task Accept/Dismiss (`SuggestedTasksCard.tsx:75-132`).
- **Functional bug: long-press nudge doesn't repeat.** The interval captures a stale `trimStart`/`trimEnd` closure, so it computes the same value each tick while haptics fire at 10 Hz (`audio-editor.tsx:753-794`). Fix with functional `setState`. Verified.

### Flow scorecard (est.)

| Job | Taps | Biggest friction | Grade |
|---|---|---|---|
| Record one appointment → SOAP → PIMS | ~6 (record-first) / ~11 + typing | Clipboard wipe (UX-H1); Submit below the fold and competing (UX-H6) | **C** |
| Several patients back to back | ~5/patient + Submit All | Ambiguous tab dots, no error dot (UX-M17); unnamed blockers (UX-M21) | **B−** |
| Save for later / find unsent work | 3 to save; 2–6 to find | Five buckets, conflicting counts, false "not on this device" (UX-H3, H7, M10) | **D** |
| Recover after crash / call / OS kill | ~3 + a full form | Blind identification (M1); Home-only discovery (M3); re-lock stops capture (H2) | **C−** |
| Review and fix a note | ~7–9 | Single-open accordion; Regenerate first; edits lost on Back (H5, M6–M8) | **C+** |
| What needs my attention? | 1–3 | Always-on section (M11); drafts shown 3× (M9); dead-end CTAs (M10) | **C** |
| Patients / Settings / Devices / Sign-out | 1–3 | No "record visit" (M19); Review misroutes (M10) | **B** |
| Auth: login, MFA, lock, device limit | 2–5 | Same-device MFA broken by the clipboard; re-lock resets your place | **B−** |

---

## 5. Findings — Performance

### High

**PERF-H1. Cold start chains about three round trips in series before the first usable screen.** Verified mechanism; timings *est.*

**Returning user, token older than 1h:**
1. Bundle evaluates with inline requires off. Every `_layout` is loaded eagerly, plus all of lucide.
2. GoTrue refreshes the token: **round trip #1**, plus a SecureStore write and read-back.
3. `/auth/me`: **round trip #2**.
4. *Then* `await registerDeviceTimed()`: **round trip #3**, with the 30s default timeout (`AuthProvider.tsx:1161-1172`).
5. Recovery-intent scan, a second spinner.
6. AppLockGuard's biometric check, only now.
7. Home mounts and fires 7–9 queries.

That is up to five different loading screens (splash → spinner → spinner → wordmark + spinner → skeleton).

**Estimated on a Tab A7 Lite:** ~1.5–3s on good Wi-Fi, 4–8s on poor Wi-Fi.

**Offline fallback is slow:** `fetchUser` makes 4 attempts with 1/2/4s backoff before the cached-profile fallback (`:1228-1256`). Each attempt has a 30s timeout, so a captive-portal or dead-Wi-Fi exam room waits **~127s** before reaching their own drafts. Airplane mode waits ~7s.

**Fixes:**
- Start `registerDevice()` alongside `requestMe()` and apply the profile when `/auth/me` returns. The inline comment wants device-gated queries to wait for the session row, but the existing 428 → register → retry path in `ApiClient` covers that. Better: skip re-registration when (deviceId, authUserId, appVersion) matches the last success.
- Apply the cached profile on the *first* retryable failure while retrying in the background, and use a 10s timeout for cold-start `/auth/me`.
- Start the biometric probe at AuthProvider mount.
- Keep the SplashGate up until the profile is resolved, to collapse the spinner chain.
- **Related, M5:** every `TOKEN_REFRESHED` re-runs the full `fetchUser` bootstrap: `/auth/me`, register, sweeps, and an app-wide `setUser` re-render (`:2018-2027`). Skip it when it's the same auth user and the profile is already loaded.

**PERF-H2. The persisted query cache is unbounded in practice and rewritten on every cache event.** Verified mechanism; sizes *Needs profiling*.
- `recording` detail (with `transcriptText`), `soapNote` and `patient` are persisted with a 7-day `gcTime` (`queryPersistence.ts:51-58`, `[id].tsx:229,309,322`).
- The persister dehydrates on **every** query event, including updates to queries that aren't persisted (attention poll, local-drafts). It then `JSON.stringify`s the whole snapshot on the JS thread at most every 2s (`:42`).
- `mergeRecordingIntoCachedLists` also spreads full details, transcripts included, into persisted list rows (`recordingQueryCache.ts:54-70,185-207`).
- A 1–2h transcript is ~60–120 KB, so a week of detail views reaches several MB.
- **Effects:**
  - Recurring stalls while Recordings (10s) and detail (5s) poll.
  - A large `JSON.parse` in the same commit that first renders Home (`AuthProvider.tsx:877`).
  - Likely silent failure past Android AsyncStorage's default 6 MB database and ~2 MB row-read limits, which would make "offline mode" quietly stop working.
- **Fix:**
  - Use `persistQueryClientRestore` with your own `queryCache.subscribe`. Persist only when a persisted key reaches `success`, with a 15–30s debounce, and flush on background.
  - Strip `transcriptText` (or move it to a non-persisted key).
  - Keep only the ~25 most recent details.
  - Add a 1 MB size guard.
  - Log `serialized.length` in a dev build first, to size the problem.

**PERF-H3. Slot-card memoization is defeated, so each keystroke and upload tick re-renders every mounted card.** Verified mechanism; ms *Needs profiling*.
- **Why:** six handlers depend on `session.slots` (`record.tsx:2013, 2092, 2902, 2961, 3051, 7419`), and the reducer builds a new `slots` array on every `UPDATE_FORM`/`SET_UPLOAD_STATUS`.
- **Result:** typing in Patient Name re-renders `RecordingSession` (~175 hooks) plus up to 3 `PatientSlotCard` trees (~1,000 lines each, 6 controlled inputs), `PatientTabStrip` (whose `LinearTransition` re-runs on every name change), `SubmitPanel` and `UploadOverlay`. The file already has `sessionRef` (`:942`) documented for exactly this, and `handleStop` uses it.
- **Compounding causes:**
  - Upload progress is dispatched every 500ms even when the rounded percent hasn't moved, so ~95% of dispatches are no-ops (`:3946-3955`, `:3606-3612`).
  - `templates: query.data ?? []` creates a new array per render whenever templates have no data, including offline cold start, because templates aren't persisted (`useTemplates.ts:19`).
  - `maxMetering` sits in the memoized recorder object (`useAudioRecorder.ts:1247,1260,1285`).
- **Fix:** `sessionRef.current` inside those handlers; skip unchanged progress (and return `state` from the reducer on no-ops); a module-level `EMPTY_TEMPLATES`; drop `maxMetering` from the memo; `React.memo(PatientTabStrip)`.

**PERF-H4. TrimOverlay re-renders and rebuilds its gestures every frame of a drag.** Verified mechanism.
- **Why:** `useAnimatedReaction` → `runOnJS(setBadgeText)` runs per frame (`TrimOverlay.tsx:349-365`). `Gesture.Pan/Tap/Race` are created in render without `useMemo` (`:135,205,250,268`), so `GestureDetector` re-sends its config and re-shares worklets to the UI runtime about 60×/s. The dim regions also animate `width`/`left`, which are layout properties (`:276-343`). `WaveformEditor.tsx:183-235` repeats the gesture pattern.
- **Fix:** `useMemo(..., [])` for gestures; move the badge to a memoized child driven by animated text, or throttle it to ~10 Hz; use `translateX`/`scaleX` for the dim layers.

### Medium

| ID | Finding | Where | Fix |
|---|---|---|---|
| PERF-M1 | Inline requires are off (Expo default), and expo-router loads every layout eagerly. The whole static graph runs before first paint, including on the sign-in path | `metro.config.js`; `@expo/metro-config` default | `getTransformOptions → inlineRequires: true`; audit modules with top-level side effects (`secureClipboard.ts:10`, `queryClient.ts` focusManager); measure before and after |
| PERF-M2 | lucide barrel: **1.18 MB**, ~1,700 icon modules evaluated to use 68 (measured) | 50 importing files | Expo tree shaking (measured −20% total) *or* per-icon imports through a local `icons.ts` (Metro falls back past `exports`, with a warning) |
| PERF-M3 | ~6.8 MB of unused Material Symbols TTFs ship as assets through `expo-router → expo-symbols` | asset list in `expo export` | Confirm in the APK; stub `@expo-google-fonts/material-symbols` via `resolver.resolveRequest` if unused; recheck on each expo-router bump |
| PERF-M4 | List polling has no age bound, and an infinite query refetches **every loaded page**. A row stuck in `uploading` keeps Recordings (10s, all pages), Home recent (10s) and the 100-row attention page (60s) polling for as long as the screen is focused | `recordings/index.tsx:138-173`, `(tabs)/index.tsx:126-133`, `useAttentionFeed.ts:140-144` | Count a row as processing only within `stuckThresholdMs(status)` (exists at `attentionFeed.ts:222`); `maxPages`, or poll processing ids only |
| PERF-M5 | The detail screen keeps polling (5s→60s, up to 30 min) and re-rendering behind other tabs; ProcessingStepper's 4.5s interval runs off-screen | `recordings/[id].tsx:230-252,327-337`, `ProcessingStepper.tsx:33-41` | `subscribed: useIsFocused()` (as the list already does) and focus in the `refetchInterval` gate |
| PERF-M6 | The audio player's `useFrameCallback` stays registered while paused, a vsync loop for every mounted detail screen (the Recordings stack isn't frozen); same in the editor | `useAudioPlayback.ts:104-119`, `audio-editor.tsx:315` | `useFrameCallback(cb, false)` + `setActive(isPlaying)` |
| PERF-M7 | Live-readout and recorder events tick at 4 Hz with no screen or AppState gate, and infinite pulses (`withRepeat(-1)`) run for whole consults and uploads, so the UI thread runs at full frame rate for 1–2h | `RecorderLiveReadout.tsx:60-93`; `DurableRecorderEngine.kt:68,622-631`; `AudioWaveform.tsx:76-90`, `PatientSlotCard.tsx:115-139`, `PatientTabStrip.tsx:76-98`, `UploadOverlay.tsx:57-69`, `StatusBadge.tsx:38-74` | Gate the readout on focus + `active`; native `setLiveStatsEnabled`; pulse a few seconds then hold; one shared pulse value |
| PERF-M8 | Keep-awake for the whole recording; the backlight is the dominant draw on LCD tablets (*est.* 10–15%/h) | `record.tsx:1781-1792` | **Product decision:** dim after ~60s without a touch (window brightness), or drop keep-awake once durable capture is confirmed |
| PERF-M9 | Supabase's auto-refresh ticker reads SecureStore (Keystore decrypt + parse) every ~30s, forever, including iOS background recording | `src/auth/supabase.ts:59` | The documented RN pattern: `startAutoRefresh()` on `active`, `stopAutoRefresh()` otherwise |
| PERF-M10 | The min-version floor is written to SecureStore on **every** API response, with no unchanged check | `src/lib/minVersion.ts:26-41`, `client.ts:479` | `if (cachedFloor === version.trim()) return;` |
| PERF-M11 | Unsent-work strict reads (dozens of Keystore reads plus a manifest listing) re-run on every Home focus and every resume, ignoring `staleTime` | `useAttentionFeed.ts:183,307`, `localRecordings.ts:115-133` | Refetch only when stale or when the draft/stash write version has changed |
| PERF-M12 | **Challenge:** React Query's `onlineManager` is deliberately left unwired (`queryClient.ts:13-14`, to keep mutations flowing). The cost: every query, poll and retry fires into a dead network (30s each on captive Wi-Fi), and `refetchOnReconnect` never fires | `src/lib/queryClient.ts` | Wire NetInfo to `onlineManager` **and** set `mutations.networkMode: 'always'`, which preserves today's upload behaviour |
| PERF-M13 | NetInfo on iOS pings `clients3.google.com` every 60s (5s when unreachable), including during background recording | no `NetInfo.configure` | `reachabilityUrl` = API health; `reachabilityShouldRun` only while `active`; long timeout 5 min |
| PERF-M14 | The first tap on Record evaluates and mounts the 7,924-line screen and its ~120 imports | `record.tsx`; no prewarm | After Home settles, `require` the module while idle; longer term, split `record.tsx` |
| PERF-M15 | Expo-audio drafts and stashes copy whole recordings **synchronously** on the JS thread (*est.* 0.3–1.5s for 30–60 min of audio) | `draftStorage.ts:457,472`, `stashAudioManager.ts:75,109` | Make the async copy primary; use a same-volume move when ownership transfers |
| PERF-M16 | The patient detail visit list isn't virtualized; "Load more" grows `limit` and refetches everything; edit-form keystrokes re-render every visit row (plus an Intl call per row) | `patient/[id].tsx:199-206,502-545,586-590` | Page-based `useInfiniteQuery`; memoized rows; edit form in its own component |
| PERF-M17 | Too many startup tasks run in the same commit as Home's first render (cache restore, durable scan, stash sweep, legacy migrations that run every launch) | `AuthProvider.tsx:877-913`, `durableRecovery.ts:384-414` | `runAfterInteractions`; record migrations as done with a stored flag; cap parallel manifest checks |

### Low
- **L1. Unneeded per-render work:**
  - `MarkdownText` re-parses on every render (`MarkdownText.tsx:85-91`); use `useMemo` + `React.memo`.
  - Intl date formatting runs inside row renders (`PatientRow.tsx:24`, `AttentionFeedSection.tsx:83`); use module-level `Intl.DateTimeFormat` instances.
  - `ui/Text` allocates a new style array per render, for every Text (`Text.tsx:48,60`); hoist the font style object.
- **L2. Idle cards still mount 24–36 Reanimated bars each** (`AudioWaveform.tsx:149-186`). Render a static view when there's no `level`.
- **L3. Each Skeleton runs its own infinite loop** (20 on the list loading state). Use one shared pulse. The UploadOverlay bar animates `width:%`; use `scaleX`.
- **L4. Home "Not Submitted" is uncapped** (`index.tsx:280-283,588-592`). Unsent drafts are never auto-evicted, so the list grows.
- **L5. Redundant fetches and writes:**
  - `orgAiModels` uses `refetchOnMount: 'always'` despite a 30-min `staleTime` (`[id].tsx:291-297`).
  - The access token is written twice per session change.
  - An unchanged profile cache is rewritten on every `fetchUser`.
- **L6. Sentry options that buy little:** `enableUserInteractionTracing` without `Sentry.wrap`/navigation integration (`monitoring.ts:216-219`). Either wire the integration or drop the options.
- **L7. Housekeeping:**
  - Synchronous `Directory.list()` cache cleanup at T+5s (`AuthProvider.tsx:416-431`).
  - The waveform peak cache has no cap (`waveformCache.ts:43-48`).
  - Unreferenced 707 KB/215 KB PNGs in `assets/`; repo tidiness only, not bundled.
- **L8. Babel plugin listed twice:** `babel.config.js` adds `react-native-reanimated/plugin` while babel-preset-expo 55 already adds the worklets plugin. Verify, then remove the manual entry.
- **L9. React Compiler (not enabled):** worth trialing on `src/components` only. It will skip `RecordingSession`/`useAudioRecorder` because they write refs in render, so PERF-H3 stays a manual fix.

---

## 6. Findings — Accessibility & platform

### Contrast (computed from `global.css`)

| Pairing | Light | Dark | Needs |
|---|---|---|---|
| content-primary / body / secondary on raised | 17.5 / 10.3 / 7.6 | 16.1 / 13.4 / 11.3 | 4.5 ✓ |
| content-tertiary on surface / raised / **sunken** | 4.59 / 4.80 / **4.40 ✗** | 7.29 / 6.67 / 6.03 | 4.5 |
| **brand-500 text** on raised / surface / sunken | **4.43 / 4.24 / 4.06 ✗** | 9.04 / 9.87 / 8.18 | 4.5 |
| **on-brand on brand-500** (every primary Button, active segment/tab) | **4.43 ✗** | 9.39 | 4.5 |
| Hero subtitle (on-brand/80 on gradient) | **3.42–4.24 ✗** | 6.25 | 4.5 |
| **White on danger-500** (Button `danger`) | **3.76 ✗** | **3.76 ✗** | 4.5 |
| Status fg on status bg (info/warning/danger/success) | 5.49 / 4.51 / 5.30 / 4.57 | ≥6.9 | 4.5 ✓ |
| **border-strong** (the only outline on inputs, Select, search) | **1.49 ✗** | **2.21 ✗** | 3.0 |
| **Toggle off track vs card**; dark thumb = card colour | **1.49 ✗** | **2.21 ✗** | 3.0 |
| **Status dot on the active patient tab** | **1.13–1.46 ✗** | **1.29–1.54 ✗** | 3.0 |
| Proposed: on-brand on brand-600 | 5.68 | 7.03 | ✓ |

### High

**A11Y-H1. Adjustable, progress and state semantics never reach iOS VoiceOver.** Verified in code; **Needs device check** for the UX.
- **Why:** On Fabric iOS only `accessible` makes a View an accessibility element. These Views carry role, label and actions but not `accessible`:
  - `TrimOverlay.tsx:427,450` (trim handles; their only children are grip lines);
  - `RecordingAudioPlayer.tsx:220` (seek bar);
  - `record.tsx:7812` (patient pager);
  - `ProcessingStepper.tsx:71`;
  - `UploadOverlay.tsx:243`, `PatientSlotCard.tsx:967` (progress bars);
  - `ui/ListItem.tsx:115-124` (non-pressable rows).
- **Worst case:** in the editor the nudge target defaults to `'end'` and changes only when a handle is touched (`audio-editor.tsx:713-714`), so a VoiceOver user can never trim the **start**.
- **Fix:** add `accessible` + `accessibilityValue={{ text }}` and a visible Start/End toggle.

**A11Y-H2. Segment delete and reorder in the editor can't be done with VoiceOver or a single pointer.** Verified.
- **Why:** The × is a Pressable nested inside the tab Pressable, which swallows it on iOS, yet the hint says "Tap × to delete". Reorder is long-press-drag only (WCAG 2.5.7) (`audio-editor.tsx:225-262`).
- **Fix:** `accessibilityActions` (delete / move left / move right) plus visible ‹ › buttons.

**A11Y-H3. Tablet support is assumed away.** Verified config; **Needs device check**.
- **Orientation:** `orientation: 'portrait'` (`app.config.ts:220`) doesn't hold:
  - iPad with `supportsTablet` still gets all orientations and Split View.
  - Android 16 ignores orientation locks on screens ≥600dp at targetSdk 36. Older tablets on landscape stands are meanwhile forced into portrait (WCAG 1.3.4).
- **Pager:** its `getItemLayout` uses `screenWidth`, but the sync effect keys only on `activeIndex` (`record.tsx:7638-7647,1968-1980`). After a rotation or Split View resize the pager can rest between two patients, and a vet can type into the wrong patient's form.
- **Record screen width:** no max width (`PatientSlotCard.tsx:410-416`, `record.tsx:7650-7790`), while every other tab centres at `CONTENT_MAX_WIDTH` (600). Forms, the 80dp record button, the Submit card and the banners stretch 800–1366dp.
- **Fix:** on a width change, `scrollToOffset({ offset: activeIndex * screenWidth, animated: false })`; centre the slot content at 600 while keeping each page full-width; then decide orientation deliberately.

### Medium
- **A11Y-M1. Brand-500 / danger contrast** (table above). One token change fixes it: light `--brand-500 → 10 116 101`, `--brand-600 → 9 94 83` (mirror in `colors.ts`), `bg-danger-600` for the danger Button, and drop `/80` on the hero subtitle. Extend `theme-token-guard` to pin these pairs. IconButton `danger` (tinted) and Button `danger` (solid) also look different from each other.
- **A11Y-M2. Form outlines and toggles fail 1.4.11 non-text contrast** (`TextInputField.tsx:43-47`, `Select.tsx:75`, `recordings/index.tsx:470`, `Toggle.tsx:38-39`). Add `--color-border-input` (≈#8f8a85 light / #78716c dark, ≥3.4:1) and keep the toggle thumb white in both modes.
- **A11Y-M3. Patient-tab status is colour-only and invisible on the active pill** (`PatientTabStrip.tsx:38-100,171-186`). Use glyphs (mic/pause/clock/check/alert) or a white-ringed dot.
- **A11Y-M4. Auth errors are silent on iOS.** `accessibilityLiveRegion` is Android-only, and `role="alert"` sits on a non-accessible View (`login.tsx:240-259`, `mfa.tsx:285-292`, `forgot-password.tsx:124-130`, `reset-password.tsx:149-155`). The same pattern recurs at `PatientSlotCard.tsx:802,956,996,1032`, `SubmitPanel.tsx:57`, `DeviceLimitModal.tsx:398` and `audio-editor.tsx:1659`. Add an iOS-gated `announceForAccessibility`, as `Toast` does.
- **A11Y-M5. `Select` never exposes its value** (`Select.tsx:67`): the language picker reads "Language, button". Add `accessibilityValue`.
- **A11Y-M6. Headings are missing on the busiest screens.**
  - Home "Not Submitted" / "Recent Recordings" (`index.tsx:586,601`).
  - The whole recording detail screen.
  - `durable-recovery.tsx:184`, `audio-editor.tsx:1512`, and the Sheet title.
- **A11Y-M7. Focus is lost when the activated control unmounts** (Start → Pause/Finish; Reprocess entry → card). There is no `setAccessibilityFocus` in the repo. *Likely.*
- **A11Y-M8. UploadOverlay isn't modal for assistive tech**, so the record controls behind the scrim are reachable (`UploadOverlay.tsx:191-203`). Add `accessibilityViewIsModal` and hide the content behind it.
- **A11Y-M9. Keyboard handling has gaps.**
  - No KAV, `automaticallyAdjustKeyboardInsets` or `keyboardShouldPersistTaps` on the SOAP editor screen (`recordings/[id].tsx:1158`), `recording-recovery.tsx:280`, `patient/[id].tsx:337`, `profile.tsx:150` or `delete-account.tsx:144`.
  - **Needs device check:** Android edge-to-edge (SDK 55 default) may defeat `adjustResize`, which `Sheet.tsx:54-60` relies on, and `PatientSlotCard.tsx:415` uses the iOS-only `automaticallyAdjustKeyboardInsets`. If confirmed, use KAV `padding` on both platforms or `react-native-keyboard-controller`.
- **A11Y-M10. Some tap targets are undersized.**
  - MetadataReview "Add Species" rows: ~28dp (`MetadataReviewCard.tsx:279-298,384-396`).
  - Show-password toggle: ~36pt (`login.tsx:292-304`).
  - "Read more": ~34pt (`index.tsx:718-731`).
  - Editor nudge buttons: ~36dp, with overlapping hitSlops (`audio-editor.tsx:1689-1703`).
- **A11Y-M11. Visible labels ≠ accessible names (2.5.3; breaks Voice Control).** "Submit All Recordings (3)"/"Submit 3 recordings", "Save for Later"/"Save session for later", "Record Appointment"/"Record a new appointment", "Delete & Start Over"/"Delete recording and start over". Start each accessible name with the visible text.
- **A11Y-M12. Live regions announce each change.** Per-slot upload progress is a polite live region whose label includes the percentage, so TalkBack chatters (`PatientSlotCard.tsx:964-970`). `PatientTabStrip` tabs are polite live regions, so each name keystroke is announced.
- **A11Y-M13. The Android nav-bar icon style is set once from the system theme**, so in-app dark mode on a light-system device gives dark icons on a dark surface. *Needs device check.*
- **A11Y-M14. Challenge: the 1.3× hard ceiling also applies to long-form reading** (`fontScaling.ts:21,33-38`). SOAP notes, transcripts and client email reflow cleanly, so a guard-tested ~2.0× reading multiplier for those three would serve low-vision vets without reopening layout bugs.

### Low
- **`Animated.Text` bypasses `ui/Text`** (no cap, no Inter on Android): `SoapNoteView.tsx:186`, `ProcessingStepper.tsx:124`, `TrimOverlay.tsx:477`. `font-scaling-guard` only fences `react-native` imports; extend it and use `Animated.createAnimatedComponent(Text)`.
- **Stepper "warmth" copy** is hidden from TalkBack only, so VoiceOver reads it (`ProcessingStepper.tsx:128`).
- **No iOS edge-swipe back on cross-tab pushes.** `recordings/_layout.tsx` and `patient/_layout.tsx` lack `unstable_settings.initialRouteName`. That is also the root cause the `router.replace`/BackHandler workarounds compensate for.
- **Toast timing:** capped at 4s, ignoring `getRecommendedTimeoutMillis`. The auto-pause notice should persist until dismissed or resumed.
- **Haptics:**
  - They fire on every press including Cancel.
  - The Banner CTA fires twice (`Banner.tsx:113-117` + call sites).
  - Selection haptics fire during live capture although `RecorderLiveReadout` bans haptics for motor bleed. Suppress UI haptics while the recorder is live (*bleed: Needs device check*).
- **Press feedback:** ListItem/RecordingCard drop opacity to 0.96 (barely visible); there are 0 `android_ripple` uses.
- **Smaller gaps:**
  - Offline banner appears with no announcement.
  - Attention skeleton isn't announced.
  - Player part chips lack a selected state.
  - Recovery validation is an Alert that doesn't name the field.
  - No return-key chains in `PatientForm`, the MetadataReview sheet or the recovery fields.
  - Quality card dates are hard-coded to `en-US`.
  - The `RecordingCard` label reads the raw enum ("pending_metadata").

---

## 7. Findings — Design system & visual

### High
- **DS-H1. Class names that don't exist fail silently, and nothing checks.** Verified by compiling Tailwind.
  - `text-heading-lg` is not in the scale (`tailwind.config.js:119-128`). Four auth titles render at RN's default 14px, smaller than the 15px body under them (`forgot-password.tsx:109,175`, `reset-password.tsx:140`, `mfa.tsx:279`).
  - `border-border-subtle` (`RecordingAudioDownload.tsx:251`) draws a default black hairline.
  - **Fix:** `text-display font-bold` / `border-border-default`, plus a guard test that runs Tailwind over the content files and fails on any className with no generated CSS. That one test closes the whole class.

### Medium
- **DS-M1. The screen header is copy-pasted ~10×, and the copies have drifted.** `durable-recovery` uses a different size, weight, hard-coded icon, no header role and no `flex-1` (the Bold-text clip shape). `attention.tsx:165` and `[id].tsx:1171` use raw Pressable backs. The audio editor uses `ArrowLeft`. **Fix:** `ui/ScreenHeader`.
- **DS-M2. Warning callouts come in four styles:** `Banner`; seven hand-built cards on recording detail; Record banners (`rounded-lg`, one `border-2`); `DurableRecoveryBanner` (brand-tinted, `rounded-xl`). Icon colours vary too (`warning600` vs `statusWarningFg`). **Fix:** extend `Banner` with `title`/`children`/`tone="outline"` and migrate.
- **DS-M3. The crash-recovery screen and banner sit outside the system:** unsized Text at 14px, no max width, a raw Pressable with no feedback, hard-coded icon sizes (`durable-recovery.tsx:180-215`, `DurableRecoveryBanner.tsx:26-35`).
- **DS-M4. The "brand-tinted background" has no semantic token.** `bg-brand-50 dark:bg-surface-sunken` is hand-paired at 13+ sites, with misses such as `border-brand-200` kept in dark mode at `recordings/index.tsx:555`. **Fix:** add `--brand-subtle-bg/-fg/-border` with real dark values.
- **DS-M5. Selection controls use three styles:** `SegmentedControl`; a hand-built SOAP/Transcript track; Tools toggles that show "open" as a **primary Button** with no `expanded` state (`[id].tsx:1694-1724,1806-1846`). **Fix:** a SegmentedControl `variant="track"`; chips with `accessibilityState.expanded`.
- **DS-M6. Error and empty states diverge.** `EmptyState` is used on 4 screens; 4 others hand-roll theirs, and Retry/Go Back priority flips between screens. **Fix:** `EmptyState` everywhere, with Retry primary.
- **DS-M7. 6 of 8 `RefreshControl`s are unthemed** (white disc on Android dark): `recordings/index.tsx:538`, `[id].tsx:1162`, `patient/index.tsx:120`, `attention.tsx:187`, `devices.tsx:258`, `subscription.tsx:162`. **Fix:** `ui/ThemedRefreshControl`.
- **DS-M8. Long-form text loses its relaxed line-height on tablets.** The tablet `@media .text-body` rules win over `.leading-relaxed`, so line-height drops from 1.63 to 1.47 exactly where people read most. **Fix:** a `text-reading` token. *Medium confidence.*
- **DS-M9. Icon sizes are mostly hard-coded:** 121 literal `size={n}` values across 12 sizes vs 74 responsive `iconSm/Md/Lg`; the same icon appears at different sizes on one screen. **Fix:** add `iconXs`/`iconXxs`, plus a lint rule.
- **DS-M10. Corner radius drifts off the token scale:** `rounded-lg` ×16, `rounded` ×4, `rounded-xl` ×3, `rounded-2xl` ×1, an inline 14. **Fix:** move to the tokens and guard against raw `rounded-{sm..2xl}`.
- **DS-M11. Settings is a stack of 12+ shadowed cards**, not grouped inset lists. Section headings are typed in ALL CAPS, which screen readers may spell out. **Fix:** `ListGroup` + `ListItem variant="row"` + the `uppercase` class.
- **DS-M12. The Skeleton-for-content convention is broken** at `patient/[id].tsx:296-299,580`, `QualityAnalyticsCard.tsx:343-345` and `recording-recovery.tsx:285-292`.

### Low
- **Unused tokens and guard gaps:**
  - The entire `stone` palette, 20 of 24 static status shades, `brand-400/800/900`, `brand-teal*` and `content-inverse` are unused. Delete them so misuse fails to compile.
  - `theme-token-guard` misses directional borders (`border-l-danger-500` at `PatientSlotCard.tsx:320`). Widen it to `border(?:-[lrtbxy])?-`.
  - Parity is checked on keys, not values. Values match today; add a value test.
- **Glow colour:** always light-mode teal (`tailwind.config.js` `boxShadow.glow`, `AudioWaveform.tsx:167`).
- **Live recording mixes two hues:** red stripe/badge/dot, but a teal timer/waveform/glow. Pick one.
- **Two toast systems on one screen:** `CopiedToast` vs `Toast`.
- **The search field is duplicated** and has drifted (Patients lacks the Android clear-X). Add `ui/SearchField`.
- **iOS splash is always white:** no `dark` block (`app.config.ts:72-79`).
- **The app icon** is an Arial Bold "C" on flat teal (`scripts/generate-icons.mjs:20-27`), not drawn from the wordmark. Brand opportunity.
- **No React Navigation `ThemeProvider`:** possible #f2f2f2 flash in dark mode during transitions. Nested stacks use the default animation while the root uses `slide_from_right`.
- **Sheets and the auth gating screens have no max width on tablets;** the two "Sign out" buttons have different styles.
- **Section and card headings use four styles;** card padding is `p-4` vs `p-5`.
- **`docs/ui-system.md` is 24 lines.** It doesn't document the type scale, spacing, radius, icon tiers, header pattern, brand-tint token, press feedback, or when to use a toast vs a callout. That gap is why the drift keeps happening.

---

## 8. Status of the 2026-07-17 audit

| Severity | Fixed | Partial | Open | Superseded |
|---|---|---|---|---|
| High (17) | **17** | 0 | 0 | 0 |
| Medium (66 listed) | **62** | 3 | 0 | 1 |
| Low (58 listed) | **52** | 3 | 3 | 0 |

**Partials:**
- **Terminology:** "Draft…pending upload" and "Saving recording..." remain. This is now the much larger UX-H7.
- **Home banners:** DeviceRegistration and Offline strips in `(app)/_layout.tsx:200-201` sit outside the priority gate.
- **Raw-Pressable adoption:** still 54 raw outside `ui/`, now in 21 files; only 4 call haptics. Shared Button/IconButton usage rose 94 → 139.
- **Lows:** the merge-cancel fallback; Toast queueing; detail strings outside the catalog.

**Open Lows:** no `autoFocus` on email (deliberate); the single-open accordion (now UX-M7); the Sheet drag handle.

**Superseded:** "Needs Review" filter (no human `reviewStatus` contract, per CLAUDE.md).

**Regressions and reintroduced patterns:**
- `Animated.Text` font-cap bypass (3 sites).
- `border-l-*` static palette, which slipped past the guard regex.
- Android-only live regions in new code.
- Missing keyboard avoidance on 4 form screens.
- New raw Pressables without haptics (attention screen, banners, "+N more").
- Raw error strings on 6+ surfaces.
- `numberOfLines={1}` on single-token labels (`audio-editor.tsx:1742` "Stop"; `ui/Badge.tsx:37` applies it to every badge).
- RecordingAudioPlayer still formats M:SS with no hours.
- `DeviceLimitModal.tsx:57` dates lack the year.
- ASCII "..." at 7 sites.
- 40 `Alert.alert` calls with inline literal titles.

**Doc drift:** CLAUDE.md rule 6 still describes `useAudioRecorderState(recorder, 500)`. The hook now samples into refs at 500 ms foreground / 2 s background, and only `RecorderLiveReadout` polls.

---

## 9. Recommended next steps

### Measure first: set budgets on a Galaxy Tab A7 Lite and an older iPhone before touching performance

| Metric | How | Proposed budget |
|---|---|---|
| Cold start to tappable Record (signed in, token >1h) | `adb shell am start -W` + a Perfetto trace; Hermes sampling profile | ≤2.0s on good Wi-Fi; ≤5s to offline drafts on captive Wi-Fi |
| JS FPS while typing in a 3-patient session | Perf Monitor / React DevTools Profiler | ≥55 fps, no commit >16ms |
| JS FPS while dragging a trim handle | Perf Monitor | ≥55 fps |
| Persisted snapshot size after a week of use | dev log of `serialized.length` | ≤1 MB |
| Battery drain over a 30-min screen-off recording | `dumpsys batterystats` | baseline it, then set a target |
| APK / IPA download size | `unzip -l` on the release APK | record the Material Symbols and lucide savings |

### Phase 1 — data loss and misleading state (small diffs, highest stakes)
- UX-H1 clipboard.
- UX-H2 lock overlay.
- UX-H3 stash-aware drafts.
- UX-H4 30-day review list + 23-day heads-up.
- UX-H5 SOAP edit guard.
- UX-H6 post-Finish hierarchy and copy.
- The long-press nudge bug.
- DS-H1 missing class names + the className guard.

### Phase 2 — performance with measured payoff
- PERF-H1 parallel register + early cache fallback.
- PERF-H2 persister rewrite and bounds.
- PERF-H3 `sessionRef` handlers + progress dedupe + `EMPTY_TEMPLATES`.
- PERF-H4 TrimOverlay gestures.
- PERF-M1/M2/M3 inline requires, lucide, Material Symbols.
- PERF-M4/M5 polling bounds and focus gates.
- PERF-M9 auto-refresh wiring.
- PERF-M10 min-version write dedupe.
- PERF-M13 NetInfo config.

### Phase 3 — accessibility and tablets
- A11Y-H1/H2 VoiceOver semantics and editor actions.
- A11Y-H3 tablet width, pager re-alignment and an orientation decision.
- A11Y-M1/M2 brand, danger and input-border tokens.
- A11Y-M4 iOS announcements.
- A11Y-M9 keyboard (device-verify edge-to-edge first).
- Headings and accessible names.

### Phase 4 — structural (needs product decisions)
- UX-H7 one "Unsent" model.
- Detail-screen information architecture (UX-M6–M8).
- Status colour semantics (UX-M17).
- Keep-awake policy (PERF-M8).
- Design-system primitives: ScreenHeader, ThemedRefreshControl, SearchField, Banner variants, brand-subtle token.
- An expanded `docs/ui-system.md`.
- Start splitting `record.tsx` along its existing seams (upload state machine, recorder binding, stash/draft orchestration).

### Decisions only the owner can make
1. Is clipboard auto-clear still wanted at all, given the 2026-05-29 not-HIPAA decision?
2. Should the biometric lock defer while a recording is live?
3. One "Unsent" bucket instead of drafts + saved sessions + recoveries?
4. Support landscape on tablets, or commit to portrait and handle Android 16 / iPad explicitly?
5. Keep the screen awake for whole recordings, or dim after inactivity?
6. Raise the font-scale ceiling for long-form reading only?

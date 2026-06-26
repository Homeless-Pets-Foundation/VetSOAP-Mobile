# Plan: Pixel performance improvement

**Repo:** VetSOAP-Mobile (Expo SDK 55 / React Native 0.83.6 / React 19)
**Date:** 2026-06-26
**Device audited:** Pixel 10 Pro XL (`mustang`), Android 16, Captivet `1.13.7` / build `80`
**Status:** Audited implementation plan from on-device audit + code audit.

## Goal

Make the app feel responsive on the connected Pixel 10 Pro XL and avoid regressions on lower-end Android devices. The audit did **not** show a simple GPU/list-render bottleneck: cold/hot launch and short scroll frame stats were mostly healthy. The high-impact work is to:

1. Find and fix the root error boundary event seen on the device.
2. Reduce repeated JS, network, and storage work on app start, tab focus, and auth state changes.
3. Lower unnecessary animation/render overhead in common screens.
4. Reduce audio file size and recording/upload work without hurting transcription quality.
5. Add measurement so future "sluggish" reports can be tied to a phase, screen, and device state.

## Baseline from audit

- First open showed the root error boundary fallback: "Something went wrong". Tapping `Try Again` recovered Home. Root capture is in `app/_layout.tsx` (`componentDidCatch`, tags `{ boundary: 'root' }`).
- Frame rendering was acceptable in short tests:
  - Cold start via `am start -W`: about 446 ms to first native Activity draw. This is not proof that JS content was fully interactive; use app-specific phase timing below for that.
  - Hot start: about 142 ms.
  - Home/Records scroll: under 1% modern janky frames in sampled runs.
- Device-level pressure was high:
  - About 15 GB / 15.5 GB RAM used.
  - More than 6 GB swap used.
  - `kswapd0` spiked, which can make any app feel slow.
- App process memory was not tiny but not obviously runaway:
  - Around 250-400 MB RSS/PSS depending on state.
- Captivet still used visible idle CPU:
  - Commonly about 3-6% app CPU while Home was visible.
  - Thread samples pointed mostly to main/JS-side work rather than RenderThread.
- The phone was in landscape. With `orientation: 'default'`, Home/Records appeared cramped and vertically clipped at this font/weight setting, which makes interactions feel heavier even when frame timing is acceptable.

## Non-negotiable safety rules

Every change in this plan must preserve the project crash-prevention rules:

- No module-load throws.
- No async function passed directly to RN void callbacks; every fire-and-forget Promise has `.catch()`.
- Loading/refreshing flags must reset in `finally`.
- SecureStore/Keystore access stays behind existing safe wrappers unless touching an existing user-scoped storage module that already owns its access pattern.
- Draft/stash/recovery-intent preservation across logout is untouched.
- Draft/stash operations remain user-scoped and only run after `setUserId`.
- Network URL validation and upload validation behavior are untouched.
- Release logs must not include PHI; new `console.*` stays dev-gated.

## Phase 0: Triage and measurement first

### 0.1 Find the root error boundary cause

**Why:** This was the only confirmed app failure on the connected device. Fixing perf while a transient root render error exists risks chasing symptoms.

**Files:**
- `app/_layout.tsx`
- `src/lib/monitoring.ts`

**Implementation:**
- Query Sentry for release `com.captivet.mobile@1.13.7+80`, tag `boundary=root`, around the audit window.
- If Sentry lacks enough context, improve the boundary capture with PHI-free diagnostics:
  - current route segment if available
  - coarse app state
  - auth gate state: loading/authenticated/userFetchState/profileSource only
  - `CONFIG_MISSING`
  - native app version/build already handled by Sentry release
- If a user-visible support id is useful, first change the monitoring wrapper deliberately: `captureException()` currently returns `void`, while the underlying Sentry call can return an event id. Return a low-cardinality id only from this wrapper, keep callers compatible, and do not show raw error text in production.

**Acceptance:**
- The specific root-boundary event is identified and has a fix or a tracked issue with owner.
- A repeat root-boundary event has enough non-PHI context to identify phase/screen.
- No new module-load work throws.

### 0.2 Add lightweight phase timing breadcrumbs or spans

**Why:** Current Sentry performance is enabled, but the expensive app-specific phases are not consistently named. The next sluggish report should say "draft reconcile took 2.4s" or "auth fetchUser retry path took 7s", not just "app slow".

**Files:**
- `src/lib/monitoring.ts`
- `src/auth/AuthProvider.tsx`
- `app/(app)/(tabs)/index.tsx`
- `app/(app)/(tabs)/recordings/index.tsx`
- `app/(app)/(tabs)/record.tsx`
- `src/lib/draftStorage.ts`
- `src/lib/stashStorage.ts`

**Implementation:**
- Add a small safe helper such as `measurePhase(name, tags, fn)`.
  - It must no-op if Sentry is disabled and must not throw.
  - Prefer duration breadcrumbs or warning messages first; add Sentry spans only if the installed `@sentry/react-native` API supports the needed span helper cleanly.
  - Use fixed phase names and low-cardinality tags only. Do not include patient/client names, recording ids, file paths, server request bodies, or raw errors.
  - Support both sync and async callbacks, and always record completion in `finally`.
- Instrument:
  - `auth_init_get_session`
  - `fetchUser`
  - `registerDevice`
  - `local_recovery_scan`
  - Home focus refresh
  - Records focus refresh
  - local draft list
  - missing-server-draft reconciliation
  - orphan cleanup
  - 30-day eviction
  - Record screen mount work
- Record duration buckets, counts, and whether the work was skipped due to freshness.

**Acceptance:**
- Sentry or client telemetry can answer which phase exceeds 500 ms / 1000 ms.
- No PHI in phase names/tags/extra.
- No additional blocking work on the cold-start critical path.

### 0.3 Keep a repeatable Pixel perf script

**Why:** Manual impressions are not enough. We need repeatable before/after checks against the same device.

**Files:**
- `scripts/android-perf-smoke.sh` or `docs/ANDROID_STUDIO_TESTING_WORKFLOW.md`

**Implementation:**
- Add a concrete smoke script or documented command block for:
  - `adb shell am force-stop com.captivet.mobile`
  - `adb shell am start -W -n com.captivet.mobile/.MainActivity`
  - `adb shell dumpsys gfxinfo com.captivet.mobile reset`
  - repeat Home/Records navigation and scroll
  - `adb shell dumpsys gfxinfo com.captivet.mobile`
  - `adb shell dumpsys meminfo com.captivet.mobile`
  - `adb shell top -H -p $(pidof com.captivet.mobile)` equivalent
- In WSL2, use Windows ADB as documented in `AGENTS.md`.
- Require an explicit `ADB_SERIAL` when multiple transports exist for the same physical phone, as happened during the audit.
- Store raw outputs under a timestamped local directory. Either add `build-output/perf-smoke/` to `.gitignore` before using it, or write to `/tmp/captivet-perf-smoke/<timestamp>/`.
- Capture device memory/swap state before each run. Do not compare app changes across runs if one run is heavily swapped and the other is not.
- Capture Android `dumpsys meminfo` object counts, including `Activities`, after cold start and after root-error retry. The audit saw `Activities: 2`; treat it as a lead to reproduce, not as a confirmed leak until the smoke script shows it after a clean force-stop flow.

**Acceptance:**
- Before/after runs can be compared with the same commands.
- Captured metrics include launch time, janky frames, p95/p99 frame time, app RSS/PSS, idle CPU, and device swap pressure.

## Phase 1: Render and context fan-out fixes

### 1.1 Reduce auth context rerender fan-out

**Why:** `AuthProvider` currently creates a fresh context value object every render, and `useAuth()` consumers read one large context. `useMemo` prevents rerenders from unrelated parent/provider rerenders, but it does **not** stop every consumer from rerendering when any value inside the context legitimately changes. The high-impact fix is memoization plus narrower contexts/hooks for hot consumers.

**Files:**
- `src/auth/AuthProvider.tsx`

**Implementation:**
- First import `useMemo` and build `const authContextValue = useMemo(() => ({ ... }), [all referenced values])` so the current API stops changing identity on unrelated renders.
- Then split or layer narrower contexts without breaking `useAuth()` compatibility:
  - session/user/readiness values for screens that only need `user`
  - auth actions (`signIn`, `signOut`, social sign-in, retry)
  - device-registration state/actions
  - MFA state/actions
- Migrate high-frequency screens first: Home, Records, Record, tab layout, `useDeviceCapacity`, banners, and app/auth layouts.
- Keep callback identities stable with existing `useCallback` functions.
- Do not move auth side effects or change sign-in/sign-out behavior.

**Acceptance:**
- Typecheck passes.
- The existing `useAuth()` API still works for untouched callers.
- `AuthContext.Provider` receives a memoized value.
- At least these hot consumers move off the broad context when they only need a subset: Home, Records, Record, tab layout, `useDeviceCapacity`, `OfflineBanner`, `DeviceRegistrationBanner`, `SplashGate`, and auth/app route layouts.
- Sign-in, restore, MFA, device-registration block, and sign-out paths still expose the same fields.
- A profiler comparison shows fewer unrelated rerenders during auth/userFetchState, MFA, device-registration, and local-recovery state changes.

### 1.2 Use plain `View` for non-animated cards

**Why:** `src/components/ui/Card.tsx` returns `Animated.View` even when `animated={false}`. This creates unnecessary Reanimated nodes across ordinary screens.

**Files:**
- `src/components/ui/Card.tsx`

**Implementation:**
- Import `View`.
- Return `View` for non-animated cards.
- Keep `Animated.View entering={FadeIn.duration(300)}` only when `animated` is true.

**Acceptance:**
- Visual output unchanged.
- Animated cards still animate.
- Non-animated cards no longer allocate Reanimated wrappers.

### 1.3 Reduce list-row animation overhead

**Why:** `RecordingCard` creates a shared value and animated style per row for a press-scale effect. On long lists, that is a lot of Reanimated state for low user value.

**Files:**
- `src/components/RecordingCard.tsx`
- `src/components/ui/ListItem.tsx`

**Implementation:**
- Replace per-row Reanimated press scale in ordinary list rows with RN `Pressable` style, or move animation state to a shared/currently-pressed-row mechanism.
- Memoize date formatting or move formatted date into API/query mapping for loaded recording objects.
- Keep accessibility, status badges, and haptics unchanged.

**Acceptance:**
- Records list still feels tappable.
- Fewer Reanimated nodes per visible row.
- Records scroll p95/p99 frame time does not regress.

### 1.4 Audit entry animations on common screens

**Why:** Home, Records, patient lists, and detail sections use many `FadeIn*` animations. Short tests were fine, but removing nonessential mount animations reduces JS/UI thread work and perceived delay on memory-pressured devices.

**Files:**
- `app/(app)/(tabs)/index.tsx`
- `app/(app)/(tabs)/recordings/index.tsx`
- `app/(app)/(tabs)/patient/index.tsx`
- `app/(app)/(tabs)/recordings/[id].tsx`
- `src/components/PatientSlotCard.tsx`

**Implementation:**
- Keep animations that communicate state changes.
- Remove or gate decorative first-load entrance animations on dense/list screens.
- Consider a `useReducedMotion` / "animations enabled" helper if the stack exposes one.

**Acceptance:**
- Screens do not visually jump.
- Initial render work decreases.
- No overlap/clipping regressions on Android.

### 1.5 Measure and replace the global Text/TextInput render patch if it is material

**Why:** `app/_layout.tsx` patches `Text.render` and `TextInput.render` so every raw text element is cloned with the Inter font. That preserves app-wide typography, but it adds per-text render work on text-heavy screens like Home, Records, SOAP detail, and Record.

**Files:**
- `app/_layout.tsx`
- High-density text components: `src/components/RecordingCard.tsx`, `src/components/ui/ListItem.tsx`, `src/components/SoapNoteView.tsx`, `src/components/PatientSlotCard.tsx`

**Implementation:**
- Measure before changing it; do not remove the patch based only on suspicion.
- If it is material, introduce a local `AppText` / `AppTextInput` wrapper or NativeWind/font configuration that avoids cloning every raw element.
- Migrate high-density components first, then remove the global patch only after the migrated surface covers raw app text.
- Preserve the current "no throw at module load" behavior. Any fallback must render with a system font rather than crash.
- Re-run Android text-clipping checks from the project UI gotchas, especially short actions like "Copy" and dense row labels.

**Acceptance:**
- Inter typography remains correct on Android and iOS.
- Text clipping regressions are not introduced.
- Profiling shows reduced render work on text-heavy screens before the global patch is removed.

## Phase 2: Stop repeated focus work

### 2.1 Replace forced focus refetch with freshness-aware refresh

**Why:** The global query client uses 5-minute `staleTime`, but Home and Records manually call `refetch()` on every focus. That turns ordinary tab switching into network work.

**Files:**
- `app/(app)/(tabs)/index.tsx`
- `app/(app)/(tabs)/recordings/index.tsx`
- `src/lib/queryClient.ts`

**Implementation:**
- Replace unconditional `useFocusEffect(handleRefresh)` with freshness-aware logic:
  - If the query is stale, refetch.
  - If a mutation explicitly invalidated recordings, refetch.
  - If the user manually pulls to refresh, always refetch.
  - Otherwise render cached data.
- Preserve polling for active processing recordings, still gated by focused tab.
- Avoid broad `refetchOnWindowFocus` patterns on mobile unless a query truly needs them.

**Acceptance:**
- Switching Home <-> Records within 5 minutes causes zero recordings-list network calls unless a mutation invalidated data or a processing recording is polling.
- Pull-to-refresh still works.
- Processing-status polling still works only while focused.

### 2.2 Centralize local draft listing and reconciliation

**Why:** Home and Records both run `draftStorage.reconcileMissingServerDrafts()` and `draftStorage.listDrafts()` on focus. `reconcileMissingServerDrafts()` may call `recordingsApi.get()` serially for each server-linked draft.

**Files:**
- New hook: `src/hooks/useLocalDraftRecordings.ts`, or a named equivalent if shared query helpers live elsewhere.
- `app/(app)/(tabs)/index.tsx`
- `app/(app)/(tabs)/recordings/index.tsx`
- `src/lib/draftStorage.ts`

**Implementation:**
- Add one shared hook/query for local drafts:
  - query key includes current user id
  - returns local drafts and `draftResumeMap`
  - has stale time, e.g. 30-60 seconds
  - exposes explicit `refreshLocalDrafts`
- Reconcile missing server drafts at most:
  - once per app foreground, or
  - once per N minutes, or
  - after a specific operation that can make server/local state diverge
- If multiple drafts need server presence checks, use bounded concurrency instead of strictly serial checks.
- Store a module-level or query-level "last reconciled at" value per user.
- Keep the "missing server row downgrades to local-only, preserving audio" behavior.

**Acceptance:**
- Home and Records do not duplicate draft reconciliation during a simple tab switch.
- Reconciliation never deletes local audio.
- Offline/unknown server status still defers destructive decisions.
- Server `GET /recordings/:id` calls for draft presence are bounded and observable.

### 2.3 Move nonurgent Record-tab sweeps off first interaction

**Why:** Record mount currently checks pending drafts, subscribes NetInfo sync, runs orphan cleanup, cleans split temp dirs, and runs 30-day eviction. These are useful, but not all need to compete with first render/tap responsiveness.

**Files:**
- `app/(app)/(tabs)/record.tsx`
- `src/lib/draftStorage.ts`
- `src/lib/stashStorage.ts`

**Implementation:**
- Keep user-visible draft loading responsive.
- Schedule nonurgent sweeps with `InteractionManager.runAfterInteractions()` or a short idle timer:
  - pending draft banner count
  - orphan cleanup
  - split temp cleanup
  - 30-day eviction classification
- Ensure cleanup is still once per user and still after user id is scoped.
- Add cancellation flags so unmounted screens do not update state.
- Do not pass an async function directly to `runAfterInteractions`; use a void callback that starts an async IIFE with `.catch(() => {})`.
- Add a fallback timer for any idle-scheduled work that must eventually run. Idle scheduling should never become a hidden "cleanup never ran" bug.
- Keep all Promise chains caught.

**Acceptance:**
- Opening Record does not block on cleanup/reconciliation before first usable UI.
- Eviction and orphan cleanup still run once per user.
- Alerts are not shown before the screen is visibly stable.

### 2.4 Make pending draft sync an app-level singleton or focus-gated job

**Why:** The Record tab subscribes to NetInfo and calls `draftStorage.syncPending()` when connected. If tabs stay mounted, this can run outside the user's current task.

**Files:**
- `app/(app)/(tabs)/record.tsx`
- New hook/provider helper: `src/hooks/usePendingDraftSync.ts`, or a named equivalent if implemented at app-provider level.

**Implementation:**
- Ensure only one pending-sync job runs per user at a time.
- Gate by app active state and authenticated user.
- Consider moving to an app-level provider so it is not tied to Record tab lifecycle.
- Back off after failures to avoid repeated network/storage work.
- Preserve the existing `syncPending()` duplicate-prevention semantics: server draft creation and local `serverDraftId` update must remain ordered per draft.

**Acceptance:**
- No concurrent `syncPending` calls for one user.
- Sync still happens after network returns.
- Failures are best-effort and do not crash or spin.

## Phase 3: Narrow recording query invalidation

### 3.1 Replace broad recordings invalidations where safe

**Why:** The app uses broad `queryClient.invalidateQueries({ queryKey: ['recordings'] })` in many places. One mutation can refetch Home recent, drafts, infinite list pages, detail-adjacent lists, and mounted tabs.

**Files:**
- `app/(app)/(tabs)/record.tsx`
- `app/(app)/(tabs)/recordings/[id].tsx`
- `src/components/RecordingCard.tsx`
- `src/components/DeviceLimitModal.tsx`
- `app/(app)/devices.tsx`

**Implementation:**
- Categorize invalidations:
  - submit/upload success
  - draft create/update/delete
  - review status update
  - detail edit/delete
  - device registration/capacity changes
- Use `setQueryData` for mutations that return updated record payloads.
- Invalidate narrower keys:
  - `['recording', id]`
  - `['recordings', 'recent']`
  - `['recordings', 'drafts']`
  - active list queries only when needed
- Use `refetchType: 'active'` where broad invalidation remains necessary.

**Acceptance:**
- Review toggle updates the current row/detail without refetching unrelated draft/recent queries.
- Draft create/delete updates draft queries without refetching completed-recording lists unless needed.
- Submit success updates recent/list queries predictably.
- Device capacity mutations do not invalidate recordings unless there is a real dependency.

### 3.2 Add cache update tests for key mutation flows

**Why:** Narrow invalidation can cause stale UI if not tested.

**Files:**
- `tests/`
- Query helper modules if extracted.

**Implementation:**
- Add unit tests for helper functions that update or invalidate cache keys.
- Prefer pure helpers where possible, so tests do not require full RN rendering.

**Acceptance:**
- Tests prove that review update, draft deletion, and submit success touch the expected query keys.

## Phase 4: Reduce startup and app-wide background work

### 4.1 Defer cold-start permission snapshot further

**Why:** Root layout loads `expo-audio` and checks mic permission after first frame. That is nonprompting and useful telemetry, but it is not needed before the user reaches Record.

**Files:**
- `app/_layout.tsx`

**Implementation:**
- Move mic permission snapshot to:
  - after auth gate completes and first content is shown, or
  - Record tab first focus, or
  - an idle timer after startup.
- Keep it best-effort, caught, and nonblocking.

**Acceptance:**
- Startup telemetry still records permission state eventually.
- Cold-start JS work is reduced.
- Missing `expo-audio` or native failure cannot affect app launch.

### 4.2 Revisit Google Sign-In module configuration timing

**Why:** `socialAuth.ts` lazy-requires the native Google module, but `RootLayout` calls `configureGoogleSignIn()` during startup when config exists. That startup call invokes the lazy require. It may be cheap, but optional native auth modules are explicitly called out as lazy-load-sensitive in project rules.

**Files:**
- `app/_layout.tsx`
- `src/auth/socialAuth.ts`

**Implementation:**
- Measure `configureGoogleSignIn()` duration before changing it.
- If it is material, move configuration to first Google sign-in button render/press or a post-auth idle task.
- If moved to press-time, configure before `GoogleSignin.hasPlayServices()` / `GoogleSignin.signIn()` and keep the user-facing error behavior unchanged.
- Preserve lazy `require()` patterns for optional native modules.

**Acceptance:**
- Existing Google sign-in still works.
- No module-load crash on older dev clients.
- Cold-start module work does not increase.

### 4.3 Tune device-capacity polling

**Why:** `useDeviceCapacity()` polls every 60 seconds while focused and has `refetchOnWindowFocus: true`. Capacity changes rarely.

**Files:**
- `src/hooks/useDeviceCapacity.ts`
- Home screen device-capacity banner
- Manage Devices screen

**Implementation:**
- Keep Manage Devices fresh.
- On Home, prefer longer `staleTime` and no automatic window-focus refetch unless the app was backgrounded long enough.
- If Home and Manage Devices need different freshness, add explicit options to `useDeviceCapacity()` or create two named hooks. Do not hide screen-specific polling behavior inside one hook.

**Acceptance:**
- Home does not refetch device sessions on normal app focus/tab switches.
- Manage Devices still refreshes when opened or after revoke/register actions.

## Phase 5: Audio workload reduction

### 5.1 Test lower-bitrate mono voice recording

**Why:** Current recording settings are stereo, 44.1 kHz, 256 kbps AAC. For SOAP voice notes this likely creates larger files than needed, increasing disk IO, upload time, FFmpeg work, R2 transfer, battery, and server processing.

**Files:**
- `src/hooks/useAudioRecorder.ts`
- `src/api/recordings.ts` for upload validation unchanged
- Silence detection paths in `app/(app)/(tabs)/record.tsx`

**Implementation:**
- Create a feature-flagged or branch-tested config:
  - `numberOfChannels: 1`
  - `bitRate: 64000` or `96000`
  - keep AAC/m4a
  - consider sample rate 22050/24000/44100 based on `expo-audio` support and transcription quality
- Verify the native encoder actually honors the requested settings on Android and iOS by checking produced file metadata/size, not only by reading JS options. `AudioQuality.MAX` on iOS may need adjustment with the bitrate change.
- Record sample appointments on:
  - Pixel 10 Pro XL
  - lower-end physical Android if available
  - iOS physical device before production release
  - emulator only for UI/start-stop sanity; do not use emulator mic results to accept silence detection or transcription quality
- Compare:
  - file size per minute
  - upload time
  - server transcription quality
  - silence detection behavior
  - pause/resume/stop recovery behavior

**Acceptance:**
- File size drops substantially, target 50%+.
- Transcription quality remains acceptable to owner/test users.
- Silence guard does not falsely reject normal physical-device speech.
- No regression to audio interruption recovery rules.

### 5.2 Avoid repeated Android notification permission bridge calls

**Why:** `start()` requests `POST_NOTIFICATIONS` on every recording start on Android 13+. If already granted/denied, repeated bridge calls are unnecessary.

**Files:**
- `src/hooks/useAudioRecorder.ts`

**Implementation:**
- Check/cache permission status in memory for the session.
- Request only when status is unknown and platform/version requires it.
- Keep denial nonfatal.

**Acceptance:**
- First recording still requests if needed.
- Subsequent starts do not repeatedly bridge/request.
- No unhandled Promise or startup crash.

## Phase 6: Phone landscape and visual density

### 6.1 Decide portrait lock vs explicit phone-landscape support

**Why:** The connected phone was landscape and the app looked cramped/clipped. Even with good frames, cramped UI reads as sluggish because scanning and tapping take longer.

**Files:**
- `app.config.ts`
- Screen layouts under `app/(app)/(tabs)/`

**Options:**
- Lock the app to portrait for phones if phone landscape is not a product requirement.
- Keep tablets flexible, but add explicit phone-landscape layouts if phones must rotate.

**Implementation:**
- If portrait lock is chosen:
  - Change `orientation` carefully and verify EAS/platform behavior.
  - Consider whether tablets still need landscape; Expo static orientation may not support per-device policy without a runtime orientation module, and `expo-screen-orientation` is not currently installed.
- If responsive landscape is chosen:
  - Audit Home, Records, Record, detail, settings for `w997dp h448dp` class.
  - Reduce hero-scale text in compact height.
  - Ensure bottom tabs, list cards, and CTAs do not clip.

**Acceptance:**
- Pixel phone in landscape no longer shows clipped primary UI, or phone no longer rotates into that unsupported layout.
- Physical Android verification includes system font/weight accessibility settings similar to the audited device.

## Phase 7: Conditional monitoring overhead tuning

### 7.1 Tune Sentry tracing after instrumentation data exists

**Why:** Sentry is configured with native frames, stall tracking, user interaction tracing, app start, app hang tracking, and 10% general traces. These are valuable while diagnosing. They should be tuned only after app-specific phase data identifies whether monitoring overhead is material.

**Files:**
- `src/lib/monitoring.ts`

**Implementation:**
- Compare idle CPU and interaction traces with current config.
- If monitoring is visible in CPU traces:
  - reduce general `tracesSampler`
  - disable `enableUserInteractionTracing` if not actionable
  - keep error capture, app start, and native frames if they remain useful
- Do not reduce observability before root-boundary and phase timing triage is complete.

**Acceptance:**
- Monitoring overhead is measured before being reduced.
- Error capture and release health remain intact.
- Upload-path traces remain available enough for production triage.

## Verification matrix

Run after each implementation phase that changes code:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- Android device smoke on the Pixel:
  - cold start to Home
  - Home <-> Records tab switching
  - Records list scroll
  - Record tab open
  - start/pause/resume/finish a short recording
  - Save for Later, resume stash
  - draft resume and submit path if test account permits

Performance targets for the Pixel 10 Pro XL:

- No root error boundary fallback during cold start or tab navigation.
- Warm tab switch with fresh data performs zero automatic recordings/draft network calls in captured smoke logs, unless a mutation invalidated data or processing-status polling is active.
- Home/Records scroll: modern janky frames under 2%, p95 frame time under 16 ms, p99 under 33 ms.
- Idle visible Home CPU trends below 2-3% app CPU after settling.
- Record tab first usable UI appears before cleanup/reconciliation work completes.
- No unbounded memory growth after Home/Records/Record navigation loop.

Release validation:

- Compare Sentry root-boundary events before/after release.
- Compare app-start and slow/frozen-frame metrics by release.
- Compare network request count for normal Home/Records tab switching.
- Track upload duration and file size per recording after audio-setting changes.

## Recommended implementation order

1. Root error boundary triage and phase timing instrumentation.
2. `AuthContext.Provider` memoization, narrower auth hooks for hot consumers, non-animated `Card` plain `View`, ordinary list-row animation reduction, and measured Text/TextInput patch replacement if profiling justifies it.
3. Freshness-aware Home/Records focus behavior and shared local-drafts hook.
4. Narrow recordings query invalidations.
5. Defer Record-tab sweeps and make pending draft sync singleton/focus-safe.
6. Audio bitrate/channel experiment and rollout.
7. Phone orientation/layout decision.
8. Sentry tracing overhead tuning only if measurements justify it.

This order puts measurement and smaller render changes before larger data-flow, audio, and layout work.

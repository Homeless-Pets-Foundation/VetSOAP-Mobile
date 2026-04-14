# Captivet Mobile — Project Guidelines

## Architecture

- **Framework:** Expo SDK 55, RN 0.83.4, React 19
- **Routing:** expo-router (file-based, `app/`)
- **State:** React Query = server; Context = auth; useReducer = multi-patient session
- **Styling:** NativeWind v4 (Tailwind via `global.css`)
- **Auth:** Supabase + `expo-secure-store` token persist
- **Build:** EAS managed (no `android/`/`ios/` committed)

## Shared Infrastructure

Mobile, web (Captivet Connect), prod API — **all** auth vs same Supabase project. Wrong project → silent auth fail.

| Service | Value |
|---|---|
| Supabase ref | `shdzitupjltfyembqowp` |
| Supabase URL | `https://shdzitupjltfyembqowp.supabase.co` |
| Prod API | `https://api-production-8e5e.up.railway.app` |

Source of truth. `.env` + EAS secrets must match.

## Critical Crash Prevention Rules

From prod crash audits. Break → Android APK crashes.

### 1. Never throw at module load

`src/config.ts` exports `CONFIG_MISSING`, no throw. `src/auth/supabase.ts` uses placeholder client if config missing. New module-level init on env/external state **must** degrade gracefully — never `throw` at top level.

### 2. Never pass async fn to void callback

RN callbacks (`onPress`, `onValueChange`, `AppState.addEventListener`, `Alert.onPress`, `Switch.onValueChange`, `RefreshControl.onRefresh`) typed `() => void` → async fn → discarded Promise. Hermes + unhandled rejection = **fatal crash**.

```tsx
// BAD — unhandled rejection crashes Hermes
<Switch onValueChange={async (v) => { await doThing(v); }} />

// GOOD
<Switch onValueChange={(v) => {
  doThing(v).catch((e) => console.error(e));
}} />

// ALSO GOOD
const handleChange = async (v: boolean) => {
  try { await doThing(v); } catch (e) { console.error(e); }
};
<Switch onValueChange={handleChange} />
```

### 3. Always wrap SecureStore / Keystore in try/catch

`expo-secure-store` → Android Keystore. Throws on: Keystore corruption after failed OS update, Direct Boot (pre-unlock), low storage, key invalidated after screen-lock change. `src/lib/secureStorage.ts` + `src/lib/biometrics.ts` wrap every call. **Never** call `SecureStore.*` direct — always wrappers.

### 4. Never fire-and-forget Promises without `.catch()`

Non-awaited Promise **must** have `.catch()` or be inside try/catch.

```tsx
// BAD — if setToken rejects, app crashes
secureStorage.setToken(token);

// GOOD
secureStorage.setToken(token).catch(() => {});

// GOOD
await secureStorage.setToken(token); // inside try/catch block
```

### 5. Always use `finally` for loading state

`isLoading = true` → reset in `finally`. Throw between → UI stuck loading forever.

```tsx
// BAD — isLoading stuck on throw
setIsLoading(true);
const result = await signIn(email, password);
setIsLoading(false);

// GOOD
setIsLoading(true);
try {
  const result = await signIn(email, password);
} finally {
  setIsLoading(false);
}
```

### 6. Guard biometric/auth in AppState handlers

`AppState.addEventListener('change', handler)` discards async. Handler **must** have outer try/catch + reset `isAuthenticating` in `finally`. Else biometric hw error → app permanently locked.

### 7. expo-audio ops throw anytime

`pause()`, `record()`, `stop()` throw on interrupt (call, focus lost, permission revoked). `record.tsx` wraps in try/catch + Alert. `pause()` + `record()` sync; `stop()` + `prepareToRecordAsync()` async. In `useAudioRecorder`: `pause()`/`resume()` catch, cleanup (stop recorder, save URI, reset audio mode), then **rethrow** — callers handle (show "Recording Saved" alert).

### 8. Keep `validateRequestUrl()` inside try in `ApiClient.request()`

SSL pin validation inside try/catch so `finally` runs `clearTimeout(timeout)`. Move out → timer leak + uncaught throw.

### 9. Always `.catch(() => {})` on Haptics

`Haptics.*Async()` rejects on devices lacking haptic hw (tablets, emulators, budget phones). Always fire-and-forget in sync callbacks → unhandled → Hermes fatal.

```tsx
// BAD — crashes on devices without haptic motor
Haptics.selectionAsync();

// GOOD
Haptics.selectionAsync().catch(() => {});
```

Applies everywhere incl. shared `Button` (`src/components/ui/Button.tsx`) — every press.

### 10. Sign-out awaits PHI cleanup before clearing auth

`handleSignOut` in `AuthProvider.tsx` awaits all cleanup (stash storage, stash audio, cache audio, editor temp, drafts) via `Promise.all` **before** `setUser(null)` + `setSession(null)`. Prevents next-user-signs-in-during-prev-user-cleanup race on shared tablets. Cleanup has retry + `.catch()` to not block. In-memory state (audio editor bridge, clipboard) also cleared.

### 11. Audio recorder hook must recover from native failures

`useAudioRecorder` ops call expo-audio → can throw anytime:
- **`stop()`** — swallow errors (try/catch, no rethrow). State + URI always cleaned.
- **`pause()` / `resume()`** — catch, cleanup (capture duration, force `recorder.stop()`, save URI, state → `stopped`, reset audio mode), **rethrow**. Callers catch → show user feedback.

Without → one native fail permanently corrupts hook.

Recorder via expo-audio `useAudioRecorder` → auto-releases on unmount. Polling via `useAudioRecorderState(recorder, 500)` (500ms = responsiveness vs CPU on weak hw).

### 12. Validate local files before upload

`recordingsApi.createWithFile()` + `createWithSegments()` — check `getInfoAsync(uri)` pre-upload. 250MB/file client limit (`MAX_FILE_SIZE_BYTES`), 10min timeout (`R2_UPLOAD_TIMEOUT_MS`) via `withTimeout()`. `createWithSegments()` validates each segment. Missing/empty → user-friendly throw, not silent 0-byte upload.

### 13. Guard `response.json()` against null + unexpected shapes

API error body can be literal `null` (valid JSON). Always `?? {}` after `.catch(() => ({}))`. `Array.isArray()` before `.map()` on fields like `details`.

### 14. Guard `new Date()` before Intl

`new Date(null)` / `new Date(undefined)` → "Invalid Date". Hermes + `.toLocaleDateString()` w/ Intl options → `RangeError`. Check `isNaN(parsedDate.getTime())` first.

### 15. Wrap `refetch` before RefreshControl/onRefresh

`refetch()` returns Promise; `RefreshControl.onRefresh` typed `() => void`. Wrap: `() => { refetch().catch(() => {}); }`.

### 16. Gate `console.error` behind `__DEV__`

Android `console.error` visible via `adb logcat` even on release. Shared clinic tablets + USB = PHI leak risk. All `console.error` → `if (__DEV__) console.error(...)`.

### 17. Stash/draft ops require user ID first

`stashStorage`, `stashAudioManager`, `draftStorage` — all user-scoped to prevent cross-user leak on shared tablets. All expose `setUserId(userId)` — **must** be called before any read/write. Called in `fetchUser()` in `AuthProvider.tsx`. Cleanup (orphaned dirs, legacy migration, orphan drafts) runs **after** `setUserId` — never on timer that could fire before `fetchUser`.

### 18. Upload URL validation fail-closed

`validateUploadUrl()` in `sslPinning.ts` throws if `R2_BUCKET_HOSTNAME` empty. All uploads fail in prod if EAS secret missing — intentional. Upload to unvalidated URL worse than failing.

### 19. Validate segment URIs before accept

`RESTORE_SESSION` + `REPLACE_ALL_SEGMENTS` in `useMultiPatientSession.ts` run `validateSegments()` → keep only local `file://` or absolute `/`. Blocks corrupted stash / compromised editor bridge from injecting remote URL that exfiltrates audio on upload.

### 20. Distinguish user sign-out from session expiry in `onAuthStateChange`

Supabase emits `SIGNED_OUT` for explicit sign-out **and** expired/failed refresh. Clearing on every `SIGNED_OUT` → logs users out on transient network fail. Two refs in `AuthProvider.tsx`:

- **`userInitiatedSignOutRef`** — `true` inside `handleSignOut()`, reset on next sign-in. `SIGNED_OUT` + this `false` → try one `refreshSession()` before clearing.
- **`sessionRecoveryAttemptedRef`** — caps recovery at once per cycle. Reset on successful sign-in or recovery.

Don't remove either or collapse paths → reintroduces "transient glitch logs out user" bug OR infinite recovery loop.

### 21. Supabase session storage writes must read-back verify

Post-rotate, old refresh token invalidated server-side. SecureStore silent fail → no valid refresh token → next refresh fails → user logged out despite successful rotation.

Adapter in `src/auth/supabase.ts`: `setItem` writes → reads back → retries once if differ. On throw, wait 1.5s + retry. Never simplify to bare `await secureStorage.setSession(value)`.

### 22. Foreground-resume refresh reads current session, not closure

`AppState` `'active'` handler in `AuthProvider.tsx` calls `supabase.auth.getSession()` inside handler. Closure over `session?.expires_at` → stale / null `expires_at` from SecureStore → refresh skipped entirely. Effect deps stay `[]` — `supabase` module-singleton, `refreshPromiseRef` ref.

### 23. Lazy-load optional native auth modules

`@react-native-google-signin/google-signin`, `expo-apple-authentication`, `expo-crypto` — `require()` on first use in `src/auth/socialAuth.ts`, **not** static import. Old dev-client APKs pre-these-deps → crash on module load if static. New optional native auth module → same pattern.

Google Sign-In Expo config plugin in `app.config.ts` conditionally included only when `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` set — Android builds don't need iOS URL scheme; unconditional → prebuild fails on Android-only dev.

### 24. Propagate new PatientSlot fields through stash round-trip

Fields on `PatientSlot` that affect `uploadSlot` server behavior (`serverRecordingId`, `serverDraftId`, future idempotency keys) **must** land in all three sites:

1. `StashedSlot` type (`src/types/stash.ts`)
2. `stashAudioManager.moveSegmentsToStashDir()` write (`src/lib/stashAudioManager.ts`)
3. `useStashedSessions.convertToPatientSlots()` read (`src/hooks/useStashedSessions.ts`) + its local param type

Miss any → Resume strips field → Submit hits fresh-create → duplicate server recording. Fix e.g. `397f109`.

## Device Binding

Mobile sends `X-Device-Id` header every API req. UUID v4 gen'd on first launch, persist in SecureStore (survives sign-out — device-scoped, not user-scoped). Server `validateDeviceSession` requires it, can revoke specific devices.

- `secureStorage.getDeviceId()` — gen + cache UUID
- `ApiClient.doFetch()` — memory-caches device ID after first SecureStore read
- `AuthProvider.registerDevice()` — called on sign-in AND session restore
- Server → `DEVICE_REVOKED` (401) → client forces sign-out + msg
- Server → `DEVICE_ID_REQUIRED` (401) → "restart or reinstall" msg (Keystore fail)

## EAS Build Notes

- **Secrets:** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — EAS project-level (not `eas.json`).
- **Credentials:** preview + production → `credentialsSource: "remote"` (EAS-managed).
- **Lock file:** sync via `npm install --legacy-peer-deps` pre-build if deps change. EAS uses `npm ci` → fails on mismatch. `.npmrc` has `legacy-peer-deps=true` for `@config-plugins/ffmpeg-kit-react-native` peer dep conflict w/ Expo SDK 55.
- **Secrets sync:** after `.env` edit → `eas secret:push --scope project --env-file .env --force`. Stale EAS secret overrides local `.env` in prod builds.
- **Metro cache:** after `.env` edit → `npx expo start --clear`. Metro inlines `EXPO_PUBLIC_*` at build time → stale cache silently uses old values. Dev mode: `config.ts` warns if Supabase vars empty.
- **FFmpeg Maven repo:** `com.arthenica:ffmpeg-kit-min` removed from Maven Central. Self-hosted: `https://homeless-pets-foundation.github.io/ffmpeg-kit-maven`. Wired in `app.config.ts` `extraMavenRepos` (Gradle 9 req). **Current: `6.0-3`** (16KB page-size, built from `arthenica/ffmpeg-kit` `development`). Rebuild: `Homeless-Pets-Foundation/ffmpeg-kit-maven` → Actions → "Build FFmpeg Kit min (16KB page size)" → Run.
- **ffmpeg-kit-react-native patch:** `patches/ffmpeg-kit-react-native+6.0.2.patch` overrides AAR `6.0-2` → `6.0-3` in npm pkg `gradle.properties`. Applied via `postinstall: patch-package` after `npm ci`. Bump AAR → update patch version string.
- **Expo doctor:** `npx expo-doctor` before every EAS build. Pre-build hook (`.claude/hooks/pre-eas-build.sh`) enforces auto. Dependabot bumps past Expo SDK compat → `npx expo install --fix`.
- **APP_VARIANT:** `app.config.ts` exposes `extra.isProduction` from `APP_VARIANT=production`. Gates prod-only features at runtime (e.g. screen capture prevention, when re-enabled).

## Emulator Testing (WSL2)

Metro in WSL2; emulator on Windows. All `adb` → **Windows** ADB binary (`adb.exe`), not WSL2 `adb`.

### Setup & Launch

1. **Start emulator:**
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/emulator/emulator.exe" -avd Medium_Phone_API_36.1 -no-snapshot-load &>/dev/null &
   ```
2. **Wait for emulator** (via Windows ADB):
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" devices
   ```
3. **ADB reverse** (emulator localhost → Windows localhost):
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" reverse tcp:8081 tcp:8081
   ```
4. **Port proxy** (Windows localhost → WSL2 IP, admin req):
   ```bash
   WSL_IP=$(ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
   powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1; netsh interface portproxy add v4tov4 listenport=8081 listenaddress=127.0.0.1 connectport=8081 connectaddress=$WSL_IP' -Verb RunAs"
   ```
5. **Start Metro** (clean cache post code change):
   ```bash
   npx expo start --clear
   ```
6. **Deep-link app**:
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" shell am start -a android.intent.action.VIEW -d 'captivet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
   ```

Port 8081 busy → `lsof -ti:8081 | xargs kill -9`.

### ADB UI Interaction

All Windows ADB.

| Action | Command |
|--------|---------|
| Screenshot | `adb.exe exec-out screencap -p > /tmp/screen.png` (view via Read tool) |
| Tap | `adb.exe shell input tap <x> <y>` (px, 1080x2400) |
| Swipe/Scroll | `adb.exe shell input swipe <x1> <y1> <x2> <y2> <ms>` |
| Type text | `adb.exe shell input text "hello"` (no spaces — use `%s`) |
| Press back | `adb.exe shell input keyevent KEYCODE_BACK` |
| Dismiss keyboard | `adb.exe shell input keyevent 66` (ENTER — safer than ESCAPE) |
| UI hierarchy | `adb.exe shell uiautomator dump /sdcard/ui.xml && adb.exe shell cat /sdcard/ui.xml` |

#### Keycode gotcha — avoid ESCAPE + MENU

`KEYCODE_ESCAPE` (111) + `KEYCODE_MENU` (82) → Expo dev element inspector. Send mid-test → inspector overlay engages → intercepts taps on form fields → session unworkable.

- **Dismiss keyboard:** tap neutral area, or `KEYCODE_ENTER` (66).
- **Reload bundle:** tap `Reload` in dev menu, not `KEYCODE_MENU`.
- **Tools button:** dev menu → toggle off `Tools button` at session start (otherwise steals taps near top-right where `Save for Later` sits).

Inspector re-engaged → `am force-stop com.captivet.mobile` + relaunch is only reliable clear.

#### Emulator upload limit

`hasSilentAudioOnly()` uses `peakMetering` sampled at record-time. Emulator mic → peaks ≤ −20 dBFS → every Submit throws "This recording appears silent" **before** API call. Upload-path regressions (e.g. `serverDraftId` promotion) verifiable only by count-doesn't-bump on emulator. Full server-side path = physical device.

### Finding Tap Coordinates

1. **Preferred: `uiautomator dump`** — XML w/ `bounds="[left,top][right,bottom]"`. Center: `x = (left + right) / 2`, `y = (top + bottom) / 2`. Filter `grep -iE "button_text\|content_desc"`.
2. **Fallback: screenshot** — dump fails during animations ("could not get idle state"). Screenshot + Read + estimate. Screen 1080x2400.

### Key App Flows

- **Record:** Home → Record tab / "Record Appointment" → fill Patient Name, Client Name, Species, Appointment Type → scroll → "Start recording" → wait → "Finish".
- **Stash:** during/after record → "Save for Later" (top-right) → "SAVE" → appears under "Saved Sessions" w/ "Resume Session".
- **Edit:** post-record → "Edit Recording" → waveform, trim handles, playback, "Apply Trim" / "Done".
- **Draft-save-on-finish:** Finish → server `status='draft'` + local draftStorage entry → Home/Records "Not Submitted" (amber) → tap card → reopens Record w/ form + audio. Submit → promotes draft in place (no duplicate).
- **App package:** `com.captivet.mobile`. Launch: `adb.exe shell am start -n com.captivet.mobile/.MainActivity`.

## File Conventions

- `src/lib/secureStorage.ts` — sole `expo-secure-store` interface. All calls try/catch. `getDeviceId()` → persistent UUID v4 on first call (memory-cached). `DEVICE_ID` NOT deleted in `clearAll()` — device-scoped.
- `src/lib/biometrics.ts` — sole `expo-local-authentication` + biometric pref interface. All wrapped.
- `src/lib/fileOps.ts` — safe wrappers around `expo-file-system` `File`/`Directory`. Use `safeDeleteFile`/`safeDeleteDirectory`, never `.delete()` direct. Never import `expo-file-system/legacy` in new code.
- `src/lib/secureClipboard.ts` — 30s auto-clear clipboard for sensitive data. `clearClipboard()` for sign-out.
- `src/lib/audioEditorBridge.ts` — singleton bridging `record.tsx` ↔ `audio-editor.tsx`. `clear()` for sign-out.
- `src/lib/stashStorage.ts` — encrypted stash metadata, chunked (Android 2KB limit). **User-scoped**: keys prefixed w/ user ID. `setUserId()` required first. `clearLegacyGlobalStashes()` one-time migration.
- `src/lib/stashAudioManager.ts` — stashed audio in `documentDirectory/stashed-audio/{userId}/`. `setUserId()` first. Session IDs validated vs path traversal. `moveSegmentsToStashDir` persists `serverDraftId`/`draftSlotId` through round-trip (rule 24).
- `src/lib/draftStorage.ts` — local audio draft persistence. SecureStore metadata (chunked) + audio at `documentDirectory/drafts/{userId}/{slotId}/`. **User-scoped**: `setUserId()` first. `saveDraft`/`getDraft`/`listDrafts`/`deleteDraft`/`clearAll`. `syncPending(createFn)` retries unsynced server-draft creations on reconnect. `cleanupOrphaned(deleteFn)` runs on Record mount → sweeps entries w/ missing local audio + deletes server row.
- `src/config.ts` — env var access + graceful fallback. Exports `CONFIG_MISSING`.
- `app/_layout.tsx` — gates app on `CONFIG_MISSING` before providers mount. Root `ErrorBoundary` wraps tree.
- `src/components/ui/Button.tsx` — shared button + haptics, optional `icon`. `Haptics.impactAsync` has `.catch()`. No shadow on `ghost`. Every press flows here.
- `src/hooks/useAudioRecorder.ts` — wraps expo-audio. `audioSource: 'voice_recognition'` on Android. `stop()` swallows; `pause()`/`resume()` catch+cleanup+rethrow. `resetWithoutDelete()` clears state, keeps file; `reset()` clears state + deletes file. Auto-releases on unmount.
- `src/hooks/useMultiPatientSession.ts` — `useReducer` multi-patient state. ≤10 `PatientSlot`s w/ `segments[]`, recorder binding, upload status, `CONTINUE_RECORDING` for multi-segment. `RESTORE_SESSION` + `REPLACE_ALL_SEGMENTS` validate URIs. `SET_DRAFT_IDS` sets `draftSlotId`+`serverDraftId`.
- `src/hooks/useStashedSessions.ts` — stash list + resume. `stashSession` moves segments to stash dir, writes metadata, then `draftStorage.deleteDraft()` for every slot w/ `draftSlotId` (stash owns audio post-commit). `convertToPatientSlots` restores `serverDraftId`/`draftSlotId` from stash payload.
- `src/types/multiPatient.ts` — `PatientSlot`, `AudioSegment`, `SessionAction`, `SessionState`. `PatientSlot` incl. `draftSlotId`/`serverDraftId` for auto-saved drafts.
- `src/types/stash.ts` — `StashedSlot`/`StashedSegment`/`StashedSession`. `StashedSlot` carries optional `serverDraftId`/`draftSlotId` (rule 24).
- `src/auth/AuthProvider.tsx` — `handleSignOut` awaits stash + drafts PHI cleanup before clearing state. `fetchUser()` calls `setStashUserId()` + `draftStorage.setUserId()`. `registerDevice()` on sign-in + session restore. Cleanup only after user ID set.
- `src/api/client.ts` — sends `X-Device-Id` header all reqs. Memory-caches device ID. Handles `DEVICE_REVOKED`/`DEVICE_ID_REQUIRED` 401s before token refresh.
- `src/api/recordings.ts` — `createWithFile()` single-segment, `createWithSegments()` multi. Both validate via `getInfoAsync()`, 250MB limit, 10min timeout. Both take optional `existingRecordingId` → skips `create()`, uses server draft as recording ID (promote path).
- `src/components/AppLockGuard.tsx` — biometric on cold start (not just bg resume). Defaults `isLocked=true` + blank screen until biometric done (no PHI flash). Sign-out = escape hatch.
- `src/components/PatientSlotCard.tsx` — per-patient form + recording + upload status. "Finish" (not "Stop") w/ checkmark. "Delete & Start Over" = de-emphasized text link.
- `src/components/PatientTabStrip.tsx` — horizontal tab strip to switch slots. Status badges (recording, paused, stopped, uploaded).
- `src/components/SubmitPanel.tsx` — bottom panel w/ "Submit All". Visible when multiple slots ready.
- `src/components/RecordingCard.tsx` — list item. `status='draft'` → amber "Not Submitted" badge. Tap → `/(tabs)/record?draftSlotId=X` (resume) if local draft exists, else detail screen.

## Multi-Patient Recording Architecture

`app/(app)/record.tsx` → ≤10 patients/session. Each = "slot" as horizontally-pageable card.

### Data Model — `src/types/multiPatient.ts`

- **`AudioSegment`** — `{ uri: string; duration: number }`. One continuous recording file.
- **`PatientSlot`** — form data (`CreateRecording`), `audioState` (`idle`|`recording`|`paused`|`stopped`), `segments[]`, upload lifecycle (`uploadStatus`, `uploadProgress`, `uploadError`, `serverRecordingId`), draft linkage (`draftSlotId`, `serverDraftId`).
- **`SessionState`** — `{ slots: PatientSlot[]; activeIndex: number; recorderBoundToSlotId: string | null }`.
- **`SessionAction`** — discriminated union dispatched to reducer.

Max 10 slots enforced in `ADD_SLOT`.

### Recorder Ownership

Single `useAudioRecorder` shared across slots. One owner at a time via `recorderBoundToSlotId`.

- **`BIND_RECORDER`** — on start, sets `recorderBoundToSlotId`.
- **`UNBIND_RECORDER`** — after audio captured (`recorder.state === 'stopped'` effect).
- **Pending-start queue** — new start while another recording/paused → stop current via `pendingStartSlotRef`. Post-stop + save, pending slot auto-starts via `startRecordingRef`.
- **Auto-pause on swipe** — swipe away (`handleScrollEnd`) → pause. Pause fail (rethrown) → stop fallback.
- **Consistency guard** — effect watches `recorderBoundToSlotId` → orphaned slot w/ `audioState: 'recording'` forced back to `stopped` (w/ segments) or `idle`.

### Multi-Segment Recording

Each slot's `segments[]` = source of truth.

- **`SAVE_AUDIO`** — append segment + sum duration.
- **`CONTINUE_RECORDING`** — `audioState` → `idle`. Hook `resetWithoutDelete()` clears state, keeps file.
- **Upload** — `uploadSlot()` → `createWithFile()` (single) or `createWithSegments()` (multi). Multi uploads each segment to own presigned URL, confirms w/ all segment keys.

### Concurrency Guards (six refs in `record.tsx`)

| Ref | Purpose |
|---|---|
| `audioCaptureDoneRef` | Prevents `recorder.state === 'stopped'` effect double-save |
| `pendingStartSlotRef` | Queues next slot after current stop completes |
| `startRecordingRef` | Stable ref to `startRecordingForSlot` inside effect (avoids stale closure) |
| `stoppingRef` (in hook) | Prevents double-`stop()` |
| `isScrollingRef` | Suppresses programmatic `scrollToIndex` during user swipe |
| `swipeChangeRef` | Prevents `activeIndex` effect re-scrolling after swipe moved pager |

### Upload State Machine

Per-slot: `pending` → `uploading` → `success` | `error`.

- **`uploadSlot(slot)`** → `string | null` (server recording ID or null on fail). Skip if uploading/succeeded. `slot.serverDraftId` set → spreads `existingRecordingId` into `createWithFile`/`createWithSegments` → promotes draft in place (no duplicate).
- **Single submit** (`handleSubmitSingle`) — other slots still unsaved → stay on record; else reset + nav to detail.
- **Submit all** (`handleSubmitAll`) — all eligible slots **sequentially** (no network saturation). Full success → reset + nav to list. Partial fail → alert + stay.
- **Post-upload cleanup** — local audio + local draft metadata (if `draftSlotId` set) deleted.

### Navigation & Cleanup

- **`usePreventRemove`** — blocks nav when `unsavedCount > 0` (segments not yet uploaded, or recording/paused). Discard confirm w/ precise count.
- **Discard cleanup** — on confirm, iterate slots + delete all segment files via `FileSystem.deleteAsync`.
- **`resetSession`** — dispatches `RESET_SESSION`. Required because record tab stays mounted across navigations → no reset = stale state.

## Draft-Save-on-Finish

Finish tap → server `status='draft'` + local `draftStorage` entry → Home/Records "Not Submitted" (amber). Tap card → Record w/ form + audio preloaded via `loadDraft(draftSlotId)`.

### Lifecycle

1. **Finish** → `autoSaveDraft(slot)` in `record.tsx`:
   - `draftStorage.saveDraft(slot)` → copies audio to `drafts/{userId}/{slotId}/`, writes SecureStore metadata (`pendingSync: true`).
   - Online → `recordingsApi.create(formData, { isDraft: true })` → `updateServerDraftId()` + `pendingSync: false`. Offline → stays `pendingSync: true`; retried on NetInfo reconnect via `draftStorage.syncPending()`.
   - `dispatch SET_DRAFT_IDS` → slot gets `draftSlotId` + `serverDraftId`.

2. **Save for Later (stash)** — `stashSession` moves segments to stash dir, writes stash payload (incl. `serverDraftId`/`draftSlotId`), **then** `draftStorage.deleteDraft(draftSlotId)` → stash owns audio, local draft metadata removed. Server draft row stays (referenced via stash).

3. **Resume** — `useStashedSessions.resumeSession` → `convertToPatientSlots` restores `draftSlotId` + `serverDraftId` from stash payload (rule 24). Session `audioState: stopped`, ready to submit.

4. **Submit** — `uploadSlot()` sees `slot.serverDraftId` → adds `existingRecordingId` in `createWithFile`/`createWithSegments` → server promotes draft in place (no duplicate). Post-success: `draftStorage.deleteDraft(draftSlotId)` + local audio delete.

5. **Orphan sweep** — Record tab mount runs `draftStorage.cleanupOrphaned(recordingsApi.delete)` → drafts w/ missing local audio → delete server row + local metadata. Clears "Not Submitted" zombies from older clients that stashed before rule 24 was enforced.

### Storage Layout

- **Local metadata:** SecureStore `captivet_draft_{userId}_{slotId}_meta` + chunks (2KB workaround, same pattern as stash). Index at `captivet_drafts_index_{userId}`.
- **Local audio:** `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a`.
- **Server:** `Recording` row w/ `status='draft'`. Server `confirmUpload` allows `draft → uploading` transition.

### Sign-Out Cleanup

`handleSignOut` in `AuthProvider.tsx` → `draftStorage.clearAll()` in `Promise.all` alongside stash cleanup. Blocks `setUser(null)`/`setSession(null)` until all PHI gone (shared tablet safety, rule 10).

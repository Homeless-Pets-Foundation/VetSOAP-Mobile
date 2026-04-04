# Captivet Mobile — Project Guidelines

## Architecture

- **Framework:** Expo SDK 55, React Native 0.83.4, React 19
- **Routing:** expo-router (file-based, `app/` directory)
- **State:** React Query for server state, React context for auth, useReducer for multi-patient session
- **Styling:** NativeWind v4 (Tailwind CSS via `global.css`)
- **Auth:** Supabase Auth with `expo-secure-store` token persistence
- **Build:** EAS Build (managed workflow, no bare `android/` or `ios/` committed)

## Shared Infrastructure

The mobile app, web app (Captivet Connect), and production API server **must** all authenticate against the same Supabase project. User accounts exist in one Supabase instance — if any client points to a different project, auth will silently fail.

| Service | Value |
|---|---|
| **Supabase project ref** | `shdzitupjltfyembqowp` |
| **Supabase URL** | `https://shdzitupjltfyembqowp.supabase.co` |
| **Production API** | `https://api-production-8e5e.up.railway.app` |

These are the single sources of truth. The `.env` file and EAS secrets must match these values.

## Critical Crash Prevention Rules

These rules come from production crash audits. Violating them will cause crashes on Android APKs.

### 1. Never throw at module load time in production

`src/config.ts` exports a `CONFIG_MISSING` flag instead of throwing. `src/auth/supabase.ts` uses a placeholder Supabase client when config is missing. Any new module-level initialization that depends on env vars or external state **must** degrade gracefully — never `throw` at the top level.

### 2. Never pass raw `async` functions to void-returning callbacks

React Native callbacks (`onPress`, `onValueChange`, `AppState.addEventListener`, `Alert.onPress`, `Switch.onValueChange`, `RefreshControl.onRefresh`) are typed as returning `void`. Passing an `async` function discards the returned Promise. On Hermes (Android production), an unhandled promise rejection from a discarded Promise is a **fatal crash**.

**Always** wrap async work in try/catch when called from these callbacks:

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

### 3. Always wrap SecureStore / Keystore operations in try/catch

`expo-secure-store` delegates to Android Keystore which can throw in real-world scenarios:
- Keystore corruption after failed OS updates
- Direct Boot mode (before first unlock)
- Low storage conditions
- Key permanently invalidated after screen lock changes

`src/lib/secureStorage.ts` and `src/lib/biometrics.ts` wrap every call. **Never** call `SecureStore.*` directly elsewhere — always go through these wrappers.

### 4. Never fire-and-forget Promises without `.catch()`

Any Promise that is not `await`-ed **must** have a `.catch()` or be inside a try/catch. Common offenders:

```tsx
// BAD — if setToken rejects, app crashes
secureStorage.setToken(token);

// GOOD
secureStorage.setToken(token).catch(() => {});

// GOOD
await secureStorage.setToken(token); // inside a try/catch block
```

### 5. Always use `finally` for loading state cleanup

If a function sets `isLoading = true`, the `false` reset **must** be in a `finally` block, not after the await. Otherwise, any thrown exception leaves the UI permanently stuck in a loading state.

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

### 6. Guard biometric/auth async flows in AppState handlers

`AppState.addEventListener('change', handler)` discards async return values. The handler **must** have an outer try/catch, and `isAuthenticating` state must be reset in a `finally` block. Otherwise a biometric hardware error permanently locks the app with no escape.

### 7. expo-audio recording operations can throw at any time

`pause()`, `record()`, `stop()` throw if the audio session is interrupted (phone call, audio focus lost, permission revoked). Callers in `record.tsx` must wrap in try/catch with user-visible error feedback (Alert). Note: `pause()` and `record()` are synchronous in expo-audio; only `stop()` and `prepareToRecordAsync()` are async. In the `useAudioRecorder` hook, `pause()` and `resume()` catch errors, perform internal cleanup (stop recorder, save URI, reset audio mode), then **rethrow** — callers must handle the rethrown error (typically by showing a "Recording Saved" alert).

### 8. Keep `validateRequestUrl()` inside the try block in `ApiClient.request()`

SSL pinning validation must be inside the try/catch so the `finally` block can still run `clearTimeout(timeout)`. Moving it outside causes timer leaks and uncaught exceptions.

### 9. Always add `.catch(() => {})` to Haptics calls

Every `Haptics.*Async()` call (`impactAsync`, `selectionAsync`, `notificationAsync`) returns a Promise that rejects on devices without haptic hardware (tablets, emulators, budget phones). Since Haptics calls are always fire-and-forget inside sync callbacks, the rejected Promise is unhandled — fatal on Hermes.

```tsx
// BAD — crashes on devices without haptic motor
Haptics.selectionAsync();

// GOOD
Haptics.selectionAsync().catch(() => {});
```

This applies everywhere including the shared `Button` component (`src/components/ui/Button.tsx`), which runs on every button press in the app.

### 10. Sign-out must await PHI cleanup before clearing auth state

`handleSignOut` in `AuthProvider.tsx` awaits all data cleanup (stash storage, stash audio, cache audio, editor temp files) via `Promise.all` **before** calling `setUser(null)` and `setSession(null)`. This prevents a race where the next user signs in while the previous user's data is still being deleted on the shared tablet. The cleanup has retry logic and `.catch()` to avoid blocking sign-out indefinitely. In-memory state (audio editor bridge, clipboard) is also cleared.

### 11. Audio recorder hook must recover from native failures

`useAudioRecorder` operations (`stop`, `pause`, `resume`) call expo-audio methods that can throw at any time. Each has a different error strategy:

- **`stop()`** — swallows errors (try/catch with no rethrow). State and URI are always cleaned up.
- **`pause()` / `resume()`** — catch errors, perform cleanup (capture duration, force `recorder.stop()`, save URI, set state to `stopped`, reset audio mode), then **rethrow**. Callers must catch the rethrown error and show user feedback (e.g. "Recording Saved" alert).

Without this recovery, a single native failure permanently corrupts the hook — subsequent interactions crash.

The recorder is created via expo-audio's `useAudioRecorder` hook which auto-releases native resources on unmount. Status polling uses `useAudioRecorderState(recorder, 250)` for duration and metering updates.

### 12. Validate local file reads before upload

In `recordingsApi.createWithFile()` and `createWithSegments()`, always check file existence and size via `getInfoAsync(uri)` before uploading. Enforce a 250MB per-file limit client-side (`MAX_FILE_SIZE_BYTES`). Both methods use a 10-minute timeout (`R2_UPLOAD_TIMEOUT_MS`) per upload via `withTimeout()`. `createWithSegments()` validates each segment independently. A missing or empty audio file should throw a user-friendly error rather than silently uploading a 0-byte file.

### 13. Guard `response.json()` results against null and unexpected shapes

API error bodies can be literal `null` (valid JSON). Always use `?? {}` after `.catch(() => ({}))` on error-path `response.json()` calls. Similarly, use `Array.isArray()` to validate array fields like `details` before calling `.map()`.

### 14. Guard `new Date()` before calling Intl formatting methods

`new Date(null)` or `new Date(undefined)` produces an "Invalid Date" object. On Hermes, calling `.toLocaleDateString()` with Intl options on an Invalid Date throws a `RangeError`. Always check `isNaN(parsedDate.getTime())` before formatting.

### 15. Wrap `refetch` before passing to RefreshControl/onRefresh

React Query's `refetch()` returns a Promise. `RefreshControl.onRefresh` is typed as `() => void`, so the Promise is discarded. Wrap it: `() => { refetch().catch(() => {}); }`.

### 16. Gate all `console.error` behind `__DEV__`

On Android, `console.error` output is readable via `adb logcat` even on release builds. On shared clinic tablets, this could leak internal state to anyone with USB access. All `console.error` calls must be wrapped: `if (__DEV__) console.error(...)`.

### 17. Stash operations require user ID to be set first

`stashStorage` and `stashAudioManager` scope all data by user ID to prevent cross-user data leakage on shared tablets. Both modules have a `setUserId(userId)` method that **must** be called before any read/write operations. `setUserId` is called inside `fetchUser()` in `AuthProvider.tsx`. Stash cleanup (orphaned directories, legacy migration) must run **after** `setUserId` — never on a timer that could fire before `fetchUser` completes.

### 18. Upload URL validation is fail-closed

`validateUploadUrl()` in `sslPinning.ts` throws if `R2_BUCKET_HOSTNAME` is not configured (empty string). This means all uploads will fail in production if the EAS secret is missing. This is intentional — uploading recordings to an unvalidated URL is worse than failing.

### 19. Validate audio segment URIs before accepting them

`RESTORE_SESSION` and `REPLACE_ALL_SEGMENTS` in `useMultiPatientSession.ts` run `validateSegments()` which filters to only local `file://` or absolute `/` paths. This prevents corrupted stash data or a compromised audio editor bridge from injecting remote URLs that would exfiltrate audio during upload.

## Device Binding

The mobile app sends an `X-Device-Id` header on every API request. The device ID is a UUID v4 generated on first launch and persisted in SecureStore (survives sign-out — it's device-scoped, not user-scoped). The server's `validateDeviceSession` middleware requires this header and can revoke specific devices.

- `secureStorage.getDeviceId()` — generates and caches the device UUID
- `ApiClient.doFetch()` — caches the device ID in memory after first SecureStore read
- `AuthProvider.registerDevice()` — called on sign-in AND session restore to register with server
- Server returns `DEVICE_REVOKED` (401) — client forces sign-out with specific error message
- Server returns `DEVICE_ID_REQUIRED` (401) — client shows "restart or reinstall" message (Keystore failure)

## EAS Build Notes

- **Secrets:** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` are stored as EAS project-level secrets (not in `eas.json`)
- **Credentials:** Both preview and production profiles use `credentialsSource: "remote"` (managed by EAS)
- **Lock file:** Must stay in sync — run `npm install --legacy-peer-deps` before EAS builds if dependencies change. EAS uses `npm ci` which fails on mismatch. The `.npmrc` file sets `legacy-peer-deps=true` to handle the `@config-plugins/ffmpeg-kit-react-native` peer dep conflict with Expo SDK 55.
- **Secrets sync:** After changing `.env`, run `eas secret:push --scope project --env-file .env --force` to update EAS build secrets. A stale EAS secret will override the local `.env` in production builds.
- **Metro cache:** After changing `.env`, restart Metro with `npx expo start --clear`. Metro inlines `EXPO_PUBLIC_*` values at build time — a stale cache silently uses the old values. In dev mode, `config.ts` logs a warning if Supabase vars are empty.
- **FFmpeg Maven repo:** The `com.arthenica:ffmpeg-kit-min:6.0-2` Android artifact was removed from Maven Central. It's self-hosted via GitHub Pages at `https://homeless-pets-foundation.github.io/ffmpeg-kit-maven`. This is configured in `app.config.ts` via `extraMavenRepos` in `expo-build-properties`, which injects it at the Gradle settings level (required by Gradle 9).
- **Expo doctor:** Always run `npx expo-doctor` before triggering an EAS build. A pre-build Claude hook (`.claude/hooks/pre-eas-build.sh`) enforces this automatically. If Dependabot bumps packages beyond Expo SDK compatibility, run `npx expo install --fix` to restore correct versions.
- **APP_VARIANT:** `app.config.ts` exposes `extra.isProduction` based on `APP_VARIANT=production`. Used at runtime to gate production-only features (e.g., screen capture prevention, when re-enabled).

## Emulator Testing (WSL2)

The dev environment runs Metro in WSL2 while the Android emulator runs on the Windows host. All `adb` commands that target the emulator must use the **Windows** ADB binary (`adb.exe`), not the WSL2 `adb`.

### Setup & Launch

1. **Start the emulator:**
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/emulator/emulator.exe" -avd Medium_Phone_API_36.1 -no-snapshot-load &>/dev/null &
   ```
2. **Wait for the emulator to appear** (check with Windows ADB):
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" devices
   ```
3. **ADB reverse** (emulator localhost → Windows localhost):
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" reverse tcp:8081 tcp:8081
   ```
4. **Port proxy** (Windows localhost → WSL2 IP, requires admin):
   ```bash
   WSL_IP=$(ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
   powershell.exe -Command "Start-Process powershell -ArgumentList '-Command netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1; netsh interface portproxy add v4tov4 listenport=8081 listenaddress=127.0.0.1 connectport=8081 connectaddress=$WSL_IP' -Verb RunAs"
   ```
5. **Start Metro** (clean cache recommended after code changes):
   ```bash
   npx expo start --clear
   ```
6. **Deep-link the app** to connect to the dev server:
   ```bash
   "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" shell am start -a android.intent.action.VIEW -d 'captivet://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
   ```

If Metro was already running on port 8081, kill it first: `lsof -ti:8081 | xargs kill -9`

### ADB UI Interaction

Use these commands to interact with the emulator for testing. All use the Windows ADB binary.

| Action | Command |
|--------|---------|
| **Screenshot** | `adb.exe exec-out screencap -p > /tmp/screen.png` (then use Read tool to view) |
| **Tap** | `adb.exe shell input tap <x> <y>` (coordinates in device pixels, 1080x2400) |
| **Swipe/Scroll** | `adb.exe shell input swipe <x1> <y1> <x2> <y2> <duration_ms>` |
| **Type text** | `adb.exe shell input text "hello"` (no spaces — use `%s` for spaces) |
| **Press back** | `adb.exe shell input keyevent KEYCODE_BACK` |
| **Dismiss keyboard** | `adb.exe shell input keyevent KEYCODE_ESCAPE` |
| **UI hierarchy** | `adb.exe shell uiautomator dump /sdcard/ui.xml && adb.exe shell cat /sdcard/ui.xml` |

### Finding Tap Coordinates

1. **Preferred: `uiautomator dump`** — returns XML with `bounds="[left,top][right,bottom]"` for every element. Calculate center: `x = (left + right) / 2`, `y = (top + bottom) / 2`. Filter with `grep -iE "button_text\|content_desc"`.
2. **Fallback: screenshot** — if `uiautomator dump` fails (it can't dump during animations), take a screenshot, view it with the Read tool, and estimate coordinates. The screen is 1080x2400 pixels.

### Key App Flows for Testing

- **Record:** Home → Record tab or "Record Appointment" → fill Patient Name, Client Name, select Species + Appointment Type → scroll down → tap "Start recording" → wait → "Finish"
- **Stash:** While recording or stopped → "Save for Later" (top right) → "SAVE" in dialog → session appears under "Saved Sessions" with "Resume Session" button
- **Edit:** After recording completes → scroll to "Edit Recording" → opens audio editor with waveform, trim handles, playback, and "Apply Trim" / "Done"
- **App package:** `com.captivet.mobile`, launch with: `adb.exe shell am start -n com.captivet.mobile/.MainActivity`

## File Conventions

- `src/lib/secureStorage.ts` — sole interface to `expo-secure-store`. All calls wrapped in try/catch. Also provides `getDeviceId()` which generates a persistent UUID v4 on first call (cached in memory after first read). The `DEVICE_ID` key is NOT deleted in `clearAll()` — it's device-scoped, not user-scoped.
- `src/lib/biometrics.ts` — sole interface to `expo-local-authentication` + biometric SecureStore preference. All calls wrapped in try/catch.
- `src/lib/fileOps.ts` — safe wrappers around `expo-file-system` `File`/`Directory` classes. All operations wrapped in try/catch. Use `safeDeleteFile`/`safeDeleteDirectory` instead of calling `.delete()` directly. Never import from `expo-file-system/legacy` in new code.
- `src/lib/secureClipboard.ts` — clipboard with 30-second auto-clear for sensitive data. Exports `clearClipboard()` for sign-out cleanup.
- `src/lib/audioEditorBridge.ts` — module-level singleton bridging `record.tsx` and `audio-editor.tsx`. Exports `clear()` for sign-out cleanup.
- `src/lib/stashStorage.ts` — encrypted stash metadata in SecureStore, chunked for Android 2KB limit. **User-scoped**: keys prefixed with user ID. Must call `setUserId()` before any operations. Includes `clearLegacyGlobalStashes()` for one-time migration.
- `src/lib/stashAudioManager.ts` — manages stashed audio files in `documentDirectory`. **User-scoped**: directories under `stashed-audio/{userId}/`. Must call `setUserId()` before any operations. Session IDs validated against path traversal.
- `src/config.ts` — env var access with graceful fallback. Exports `CONFIG_MISSING` flag.
- `app/_layout.tsx` — gates entire app on `CONFIG_MISSING` before any providers mount. Root `ErrorBoundary` wraps entire component tree.
- `src/components/ui/Button.tsx` — shared button with haptic feedback, optional `icon` prop. `Haptics.impactAsync` has `.catch()`. No shadow on `ghost` variant. Every button press flows through this component.
- `src/hooks/useAudioRecorder.ts` — wraps expo-audio recording. Uses `audioSource: 'voice_recognition'` on Android for optimal speech capture. `stop()` swallows errors; `pause()`/`resume()` catch, cleanup, then rethrow. Exports `resetWithoutDelete()` (clears state without deleting audio file) and `reset()` (clears state and deletes file). Recorder auto-released on unmount.
- `src/hooks/useMultiPatientSession.ts` — `useReducer`-based multi-patient session state. Manages up to 10 `PatientSlot`s with `segments[]`, recorder binding, upload status, and `CONTINUE_RECORDING` action for multi-segment recording. `RESTORE_SESSION` and `REPLACE_ALL_SEGMENTS` validate segment URIs via `validateSegments()`.
- `src/types/multiPatient.ts` — type definitions: `PatientSlot`, `AudioSegment`, `SessionAction`, `SessionState`.
- `src/auth/AuthProvider.tsx` — `handleSignOut` awaits PHI cleanup before clearing state. Calls `setStashUserId()` in `fetchUser()`. Calls `registerDevice()` on both sign-in and session restore. Stash cleanup runs only after user ID is set.
- `src/api/client.ts` — sends `X-Device-Id` header on all requests. Caches device ID in memory. Handles `DEVICE_REVOKED` and `DEVICE_ID_REQUIRED` 401 codes before attempting token refresh.
- `src/api/recordings.ts` — `createWithFile()` for single-segment upload, `createWithSegments()` for multi-segment. Both validate via `getInfoAsync()`, enforce 250MB limit, 10-minute timeout.
- `src/components/AppLockGuard.tsx` — requires biometric on cold start (not just background resume). Defaults to `isLocked=true` with blank screen until biometric check completes, preventing brief PHI flash. Sign-out button available as escape hatch.
- `src/components/PatientSlotCard.tsx` — per-patient card with form fields, recording controls, and upload status. "Finish" button (not "Stop") with checkmark icon for ending recordings. "Delete & Start Over" is a de-emphasized text link.
- `src/components/PatientTabStrip.tsx` — horizontal scrollable tab strip for switching between patient slots. Shows status badges (recording, paused, stopped, uploaded).
- `src/components/SubmitPanel.tsx` — bottom panel with "Submit All" button. Visible when multiple slots have recordings ready to upload.

## Multi-Patient Recording Architecture

The recording screen (`app/(app)/record.tsx`) supports recording up to 10 patients in a single session. Each patient is a "slot" displayed as a horizontally-pageable card.

### Data Model

Defined in `src/types/multiPatient.ts`:

- **`AudioSegment`** — `{ uri: string; duration: number }`. A single continuous recording file.
- **`PatientSlot`** — one patient's full state: form data (`CreateRecording`), `audioState` (`idle` | `recording` | `paused` | `stopped`), `segments[]` (array of `AudioSegment`), upload lifecycle fields (`uploadStatus`, `uploadProgress`, `uploadError`, `serverRecordingId`).
- **`SessionState`** — `{ slots: PatientSlot[]; activeIndex: number; recorderBoundToSlotId: string | null }`.
- **`SessionAction`** — discriminated union of 12 action types dispatched to the session reducer.

Max 10 slots enforced in the `ADD_SLOT` reducer case.

### Recorder Ownership Model

There is a single `useAudioRecorder` instance shared across all patient slots. Only one slot can "own" the recorder at a time, tracked by `recorderBoundToSlotId` in `SessionState`.

- **`BIND_RECORDER`** — dispatched when starting a recording, sets `recorderBoundToSlotId`.
- **`UNBIND_RECORDER`** — dispatched after audio is captured (in the `recorder.state === 'stopped'` effect).
- **Pending-start queue** — if starting a new slot while another is recording/paused, the current slot is stopped first via `pendingStartSlotRef`. After the stop completes and audio is saved, the pending slot auto-starts via `startRecordingRef`.
- **Auto-pause on swipe** — when swiping away from a recording slot (`handleScrollEnd`), the recorder is paused. If pause fails (rethrown error), the recorder is stopped as fallback.
- **Consistency guard** — an effect watches `recorderBoundToSlotId` changes and forces any orphaned slot with `audioState: 'recording'` back to `stopped` (if it has segments) or `idle`.

### Multi-Segment Recording

Each slot maintains a `segments[]` array as the source of truth for recorded audio:

- **`SAVE_AUDIO`** — appends a new segment to the slot's `segments[]` and sums total duration.
- **`CONTINUE_RECORDING`** — resets the slot's `audioState` to `idle` so the user can record another segment. The recorder's `resetWithoutDelete()` clears hook state without deleting the previously-saved audio file.
- **Upload** — `uploadSlot()` calls `createWithFile()` for single-segment slots or `createWithSegments()` for multi-segment slots. `createWithSegments()` uploads each segment to its own presigned URL, then confirms with all segment keys.

### Concurrency Guards

Six refs in `record.tsx` prevent race conditions:

| Ref | Purpose |
|---|---|
| `audioCaptureDoneRef` | Prevents the `recorder.state === 'stopped'` effect from saving the same audio twice |
| `pendingStartSlotRef` | Queues the next slot to start recording after the current slot's stop completes |
| `startRecordingRef` | Holds a stable reference to `startRecordingForSlot` for use inside the effect (avoids stale closure) |
| `stoppingRef` (in hook) | Prevents double-invocation of `stop()` |
| `isScrollingRef` | Suppresses programmatic `scrollToIndex` during user-initiated swipes |
| `swipeChangeRef` | Prevents the `activeIndex` sync effect from re-scrolling after a swipe already moved the pager |

### Upload State Machine

Per-slot upload lifecycle: `pending` → `uploading` → `success` | `error`.

- **`uploadSlot(slot)`** — returns `string | null` (server recording ID or null on failure). Skips if already uploading or already succeeded.
- **Single submit** (`handleSubmitSingle`) — uploads one slot. If other slots still have unsaved recordings, stays on the record screen; otherwise resets session and navigates to the recording detail.
- **Submit all** (`handleSubmitAll`) — uploads all eligible slots **sequentially** (avoids network saturation). On full success, resets session and navigates to recordings list. On partial failure, shows alert and stays on screen.
- **Post-upload cleanup** — after successful upload, local audio files are deleted via `FileSystem.deleteAsync`.

### Navigation & Cleanup

- **`usePreventRemove`** — blocks navigation when `unsavedCount > 0` (slots with segments but not yet uploaded, or actively recording/paused). Shows discard confirmation with precise count.
- **Discard cleanup** — on confirm, iterates all slots and deletes all segment files via `FileSystem.deleteAsync`.
- **`resetSession`** — dispatches `RESET_SESSION` to the reducer, creating a fresh initial state. Required because the record tab stays mounted across navigations — without explicit reset, stale state persists.


<!-- TRIGGER.DEV basic START -->
# Trigger.dev Basic Tasks (v4)

**MUST use `@trigger.dev/sdk`, NEVER `client.defineJob`**

## Basic Task

```ts
import { task } from "@trigger.dev/sdk";

export const processData = task({
  id: "process-data",
  retry: {
    maxAttempts: 10,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  run: async (payload: { userId: string; data: any[] }) => {
    // Task logic - runs for long time, no timeouts
    console.log(`Processing ${payload.data.length} items for user ${payload.userId}`);
    return { processed: payload.data.length };
  },
});
```

## Schema Task (with validation)

```ts
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const validatedTask = schemaTask({
  id: "validated-task",
  schema: z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email(),
  }),
  run: async (payload) => {
    // Payload is automatically validated and typed
    return { message: `Hello ${payload.name}, age ${payload.age}` };
  },
});
```

## Triggering Tasks

### From Backend Code

```ts
import { tasks } from "@trigger.dev/sdk";
import type { processData } from "./trigger/tasks";

// Single trigger
const handle = await tasks.trigger<typeof processData>("process-data", {
  userId: "123",
  data: [{ id: 1 }, { id: 2 }],
});

// Batch trigger (up to 1,000 items, 3MB per payload)
const batchHandle = await tasks.batchTrigger<typeof processData>("process-data", [
  { payload: { userId: "123", data: [{ id: 1 }] } },
  { payload: { userId: "456", data: [{ id: 2 }] } },
]);
```

### Debounced Triggering

Consolidate multiple triggers into a single execution:

```ts
// Multiple rapid triggers with same key = single execution
await myTask.trigger(
  { userId: "123" },
  {
    debounce: {
      key: "user-123-update",  // Unique key for debounce group
      delay: "5s",              // Wait before executing
    },
  }
);

// Trailing mode: use payload from LAST trigger
await myTask.trigger(
  { data: "latest-value" },
  {
    debounce: {
      key: "trailing-example",
      delay: "10s",
      mode: "trailing",  // Default is "leading" (first payload)
    },
  }
);
```

**Debounce modes:**
- `leading` (default): Uses payload from first trigger, subsequent triggers only reschedule
- `trailing`: Uses payload from most recent trigger

### From Inside Tasks (with Result handling)

```ts
export const parentTask = task({
  id: "parent-task",
  run: async (payload) => {
    // Trigger and continue
    const handle = await childTask.trigger({ data: "value" });

    // Trigger and wait - returns Result object, NOT task output
    const result = await childTask.triggerAndWait({ data: "value" });
    if (result.ok) {
      console.log("Task output:", result.output); // Actual task return value
    } else {
      console.error("Task failed:", result.error);
    }

    // Quick unwrap (throws on error)
    const output = await childTask.triggerAndWait({ data: "value" }).unwrap();

    // Batch trigger and wait
    const results = await childTask.batchTriggerAndWait([
      { payload: { data: "item1" } },
      { payload: { data: "item2" } },
    ]);

    for (const run of results) {
      if (run.ok) {
        console.log("Success:", run.output);
      } else {
        console.log("Failed:", run.error);
      }
    }
  },
});

export const childTask = task({
  id: "child-task",
  run: async (payload: { data: string }) => {
    return { processed: payload.data };
  },
});
```

> Never wrap triggerAndWait or batchTriggerAndWait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Waits

```ts
import { task, wait } from "@trigger.dev/sdk";

export const taskWithWaits = task({
  id: "task-with-waits",
  run: async (payload) => {
    console.log("Starting task");

    // Wait for specific duration
    await wait.for({ seconds: 30 });
    await wait.for({ minutes: 5 });
    await wait.for({ hours: 1 });
    await wait.for({ days: 1 });

    // Wait until specific date
    await wait.until({ date: new Date("2024-12-25") });

    // Wait for token (from external system)
    await wait.forToken({
      token: "user-approval-token",
      timeoutInSeconds: 3600, // 1 hour timeout
    });

    console.log("All waits completed");
    return { status: "completed" };
  },
});
```

> Never wrap wait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Key Points

- **Result vs Output**: `triggerAndWait()` returns a `Result` object with `ok`, `output`, `error` properties - NOT the direct task output
- **Type safety**: Use `import type` for task references when triggering from backend
- **Waits > 5 seconds**: Automatically checkpointed, don't count toward compute usage
- **Debounce + idempotency**: Idempotency keys take precedence over debounce settings

## NEVER Use (v2 deprecated)

```ts
// BREAKS APPLICATION
client.defineJob({
  id: "job-id",
  run: async (payload, io) => {
    /* ... */
  },
});
```

Use SDK (`@trigger.dev/sdk`), check `result.ok` before accessing `result.output`

<!-- TRIGGER.DEV basic END -->
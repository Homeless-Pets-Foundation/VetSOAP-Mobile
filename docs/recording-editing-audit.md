# Recording & Editing Audit — Findings & Fix Checklist

Audit date: 2026-04-04  
Scope: `record.tsx`, `useAudioRecorder.ts`, `useMultiPatientSession.ts`, `audio-editor.tsx`, `useAudioPlayback.ts`, `ffmpeg.ts`, `recordings.ts`, `AuthProvider.tsx`, supporting libs.

---

## CRITICAL

- [x] **C1** `src/lib/ffmpeg.ts` `trimAudio()` — if `getAudioDuration()` throws after successful FFmpeg trim, output file is orphaned (storage leak). Lines 97–104.
- [x] **C2** `src/lib/ffmpeg.ts` `concatenateAudio()` — `finally` only cleans `listPath`; if `getAudioDuration()` throws, `outputUri` is orphaned. Lines 150–159.
- [x] **C3** `src/auth/AuthProvider.tsx` `onAuthStateChange` no-token path — calls `secureStorage.clearAll()` but skips `stashStorage.clearAllStashes()` + `stashAudioManager.deleteAllStashedAudio()`. PHI leakage on shared tablets. Lines 266–276.

## WARNING

- [x] **W1** `app/(app)/(tabs)/record.tsx` discard handler — deletes `slot.segments[*].uri` but misses `recorder.audioUri` (in-flight recording file). Lines 247–253.
- [x] **W2** `src/hooks/useAudioPlayback.ts` `loadSource()` — `ensurePlaybackMode()` is fire-and-forget; `player.replace()` races it. Lines 87–98. (Also fix 2 callsites in `audio-editor.tsx`.)
- [x] **W3** `src/hooks/useAudioPlayback.ts` `play()` — `ensurePlaybackMode()` failure silently swallowed. Lines 100–111.
- [x] **W4** `app/(app)/audio-editor.tsx` `handleDeleteSegment` — stale closure over `segments`; delete alert open + concurrent trim = wrong segment deleted. Lines ~341–382.
- [x] **W5** `src/lib/waveformCache.ts` `cacheKey()` — uses only filename (truncated to 80 chars) + size; two files with same name+size collide. Lines 10–16.
- [x] **W6** `src/api/recordings.ts` — `console.warn('[upload]', ...)` not gated by `__DEV__`. Lines 155, 252.

## INFO

- [x] **I1** `src/lib/ffmpeg.ts` line ~350 — `console.log` fallback message not gated by `__DEV__`. (Already gated — verified non-issue.)

---

## Verified Non-Issues

- `validateUploadUrl` in `recordings.ts`: both calls are INSIDE their try/catch blocks. ✓
- `handleRemove` + audio capture race: `recorder.reset()` cleans up file in both orderings. ✓
- All Haptics calls: all have `.catch(() => {})`. ✓
- All `console.error` calls: all gated behind `__DEV__`. ✓

---

## Fix Details

### C1 — `trimAudio()` cleanup on `getAudioDuration` failure (`src/lib/ffmpeg.ts`)
After the FFmpeg success check, wrap the output verification + duration query in a try/catch that cleans up `outputUri` before rethrowing.

### C2 — `concatenateAudio()` cleanup on `getAudioDuration` failure (`src/lib/ffmpeg.ts`)
After the FFmpeg success check inside the try block, wrap the output verification + duration query in a nested try/catch that cleans up `outputUri` before rethrowing (the outer `finally` keeps cleaning `listPath`).

### C3 — `onAuthStateChange` stash cleanup (`src/auth/AuthProvider.tsx`)
In the no-token branch (line 267), add await `Promise.all([stashStorage.clearAllStashes(), stashAudioManager.deleteAllStashedAudio()])` with retry and `.catch(() => {})`, plus `audioEditorBridge.clear()` and `clearClipboard()`.

### W1 — Discard missing `recorder.audioUri` (`app/(app)/(tabs)/record.tsx`)
Before `navigation.dispatch(data.action)`, add:
```typescript
if (recorder.audioUri) {
  safeDeleteFile(recorder.audioUri);
}
```

### W2 — `loadSource()` race (`src/hooks/useAudioPlayback.ts`)
Make `loadSource` async, await `ensurePlaybackMode()`, then `player.replace()`. Update callsites in `audio-editor.tsx` to add `.catch(() => {})`.

### W3 — `play()` silent failure (`src/hooks/useAudioPlayback.ts`)
Add `if (__DEV__) console.error(...)` in the `.catch()` so failures aren't completely silent.

### W4 — `handleDeleteSegment` stale closure (`app/(app)/audio-editor.tsx`)
Use `setSegments(latestSegments => ...)` functional update in the Alert confirm handler.

### W5 — `cacheKey()` collision (`src/lib/waveformCache.ts`)
Hash the full URI string instead of just the filename.

### W6 — `console.warn` in production (`src/api/recordings.ts`)
Wrap both `console.warn` calls with `if (__DEV__)`.

### I1 — Ungated `console.log` in ffmpeg.ts
Wrap with `if (__DEV__)`.

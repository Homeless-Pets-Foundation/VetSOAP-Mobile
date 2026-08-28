# React Native / Expo SDK Upgrade — Plan

**Status: UNEXECUTED AND UNVALIDATED.** Nothing in this document has been run. It is a route map written after Dependabot PR #184 was closed for attempting the jump blind. Treat every step as a hypothesis until it is performed on a branch.

Written 2026-08-28 against `main` at SDK 55 / RN 0.83.10.

## Why #184 was closed

Dependabot proposed `react-native` 0.83.10 → **0.87.0** inside a 36-package group. It failed `Typecheck` with 15 errors. Those errors were symptoms; three things were wrong underneath:

1. **RN 0.87 is out of band for Expo SDK 55.** `CLAUDE.md` already states the rule: "Dependabot bumps past SDK compat → `npx expo install --fix`". That command would have reverted 0.87.
2. **`react-native-worklets` 0.7.4 → 0.12.1**, paired with `react-native-reanimated` 4.2.1 → 4.6.0.
3. **`expo-audio` 55.0.16 → 55.0.17 breaks `patches/expo-audio+55.0.16.patch`.** patch-package matches the exact version, so `postinstall` silently stops applying it.

That third point generalises: **any** `expo-audio` bump breaks the patch, including a patch-level one inside SDK 55. As of 2026-08-28 the latest 55.x is `55.0.18` while we pin `~55.0.16`, so this is already live, not hypothetical.

## Published versions (verified 2026-08-28 via `npm view`)

| Package | Installed | Latest in SDK 55 | Notes |
|---|---|---|---|
| `expo` | `~55.0.28` | `55.0.30` | SDK 56 → `56.0.21`, SDK 57 → `57.0.18` |
| `expo-audio` | `~55.0.16` | `55.0.18` | patch pinned to `55.0.16`; 56.x line is `56.0.13` |
| `react-native` | `0.83.10` | — | 0.84.1 / 0.85.3 / 0.86.3 / 0.87.1 published |
| `react-native-reanimated` | `4.2.1` | — | #184 proposed 4.6.0 |
| `react-native-worklets` | `0.7.4` | — | #184 proposed 0.12.1 |

**The SDK → RN mapping is not resolvable statically.** `expo`'s `peerDependencies.react-native` is `*` for every SDK major, so it tells you nothing. The only authority is running `npx expo install --fix` on a branch and reading what it picks. Do not copy a version number out of this table into `package.json`.

## Decide the target first

Two genuinely different projects, and they should not be conflated:

**Option A — stay on SDK 55, take the safe patches.** `expo` → `55.0.30`, the `expo-*` patch-level bumps, and non-native packages (Sentry, Supabase, TanStack). RN stays at `0.83.10`. Still requires regenerating the `expo-audio` patch if that package moves. Small, low risk, recovers most of what #184 offered.

**Option B — move to SDK 56 or 57.** A real migration. Everything below applies.

Option A is the recommended starting point, and it is worth doing regardless — it is a prerequisite for B and independently useful.

## Migration surface (Option B)

Ordered by what blocks what.

### 1. Resolve the target versions

```bash
npx expo install --fix
npx expo-doctor
```

`expo-doctor` runs before every EAS build anyway (`.claude/hooks/pre-eas-build.sh`). Its output defines the RN version — record it, and stop if it disagrees with the intended SDK.

### 2. Regenerate both patches

| Patch | Fences | What it does |
|---|---|---|
| `patches/expo-audio+55.0.16.patch` | `tests/legacy-android-recorder-latency.test.mjs` | Parallelizes foreground-service binding with `mediaRecorder.prepare()` via `coroutineScope { async { … } }`; reorders binder assignment so the parallel `await` cannot race a null binder; enables constant-bitrate seeking for durable ADTS AAC |
| `patches/ffmpeg-kit-react-native+6.0.2.patch` | — | Overrides the AAR from `6.0-2` → `6.0-3` in the package's `gradle.properties` |

Both are filename-pinned to exact versions. Renaming without re-deriving the diff means `postinstall` silently no-ops.

The `expo-audio` patch also requires `"expo": { "autolinking": { "android": { "buildFromSource": ["expo-audio"] } } }` in `package.json`, so the patched Kotlin compiles from source rather than a prebuilt AAR. Verify that survives.

**Check upstream first.** These patches exist because upstream lacked the fixes; a newer `expo-audio` may already carry them, in which case the patch should be dropped rather than forward-ported. Read the upstream changelog before re-deriving a diff.

### 3. Rebuild the two local native modules

Both ship committed platform source and are not covered by `expo prebuild`:

- `modules/captivet-audio-focus/` — Android Kotlin `AudioManager` focus listener; iOS is a deliberate no-op stub
- `modules/captivet-durable-recorder/` — native PCM→AAC-LC capture appending ADTS frames; the whole "never lose a recording" guarantee

Expo Modules API changes between SDK majors are the main risk. `npm run ci:swift` typechecks the durable recorder's five Swift files; there is no equivalent Kotlin gate, so Android needs a real build.

### 4. FFmpeg

- **Android:** self-hosted Maven at `homeless-pets-foundation.github.io/ffmpeg-kit-maven`, currently `6.0-3` (16KB page size), wired via `extraMavenRepos` in `app.config.ts`.
- **iOS:** `plugins/with-ffmpeg-ios-pod-source.js` injects a `:podspec =>` URL because the trunk podspec 404s. Rebuilding the xcframework needs an Apple Silicon Mac.

Gradle or CocoaPods changes across an SDK major can break either. Neither is exercised by CI — both need a real build.

### 5. Expect the #184 typecheck errors

15 errors, already catalogued, in three families:

- `Module '"react-native"' has no exported member 'InteractionManager'` — `record.tsx`, `audio-editor.tsx`
- ScrollView/View ref retyping — `PatientTabStrip.tsx`, `recordings/[id].tsx`, `WaveformEditor.tsx`
- `TextInput` ref typing — `src/components/ui/Text.tsx`, `login.tsx`

`ui/Text.tsx` is the sensitive one: it is the single file allowed to import `Text`/`TextInput` from `react-native`, and `font-scaling-guard` fences that. Fix the types without weakening the guard.

### 6. Device testing — not optional

`npm run ci` cannot validate this. Required on real hardware:

- Durable recording across process death, plus crash recovery
- Audio focus interruption (call / alarm / other voice app) on Android
- Recorder start latency — the `expo-audio` patch exists to keep it low; `measurePhase` warns above `NATIVE_RECORDER_PHASE_WARNING_MS` (1000 ms)
- Playback seeking on durable ADTS AAC files
- iOS via the Mac mini

The emulator cannot cover the upload path (`hasSilentAudioOnly()` rejects emulator mic input before any API call).

## Sequencing

1. Option A on its own branch — take the SDK-55-safe bumps, regenerate the `expo-audio` patch if it moves, get CI green. Ship it.
2. Only then attempt Option B, on a separate branch, one concern at a time: resolve versions → patches → native modules → FFmpeg → typecheck → device test.
3. Bump the marketing version in `package.json` **and** `package-lock.json` before any store build (`app.config.ts` reads `MARKETING_VERSION` from `package.json` and carries no literal semver).

Do not let a dependency bot drive either step. #184 is what that looks like.

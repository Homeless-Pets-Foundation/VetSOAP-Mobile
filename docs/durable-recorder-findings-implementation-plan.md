# Durable Recorder Audit — Implementation Plan (2026-07-02)

Source: `docs/findings-from-audit.md` (build + on-device test, 2026-07-01, branch
`durable-recorder-verified` / PR #126). This plan turns the audit's recommendations
into concrete, code-verified work items. Every root cause below was re-verified
against the current tree before writing.

Repos:
- Mobile: `/home/philgood/Projects/VetSOAP-Mobile` (branch `durable-recorder-verified`, PR #126 OPEN/MERGEABLE)
- Connect (backend): `/home/philgood/Projects/VetSOAP-Connect` (branch `main`)

---

## Summary of work items

| ID | Item | Severity | Repo | Ready? |
|----|------|----------|------|--------|
| R1 | Commit the F1 + F3 Swift fixes | P1 | Mobile | ✅ ready now |
| R2 | F2 — fix durable-AAC server rejection | P1 (blocker) | Connect (primary) / Mobile (alt) | ⚠️ decision needed |
| R3 | CI prevention — native was never compiled | P2 | Mobile | ready to spec |
| R4 | O6 — sign-out unsent-count warning | P3 | Mobile | ⚠️ needs repro first |
| R5 | Delete 2 throwaway test-org rows | ops | Connect | manual |
| R6 | Physical-device end-to-end verification | P1 gate | — | after R2 |

Recommended sequence: **R1 → R2 → R6 → R3 → R4 → R5** (R5 anytime).

### Execution status (2026-07-02)

- **R1 — DONE.** F1+F3 committed as `5d719d0` on `durable-recorder-verified`, pushed;
  `@codex review` requested on PR #126.
- **R2 — DONE (server fix, per owner decision), pending review + deploy.** Connect
  `isLikelyAudio` now accepts ADTS AAC (`0xFF F1/F9/F0/F8`); extracted to
  `apps/jobs/src/utils/audio-format.ts` with a vitest (green). Landed as Connect
  **PR #378** (`fix/durable-adts-aac-validation`), `@codex review` requested.
  **Not yet deployed** — needs `trigger deploy` of the jobs app.
- **R3 — specced below, not yet implemented.**
- **R4 — under investigation** (owner chose "investigate now").
- **R5 — pending** (manual Connect cleanup).
- **R6 — pending R2 deploy** (physical-device end-to-end).

---

## R1 — Commit F1 + F3 (iOS build + crash fixes) — READY NOW

**Status:** Both fixes are already in the working tree, uncommitted:
- `modules/captivet-durable-recorder/ios/AdtsWriter.swift`
- `modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift`

**Verification done this session:**
- **F1 (compile):** `AdtsWriter.swift` header build now computes each multi-term byte
  as an `Int` before narrowing to `UInt8` (fixes Xcode-26 "unable to type-check in
  reasonable time"); the two `AVAudioCompressedBuffer` sites changed from
  `guard let` to plain `let` (initializer is non-failable in the current SDK). The
  diff is a faithful, value-preserving refactor — the ADTS header bytes are
  unchanged. No test change needed.
- **F3 (crash):** `DurableRecorderEngine.installTapAndStartEngine()` now guards
  `tapFormat.sampleRate > 0 && channelCount > 0` and throws a **catchable** Swift
  error instead of letting `installTap(onBus:)` raise an uncaught NSException.
- **F3 fallback is correctly wired (verified):** `src/hooks/useAudioRecorder.ts:646`
  catches any durable-start failure → emits `durable_recorder_unavailable` → falls
  through to the expo-audio path (`:671 prepareToRecordAsync()`). On a simulator
  (no mic) expo-audio also fails, so the observed graceful "Recording Error" dialog
  is expected; on a real device with a live mic route the guard never trips and
  durable proceeds. This satisfies crash-prevention Rule 6.

**Action:** Commit both files to `durable-recorder-verified` (PR #126). These are
genuine defects — without them the iOS target does not build and crashes on start —
and they are independent of the throwaway test override (already reverted).

Suggested commit:
```
fix(durable): iOS build + start-crash fixes (F1/F3 from device test)

F1: AdtsWriter header — compute each multi-term byte as Int before UInt8 narrowing
    (Xcode 26 type-check timeout); AVAudioCompressedBuffer is non-failable, drop guard let.
F2 -> F3: DurableRecorderEngine.installTapAndStartEngine guards for a valid input
    format and throws a catchable error instead of an uncaught NSException, so JS
    falls back to expo-audio (Rule 6) instead of killing the app.

Never compiled in CI (EAS cloud iOS billing-gated) so these shipped undetected — see R3.
```

**Why this is safe to commit now:** it only affects the iOS durable native path,
which is server-flag-gated OFF in prod. Worst case with the fix is graceful fallback
to the existing expo-audio recorder.

---

## R2 — F2: server rejects durable AAC as "invalid audio format" — THE BLOCKER

### Root cause (verified directly, two independent audits agree)

Raw ADTS AAC is rejected by a **pure-JS magic-byte check** in the Trigger.dev
processing job — not ffprobe, not ffmpeg, not Deepgram:

- Throw site: `apps/jobs/src/jobs/process-recording.ts:872-877`
  `if (!isLikelyAudio(audioBuffer)) throw new PipelineError('File does not appear to be a valid audio file — invalid format detected', 'INVALID_AUDIO')`
- Validator: `isLikelyAudio()` at `process-recording.ts:131-153`
- Allowlist: `AUDIO_MAGIC_BYTES` at `process-recording.ts:120-129`

The allowlist has MP3 sync words `0xFF 0xFB / 0xF3 / 0xF2`, RIFF/WAV, fLaC, OggS,
WebM, and an MP4/M4A `ftyp`-at-offset-4 special case — but **no ADTS AAC sync
word**. A raw ADTS AAC frame starts `0xFF 0xF1` (MPEG-4, no CRC) or `0xFF 0xF9`
(MPEG-2, no CRC), so `isLikelyAudio` returns `false`. Legacy `.m4a` passes because
it has a `ftyp` box; raw `.aac` does not. Confirmed the emitted bytes:
- Durable module writes raw ADTS AAC (`audio.aac`): iOS `AdtsWriter.swift:134-169`
  prepends a 7-byte ADTS header per access unit; Android `AdtsWriter.kt:42-70` same.
  No MP4 container (deliberate — ADTS is append-only / byte-recoverable after a
  crash; that is the durability guarantee).
- Client uploads it honestly: `record.tsx:2001-2006`
  `createWithFile(..., 'audio/aac', { fileName: 'recording.aac' })`. So this is
  **not** a MIME-labeling bug; the container bytes are the issue.

Downstream is fine once past the gate: `mimeFromKey('aac')` already maps to
`audio/aac` (`process-recording.ts:94-108`), the presign allowlist already accepts
`audio/aac` + `audio/x-aac` (`apps/api/src/routes/recordings.ts:598-611`), and
Deepgram accepts raw ADTS AAC (`packages/services/src/deepgram/client.ts:126-153`).
**The magic-byte gate is the only blocker.**

> Note: the multi-segment path re-muxes segments into MP4 server-side
> (`process-recording.ts:762-808`, ffmpeg `-c copy` → `audio/mp4`), so it likely
> already passes the gate. The failure is specific to the **single-file raw `.aac`**
> durable upload — consistent with the on-device observation.

### Option A (RECOMMENDED) — server magic-byte fix

Add ADTS sync words to `AUDIO_MAGIC_BYTES` in
`apps/jobs/src/jobs/process-recording.ts` (after line 128):
```js
{ bytes: [0xff, 0xf1], offset: 0, mime: 'audio/aac' }, // ADTS AAC (MPEG-4, no CRC)
{ bytes: [0xff, 0xf9], offset: 0, mime: 'audio/aac' }, // ADTS AAC (MPEG-2, no CRC)
// optional, rare CRC-present variants:
// { bytes: [0xff, 0xf0], offset: 0, mime: 'audio/aac' },
// { bytes: [0xff, 0xf8], offset: 0, mime: 'audio/aac' },
```
- **Test (required — none exists today):** `isLikelyAudio` is module-local and
  untested. Export it (or `AUDIO_MAGIC_BYTES`) and add
  `apps/jobs/src/jobs/process-recording-audio-validation.test.ts` asserting: a
  buffer beginning `FF F1 …` (≥12 bytes) → `true`; `FF F9 …` → `true`; random /
  text bytes → `false`; existing `.m4a` `ftyp` and MP3 cases still `true`
  (regression guard).
- **Deploy:** the jobs app deploys via `trigger deploy --native-build-server`
  (`apps/jobs/package.json:7`, guarded by `scripts/guard-trigger-deploy.mjs`) —
  **separate** from the Railway API auto-deploy. Both prod + any staging Trigger.dev
  environment must be redeployed for the fix to take effect.
- **Pros:** ~2 lines + a test, one file, no mobile release; fixes a genuine latent
  server bug (a valid audio format was being rejected) and unblocks raw ADTS from
  *any* client. Keeps the durable on-disk format as append-friendly ADTS.
- **Cons:** a 2-byte sync check is loose (could match other `0xFFFx` MPEG streams) —
  but this is identical to how MP3 is already validated here, and corrupt audio
  still fails later at Deepgram / empty-transcript checks. Requires a Trigger.dev
  deploy.

### Option B (ALTERNATIVE) — client remux ADTS → M4A at submit

Add `remuxAdtsToM4a(inputUri, outputUri)` to `src/lib/ffmpeg.ts` (mirror
`trimAudio`, `ffmpeg.ts:248`: same validation + hard timeout + cleanup-on-failure),
running `ffmpeg -i audio.aac -c copy -movflags +faststart -y out.m4a` (pure
demux/remux, no re-encode). Hook it in `app/(app)/(tabs)/record.tsx` **after** the
complete-frame prefix truncation (`record.tsx:~1963-1980`) and **before**
`createWithFile` (`record.tsx:2001`); upload the `.m4a` as `audio/x-m4a` /
`recording.m4a` (the proven-accepted legacy format). Extend the existing `finally`
(`record.tsx:2037-2041`) to delete the extra temp.
- **Pros:** no server change or deploy; produces the container the pipeline already
  accepts; ffmpeg-kit is already shipped; the source `audio.aac` + manifest are
  never touched, so crash-durability is preserved.
- **Cons:** adds submit-time CPU/latency + a new failure mode on weak hardware
  (needs a timeout + graceful fallback); requires a mobile native/JS release; does
  not help any other client; and is **redundant with Option A** — if the server
  accepts ADTS, remuxing is unnecessary.
- Rejected sub-option: relabeling MIME/extension only does **not** work — the bytes
  on disk are genuinely raw ADTS; the container must change, not the label.

### Recommendation

**Do Option A (server fix).** Rationale: it is the smaller, correct fix for what is
fundamentally a server validation bug; durable capture is server-flag-gated OFF in
prod today (the `x-durable-capture-enabled` header is emitted **nowhere** in
Connect), so a Connect change is required to ship durable *regardless* — bundle the
`isLikelyAudio` fix with that enablement work. Keep Option B documented as a fallback
if a Trigger.dev deploy is undesirable or if belt-and-suspenders client robustness is
wanted later. **Do not do both for the durable path** (mutually redundant).

**This item is a hard gate:** durable end-to-end cannot pass until R2 lands AND R6
confirms it on a physical device with a real-length clip.

---

## R3 — CI prevention: native code was never compiled

**Root cause of F1 + F3 shipping undetected:** CI (`.github/workflows/ci.yml`) runs
only JS **Typecheck / Lint / Test**. There is no Swift or Kotlin compile step, and
all `tests/durable-*.test.mjs` exercise JS logic (ADTS parser, manifest, recovery),
never the native module. EAS cloud iOS builds are billing-gated, so iOS native had
literally never compiled in CI — a P1 compile error (F1) and a P1 runtime crash (F3)
both reached the branch clean.

**Plan:**
1. **Add a macOS CI job that typechecks the Swift durable module.** GitHub's free
   `macos-*` runners ship Xcode, so `xcrun swiftc -typecheck` catches **F1-class**
   compile errors with no EAS billing. **Verified feasible for the exact files that
   failed:** F1 was in `AdtsWriter.swift` (imports only `Foundation`) and
   `DurableRecorderEngine.swift` (`Foundation` + `AVFoundation` — both system
   frameworks on the runner). Only `CaptivetDurableRecorderModule.swift` imports
   `ExpoModulesCore` (needs pod headers), so typecheck the ExpoModulesCore-free set
   together — e.g.
   `xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios15.0-simulator modules/captivet-durable-recorder/ios/{AdtsWriter,DurableManifest,DurablePaths,DurableRecorderEngine}.swift`
   (adjust the file set / target after a first green run; a per-file typecheck fails
   on cross-file symbol refs, so pass the interdependent files together). Scope the
   job to `modules/captivet-durable-recorder/**` changes. **Validate the exact
   invocation on a macOS runner / the Mac mini before committing the workflow** — it
   can't be tested from WSL, so land it only once it runs green (avoid a red CI job).
2. **Kotlin:** add a Gradle compile of the Android module (or fold it into an
   existing Android job) to catch the equivalent on that side.
3. **Caveat — compile ≠ runtime:** a Swift typecheck would **not** have caught F3
   (a runtime NSException). The mitigation there is the format-validity guard already
   added in R1 plus the Rule-6 JS fallback; call this out so no one assumes the CI
   job covers crashes.
4. **Optional:** if iOS EAS billing is enabled, add a periodic (nightly / pre-merge
   on native-touching PRs) `preview-simulator` build as a fuller smoke gate.

This is the highest-leverage prevention item — it closes the class of defect that
this whole exercise surfaced.

---

## R4 — O6: sign-out unsent-work warning — REPRO FIRST, the premise is inverted

**Correction to the finding's framing (verified):** the profile-loaded Settings
sign-out path **already** computes `countUnsentRecordings()` and shows an "Unsent
Recordings" alert with the count when count > 0
(`app/(app)/(tabs)/settings.tsx:206-232`). The generic "Are you sure?"
(`showStandardSignOutPrompt`, `settings.tsx:194-204`) only fires when the count came
back **0** or the promise rejected. So the observed Android symptom means
`countUnsentRecordings()` **returned 0 while a stash was present** — this is a
count/scope bug, **not** an alert-wiring bug.

`countUnsentRecordings()` (`src/lib/localRecordings.ts:10`) sums:
- drafts with local audio (`draftHasLocalAudio(meta) === true`), and
- stashes with `!s.resumedAt` (un-resumed only),
and returns 0 for either half if the user scope isn't set.

**Likely explanations to check, in order:**
1. The present stash had `resumedAt` set (a resumed-then-not-re-stashed session) →
   excluded **by design**; its draft would count instead. This may be *correct*
   behavior, not a bug.
2. The unsent item was a **draft without local audio** → excluded.
3. User-scope timing at Settings mount (unlikely — Settings renders only after
   `fetchUser()` set the scope, `AuthProvider.tsx:731-732`).

**Plan:** reproduce with a known-unsent stash and log what `countUnsentRecordings()`
returns and why (which half is 0). Only then decide:
- if it's a real miss → fix the count/scoping (e.g. include resumed-but-unsubmitted
  work, or fix scope), add a `localRecordings` unit test; or
- if it's expected (resumed stash) → no code change; document the semantics.

Separate, minor: the no-profile path (`app/(app)/_layout.tsx:51-64`, "Sign Out
Without Profile?") structurally omits the count, but on that screen `user` is null so
the count would be 0 anyway (scope unset). Not worth changing unless (1) is a real
bug. **Lowest priority (P3).**

If a fix is wanted, the async-count-then-Alert pattern to mirror is
`app/(app)/delete-account.tsx:79-115` (build the Alert inside `.then()`, interpolate
the count via a `strings.ts` helper, `.catch()` proceeds without blocking).

---

## R5 — Delete throwaway test-org rows (manual ops)

Delete in Connect (the app has no in-app delete for these states):
- "Untitled visit — Jul 1, 7:28 PM" (Failed)
- "Untitled visit — Jul 1, 7:36 PM" (Not Submitted)

Note for the record: the #112 reprocess test regenerated **Mango's** SOAP (a
pre-existing recording, intentionally not deleted). Requires Connect UI / DB access
(owner or tester).

---

## R6 — Physical-device end-to-end verification (gate for durable)

The audit could not fully close durable end-to-end because emulator/sim have no
usable mic (clips were 256–768 ms; "too short" can't be 100% excluded) and R2 was
unfixed. **After R2 lands + deploys**, on a physical device:
1. Real-mic durable record of a real-length clip → Finish → Submit (promote-in-place).
2. Confirm a **single** server row, status advances past validation (no INVALID_AUDIO),
   transcript + SOAP generate from real audio.
3. Confirm the crash-recovery path with a real clip: mid-record process-death →
   relaunch → DurableRecoveryBanner → Resume → Submit → single row.

Only after R6 passes should the durable feature be considered end-to-end verified.

---

## Open decisions for the owner

1. **R2 approach:** server magic-byte fix (Option A, recommended) vs client remux
   (Option B) vs both. Spans two repos + a Trigger.dev deploy.
2. **R1:** commit the F1 + F3 Swift fixes to PR #126 now? (recommended: yes)
3. **R4 priority:** investigate the O6 count-returned-0 repro now, or defer?

Bottom line

Both builds were produced and driven on-device against the empoweredpets@gmail.com test org (role Veterinarian). The client-side durable path is solid, but the exercise surfaced three real, previously-hidden PR #126 defects — two of which I fixed locally (and one verified on-device), and one server-side gap that needs a physical device to fully close. iOS native had never compiled in CI (EAS cloud iOS is billing-gated), so these shipped undetected.

Builds

┌─────────────┬───────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────┐
│  Platform   │                      Profile                      │                                        Result                                        │
├─────────────┼───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
│ Android APK │ production-apk --local (WSL, remote EAS keystore) │ ✅ 177 MB, installed + ran on emulator                                               │
├─────────────┼───────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────┤
│ iOS sim     │ preview-simulator --local (Mac mini)              │ ❌ first build failed to compile → fixed (F1) → ✅ rebuilt, ran on iPhone 17 Pro sim │
└─────────────┴───────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘

Findings

F1 — iOS durable recorder didn't compile (P1) — FIXED locally
Three Swift errors blocked the entire iOS build (exit 65):
- modules/captivet-durable-recorder/ios/AdtsWriter.swift:144 — UInt8(<multi-term bitwise-OR>) → "unable to type-check in reasonable time" (Xcode 26). Fixed: compute each byte as an Int first.
- DurableRecorderEngine.swift:962 & :999 — guard let compressed = AVAudioCompressedBuffer(...) — that initializer is non-failable in the current iOS SDK. Fixed: plain let.

F3 — iOS durable start crashes the app (P1) — FIXED + VERIFIED on-device
DurableRecorderEngine.installTapAndStartEngine() calls installTapOnBus with an invalid format (sampleRate 0 / 0 channels — any time there's no active mic route) → uncaught NSException that kills the whole app, bypassing the JS wantDurable fallback (violates crash-prevention Rule 6). 100% reproducible on the sim. Fixed with a format-validity guard that throws a catchable error → JS falls back to expo-audio. Verified: after the fix, Start recording no longer crashes (pid unchanged) — it shows a graceful "Recording Error" dialog instead.

F2 — server rejects durable AAC as "invalid audio format" (P1/P2) — needs physical-device confirmation
Durable submit (promote-in-place, audio/aac) reaches the server but the row goes Failed: "File does not appear to be a valid audio file — invalid format detected." The uploaded file is a valid AAC-LC ADTS (I pulled it: ffprobe clean, FF F1 sync, ffmpeg decodes). Control: reprocessing a legacy Completed recording (Mango) succeeded end-to-end → the server pipeline works for valid audio, so this is specific to the raw-ADTS-AAC durable format — the deployed Connect backend accepts the audio/aac MIME at presign but its transcode/validate step appears not to accept raw ADTS. Caveat: the emulator's audio-focus kept clips to 256–768 ms, so I can't 100% exclude "too short" — a real device is needed to fully attribute (the plan already flagged full server path = physical device). This blocks the durable recorder's end-to-end path on the current backend and is the most important thing to chase next.

Verified PASS

- Durable client (Android): on-disk audio.aac+manifest.json; audio-focus interruption caught (captivet-audio-focus module); kill -9 → recording survives → recovered on relaunch (via session-restore); promote-in-place = single row (no duplicate) + local durable purge on success.
- Core: email/pw sign-in + device auto-register; draft-save-on-finish ("Not Submitted" amber); stash round-trip (rule 20); sign-out preserves drafts/stashes and they reappear on re-sign-in (rule 8); cross-device draft visibility ("Not on this device").
- Recent PRs: #112 reprocess [FULL, fired + completed], #120 Consult AI, #116 record-first, #108 Inter/UI polish. No crashes; loading states always resolved.

Not testable here (with reason)

- #105 playback scrub — audio is author/admin-gated ("Only the recording author or an admin can play this audio"); this Vet account authored none with valid audio. (Player UI + the access-control both verified.)
- #115 subscription — owner-role-gated, not reachable as Veterinarian.
- #113 provider banner — clean org → empty state (expected).
- Real transcript/SOAP + durable ADTS runtime bytes — emulator/sim have no usable mic. Needs a physical device.

One more observation (verify)

O6: Android's normal sign-out shows a generic "Are you sure?" with no unsent-work count, despite an unsent stash present (Rule 13 says countUnsentRecordings() should warn). iOS does warn — but only via the "Sign Out Without Profile?" path when /auth/me hasn't loaded.

Teardown state

- ✅ Override reverted — git status shows only the two intended Swift fixes (AdtsWriter.swift, DurableRecorderEngine.swift) + the untracked plan doc. HEAD unchanged (54ae5b5).
- ✅ Override-baked binaries deleted (APK, iOS tarball/extracted, Mac .env.local); both override apps uninstalled.
- ⚠️ The F1 + F3 Swift fixes are uncommitted, kept for your review — they're genuine bugs (iOS won't build/run without them), separate from the throwaway override. Want me to commit them to the branch?
- ⚠️ Two throwaway test-org rows to delete via Connect (the app has no in-app delete): Untitled visit — Jul 1, 7:28 PM (Failed) and Jul 1, 7:36 PM (Not Submitted). Also note: my #112 test regenerated Mango's SOAP (a pre-existing recording, not deleted).

Recommended next steps

1. F2 is the blocker — either teach the Connect backend to accept raw ADTS AAC (transcode/validate), or have the durable recorder emit a container the pipeline already accepts; then confirm on a physical device with a real-length clip.
2. Commit F1 + F3 (say the word and I will), so the branch actually builds + doesn't crash on iOS.
3. Decide on O6 (unsent-work sign-out warning).
4. Delete the 2 test-org rows in Connect.

Reusable driver scripts are saved (android-drive.sh, ios-drive.sh) for one-command re-runs. Full evidence + screenshots are in the session scratchpad (FINDINGS.md).
# Android Device Acceptance Test Plan — VetSOAP Mobile

**Repo:** VetSOAP-Mobile (Expo SDK 55 / RN 0.83 / React 19)
**Date:** 2026-05-29
**Branch under test:** `main` @ merge of PR #72 (commit `b403be2` — preserve-recordings + screenshots) on top of 1.12.5
**Target:** one physical **Android phone** via **wireless debugging**; this PC drives it over Wi-Fi.
**Build type:** signed **APK** (`production-apk` EAS profile) so real uploads work.

This supersedes `docs/plans/2026-05-29-device-test-plan-local-recordings.md` (same setup, narrower scope). Run **Part A** (full smoke) first to confirm the build is healthy, then the targeted feature parts **B–E**.

> **Scope note (2026-08-07):** Parts B–E are the 2026-05-29 session's feature scope and are **historical**. **Part A + §3.4 are the reusable pass** — run them against any build. §3.4 and A13 were added 2026-08-07 (PR #171 follow-up) and are not tied to that session.

> **All `adb` calls use the Windows ADB binary** (Metro runs in WSL2, phone is a Windows-side device). Set once:
> ```bash
> ADB="/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe"
> ```

---

## 0. Why a physical device (read first)

- **Emulator cannot exercise upload.** `hasSilentAudioOnly()` samples `peakMetering`; emulator mic peaks ≤ −20 dBFS → every Submit throws *"This recording appears silent"* **before** the API call. Upload / draft-promote / "uploaded-confirmed eviction" paths are testable **only** on a real device with a real mic.
- **Screen-capture, screen-off recording, biometrics, and Keystore edge cases** also only behave correctly on real hardware.
- **Emulators cannot reproduce the text-clip class.** They run `fontWeightAdjustment=0` / `fontScale=1.0`. With the OS **Bold text** setting on, Android paints glyphs wider than Yoga measured them and the trailing word of a tight label is laid out out of view with **no ellipsis** (CLAUDE.md → *UI Gotchas*; PR #171 / `8388c69`). Only a physical device with Bold text **ON** catches it — see §3.4.

---

## 1. Build the APK

Marketing version is already bumped (1.12.5 on main). Build a signed APK:

```bash
npx expo-doctor                       # must be clean before any EAS build
npx --yes eas-cli@latest build --platform android --profile production-apk --non-interactive
```

`production-apk` produces an **APK** (not the AAB that `production` builds). Download the artifact when the build finishes and install it:

```bash
"$ADB" install -r /path/to/app-release.apk
```

> Optional faster iteration: a dev-client build + Metro (`npx expo start --clear`) lets you watch breadcrumb logs and hot-reload, but **uploads still need the signed APK or a real backend session**. Use the APK for the acceptance pass.

---

## 2. Connect over wireless debugging

### 2.1 Phone (one time)
1. Settings → About phone → tap **Build number** ×7 → Developer options unlocked.
2. Developer options → enable **Wireless debugging**.
3. Phone + this PC on the **same Wi-Fi** (or PC hotspot).

### 2.2 Pair + connect
1. Phone: Wireless debugging → **Pair device with pairing code** → note `IP:PORT` + 6-digit code.
   ```bash
   "$ADB" pair <PAIR_IP>:<PAIR_PORT>     # then enter the 6-digit code
   ```
2. Phone: Wireless debugging main screen → note the **IP:PORT** (different from the pairing port).
   ```bash
   "$ADB" connect <IP>:<PORT>
   "$ADB" devices                         # expect: <IP>:<PORT>   device
   ```
3. (Dev-client only) tunnel Metro to the phone — works over wireless once connected:
   ```bash
   "$ADB" reverse tcp:8081 tcp:8081
   ```

Launch the app:
```bash
"$ADB" shell am start -n com.captivet.mobile/.MainActivity
```

### 2.3 ADB UI helpers (assume 1080×2400 — adjust to device)
| Action | Command |
|---|---|
| Screenshot | `"$ADB" exec-out screencap -p > /tmp/screen.png` (view via Read) |
| Tap | `"$ADB" shell input tap <x> <y>` |
| Swipe | `"$ADB" shell input swipe <x1> <y1> <x2> <y2> <ms>` |
| Type | `"$ADB" shell input text "Buddy"` (use `%s` for spaces) |
| Dismiss keyboard | `"$ADB" shell input keyevent 66` (ENTER) |
| UI dump | `"$ADB" shell uiautomator dump /sdcard/ui.xml && "$ADB" shell cat /sdcard/ui.xml` |
| Force-stop | `"$ADB" shell am force-stop com.captivet.mobile` |

**Avoid** `KEYCODE_ESCAPE` (111) + `KEYCODE_MENU` (82) — they open the Expo element inspector and steal taps.

### 2.4 Watch logs (PHI-safe)
`console.error` is `__DEV__`-gated, but breadcrumbs are observable:
```bash
"$ADB" logcat | grep -iE "captivet|\[Auth\]|\[record\]|evict|orphan|recovery|transient"
```

---

## 3. Test data prep

### 3.1 Accounts (Supabase project `shdzitupjltfyembqowp`)
- **User A** and **User B** — two normal accounts (vet/owner role). Confirm both sign in before cross-user tests.
- **User S** — a `support_staff` account (for Part E). If unavailable, skip Part E and note it.

### 3.2 Aging a recording past 30 days (eviction tests, no source edit)
Eviction thresholds are hardcoded (`maxAgeDays: 30`, `warnAgeDays: 23`).
- **Preferred — clock jump.** Create the draft/stash, then:
  ```bash
  "$ADB" shell settings put global auto_time 0
  # advance the phone date +31 days via the Settings UI (most reliable)
  ```
  Cold-launch → the Record-tab mount runs the sweep against the future clock. **Restore after:**
  ```bash
  "$ADB" shell settings put global auto_time 1
  ```
  ⚠️ A clock jump can expire the Supabase token → involuntary `SIGNED_OUT`. That's fine (co-tests B2); re-auth and the draft/stash must still be there.
- **Alternative — dev override.** Ask me to add a `__DEV__`-only `maxAgeDays/warnAgeDays` override to the two `evictExpired(...)` call sites in `record.tsx`, test with `0/0`, then revert + re-run `tsc`/`lint`.

### 3.3 Forcing involuntary logout
Clock-jump past token expiry (3.2), **or** revoke this device from another client (Manage Devices → `DEVICE_REVOKED`), **or** toggle airplane mode during a token-refresh window.

### 3.4 Accessibility state (clip-bug lever — set BEFORE Part A)
Android **Bold text** (`Configuration.fontWeightAdjustment=300`) is the reproduction lever for the trailing-word clip class. **Record the original value first**, set it, and leave it on for the whole pass:
```bash
"$ADB" shell settings get secure font_weight_adjustment   # RECORD THIS — 0 = off, 300 = Bold text ON
"$ADB" shell settings put secure font_weight_adjustment 300
"$ADB" shell settings get system font_scale               # informational; this test device runs 1.15
```
**A force-stop is mandatory after changing it** — RN keeps stale one-line heights across a `Configuration` change, so the app must be restarted to re-measure:
```bash
"$ADB" shell am force-stop com.captivet.mobile
"$ADB" shell am start -n com.captivet.mobile/.MainActivity
```
If the adb write doesn't take, toggle **Settings → Accessibility → Display size and text → Bold text** in the UI instead. Restore in Teardown (§5).

---

## Part A — Full app functional smoke
*Confirm the build is healthy. Mark P/F.*

### A1. Launch & config
- [ ] Cold launch → no crash; lands on sign-in or Home (not blank / `CONFIG_MISSING`).
- [ ] `logcat` shows no module-load throw.

### A2. Auth
- [ ] Email/password sign-in succeeds (User A).
- [ ] Sign out → immediately sign in again → succeeds (no `AuthRetryableFetchError` loop).
- [ ] Session restore: kill app (not sign out) → relaunch → still signed in.
- [ ] Biometric: Settings → enable → background+foreground → biometric prompt → unlock (no PHI flash).
- [ ] Cold-start lock: kill + relaunch with biometric on → blank/locked until biometric, then content.
- [ ] MFA (if enrolled): challenge works; wrong code → safe message (no raw server text).
- [ ] Google sign-in (if configured) succeeds.

### A3. Device binding
- [ ] Fresh install → first API call auto-registers device (428 → register → retry; not fatal).
- [ ] Settings → Manage Devices lists this device as **phone** (label "Android"/phone — not "iPad"/tablet).
- [ ] Revoke this device from another client → app force-signs-out with a clear message.

### A4. Recording — single patient
- [ ] Fill Patient Name, Client Name, Species, Appointment Type → Start → timer runs → speak → Finish.
- [ ] Finish → draft auto-saved → **"Not Submitted"** (amber) on Home/Records.
- [ ] Submit → upload overlay → success → SOAP generates → amber card gone.

### A5. Recording — multi-segment
- [ ] Finish → "Continue Recording" → record again → segments accumulate, total duration sums.
- [ ] Submit → multi-segment upload confirms → success.

### A6. Recording — multi-patient
- [ ] Add 2–3 slots (tab strip), record each.
- [ ] Swipe between slots auto-pauses the active recording (no crash; status badges update).
- [ ] **Submit All** → sequential uploads → all succeed → nav to list.
- [ ] Partial-fail: toggle airplane mid-run → alert + stay, no data loss.

### A7. Screen-off / background recording *(codex fix on main)*
- [ ] Start recording → lock the screen (power button) → wait ~30s → unlock → recording still running, duration advanced, audio intact through Finish.
- [ ] Persistent foreground-service notification shows while recording.

### A8. Edit
- [ ] Edit Recording → waveform renders, trim handles move, playback works, Apply Trim → audio updates.

### A9. Stash / resume
- [ ] Save for Later → SAVE → under **Saved Sessions** with **Resume Session**.
- [ ] Resume → form + audio restored, submittable.
- [ ] Resume → Submit → promotes existing server draft (**no duplicate** recording on list/server).

### A10. Draft resume
- [ ] Tap "Not Submitted" card → reopens Record with form + audio preloaded → Submit promotes in place.

### A11. Offline / reconnect
- [ ] Finish a draft offline → stays `pendingSync` → reconnect → server draft created (`syncPending`).

### A12. Navigation guard
- [ ] With unsaved segments, try to leave Record → discard-confirm with correct unsaved count → Cancel keeps data.

### A13. UI integrity *(physical device, Bold text ON — invisible on emulator/iOS)*
**Precondition:** `"$ADB" shell settings get secure font_weight_adjustment` returns `300`, and the app was force-stopped and relaunched since (§3.4).
- [ ] Login screen subtitle reads **"Sign in to your account"** in full — not "Sign in to your".
- [ ] Settings → Manage Devices capacity row reads **"N remaining"** / **"Approaching limit"** / **"Limit reached"** in full — not a bare number. Force each branch if the account count allows.
- [ ] Stepper labels, "Copy"/"Copy All" buttons, upload-overlay caption, status badges, Clinic Quality alerts, and Attention Feed date badges render **full words** (no "Cop", "Transcribin", no missing trailing word).
- [ ] For any suspect label, dump before filing: `"$ADB" shell uiautomator dump /sdcard/ui.xml && "$ADB" shell cat /sdcard/ui.xml`. If the node carries the **complete** string at ample `bounds` width while the screen shows less, it is the bold-text clip bug — not a typo, not flex shrink.
- [ ] Confirm with the A/B before filing: `"$ADB" shell settings put secure font_weight_adjustment 0`, force-stop, relaunch → renders in full ⇒ confirmed. Set it back to `300` (force-stop again).
- [ ] A visible ellipsis (`"Co…"`) is the **backstop working**, not a pass — file it as missing headroom on that label.

---

## Part B — Recordings survive logout *(this session's #1 feature)*

### B1. Explicit Sign Out preserves recordings
1. User A: record a draft (don't submit) **and** stash a second session.
2. Settings → Sign Out:
   - [ ] **Pre-logout Alert** "Unsent Recordings — You have **2** recordings…" with **Cancel / Review / Sign Out**.
   - [ ] Exactly **one** warning haptic (no double-pulse). *(Greptile P2 fix)*
   - [ ] **Cancel** → stays signed in, nothing deleted.
   - [ ] **Review** → goes to Record tab, does **not** sign out.
   - [ ] **Sign Out** → signs out.
3. Sign back in as A:
   - [ ] Draft still present (amber); stash still under Saved Sessions, resumable.
4. Submit the draft → SOAP generates → local draft removed.

### B2. Involuntary logout (expiry/revoke) preserves recordings
1. User A: record a draft, don't submit.
2. Force involuntary logout (§3.3).
   - [ ] App returns to sign-in **without** wiping local data. `logcat`: `transient_caches_cleanup`, **no** draft/stash delete.
3. Relaunch + sign in as A:
   - [ ] Draft present; recovery-intent survived (auto-resume or draft listed, not orphaned).
4. Submit → success.

### B3. Guard shows zero when nothing un-sent
1. User A with no drafts/stashes (submit/clear everything).
2. Sign Out:
   - [ ] Plain "Are you sure you want to sign out?" (no unsent-count Alert), one haptic, Sign Out works.

### B4. Cross-user isolation (shared-tablet safety)
1. User A: leave a draft + a stash, Sign Out (preserve).
2. Sign in as **User B**:
   - [ ] B sees **none** of A's drafts/stashes (Home, Records, Saved Sessions clean).
3. Sign out B, sign back in as A:
   - [ ] A's draft + stash reappear.

### B5. Regression — transient caches still cleared on logout
1. Generate scratch: open audio editor (peak cache), copy text (clipboard), create temp files.
2. Sign Out:
   - [ ] Clipboard cleared, editor bridge cleared, peak cache + audio temp dirs cleaned (`logcat: transient_caches_cleanup`).
   - [ ] Drafts/stashes/recovery-intent **untouched**.

---

## Part C — 30-day eviction (warn-first, never silent) *(this session's #4 feature)*

### C1. Un-sent draft → warn-first
1. User A: un-sent draft with audio segments.
2. Age >30 days (§3.2), cold-launch → Record tab.
   - [ ] **Alert "Recordings Expiring"** with count + **Keep for now / Delete**.
   - [ ] **Keep for now** → nothing deleted.
   - [ ] Re-trigger → **Delete** → local audio + metadata removed; if `serverDraftId` set, server row deleted; Records refreshes.
   - [ ] At **23–29 days**: **no** Alert; dev build logs `approaching 30-day expiry`.

### C2. Un-sent stash → warn-first
1. User A: stash, don't resume. Age >30 days, cold-launch Record tab.
   - [ ] Stash counted in the Alert; **Delete** removes entry + audio dir.
   - [ ] A **resumed** stash (resume one first) is **excluded** from eviction.

### C3. Uploaded-confirmed draft → silent *(physical device required)*
1. Draft pointing at a `serverDraftId` whose server status is uploaded/completed, aged >30 days.
2. Cold-launch Record tab:
   - [ ] Local copy deleted **silently** (no Alert); server row untouched (still in Records).

### C4. Offline defer
1. Aged draft **with** `serverDraftId` (status unverifiable offline).
2. Airplane on → cold-launch Record tab:
   - [ ] **Not** silently deleted (uploaded-confirm branch skipped). Un-sent drafts with no `serverDraftId` still classify in the warn Alert.

### C5. Per-user sweep on a shared tablet *(Greptile P1 fix)*
1. User A: aged un-sent draft. Cold-launch → Alert fires for A (don't sign out the app/kill it).
2. **Without killing the app**, Sign Out A → sign in as **User B** who also has an aged un-sent draft.
   - [ ] B's eviction Alert **also fires** (sweep re-runs per user, not once per app launch).

### C6. Pre-sign-out count ignores zombie drafts *(Greptile P2 fix)*
1. Create a draft, then delete its on-disk audio segments (or use one whose audio was cleaned), leaving metadata only.
2. Settings → Sign Out:
   - [ ] That audio-less draft is **not** counted in the "Unsent Recordings" warning (only drafts with real audio on disk count).

---

## Part D — Screenshots enabled *(this session's #2 feature)*

Screen-capture prevention (`FLAG_SECURE`) was **removed**. On this APK:

### D1. In-app screenshot
- [ ] On any screen (Home, Record, a recording detail) press **Power + Volume-Down** → screenshot **succeeds** (saved to Photos), no "Can't take screenshot / blocked by app or org" toast.
- [ ] Or via ADB: `"$ADB" exec-out screencap -p > /tmp/shot.png` → Read it → shows real app content (not black).

### D2. Recents / task-switcher preview
- [ ] Open Recents (square/gesture) → the VetSOAP card shows a **live preview** of the screen (not a blank/blurred secure placeholder).

### D3. Screen recording (optional)
- [ ] Start the system screen recorder on an app screen → playback shows real content, not black frames.

---

## Part E — Support-staff recovery vault *(codex feature now on main)*
*Skip + note if no `support_staff` account.*

### E1. Support-staff sign-out preserves to vault
1. Sign in as **User S** (`support_staff`); create a recording/draft on this device.
2. Settings → Sign Out:
   - [ ] Prompt **"Recover Recordings First?"** naming the count, with **Stay Signed In / Save & Sign Out** (distinct from the normal-user "Unsent Recordings" prompt).
   - [ ] **Save & Sign Out** → sign-out completes after the recovery copy is saved.
3. Sign in as an **owner/admin/veterinarian** on the **same device**:
   - [ ] The recovered recording(s) are accessible to them.

### E2. Required-mode save failure blocks sign-out safely
1. As User S, simulate a save failure if feasible (e.g. fill local storage), required-mode sign-out:
   - [ ] **"Recovery Save Failed"** Alert with **Stay Signed In / Retry / Sign Out & Delete**.
   - [ ] **Stay Signed In** keeps the session + data; **Sign Out & Delete** confirms a second time before destructive sign-out.

---

## 4. Pass criteria
- All **Part B/C/D** boxes pass — these are the changes shipped this session.
- Part E passes (or is explicitly skipped for lack of a `support_staff` account).
- No new crash in `logcat`; no module-load throw.
- **No cross-user leak** (B4); **nothing un-sent is ever deleted without an explicit user tap** (C1/C2/C4/C5).

## 5. Teardown
- Restore phone clock: `"$ADB" shell settings put global auto_time 1`.
- Restore Bold text to the value recorded in §3.4: `"$ADB" shell settings put secure font_weight_adjustment <original>` — **or** deliberately leave it at `300` if this device is the standing clip-regression device, and say which in the results.
- If a dev eviction override was added, **revert it** and re-run `npx tsc --noEmit` + `npx expo lint`.
- `"$ADB" disconnect` when done.

## 6. Notes / limits
- Emulator is **not** a substitute for A4/A5/A6/A7/**A13**/C3 (upload, screen-off, and text-clip paths) — physical device only.
- Static gates already green on `main`: `tsc --noEmit` exit 0, `expo lint` 0 problems, `node --test` 58/58.
- CI on `main`: CodeQL ✅, Dependency Review ✅, Greptile ✅ (0 open findings).
- Server-side "what happened to this recording": query `client_telemetry` by `recording_id` (see CLAUDE.md → Monitoring).

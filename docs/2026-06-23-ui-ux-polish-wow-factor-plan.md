# Mobile UI/UX Polish — "Wow Factor" Plan

## Context

VetSOAP Mobile already has a **strong design foundation**: semantic color tokens with full
light/dark mode (`global.css`, `tailwind.config.js`), brand teal, a SOAP color system, an 8-step
type scale, spring press-states on `Button`/`IconButton`/`ListItem`, ~20 haptic touchpoints, a
skeleton system, and a genuinely polished audio-editor (gesture-driven trim/zoom/scrub on the UI
thread — the crown jewel).

What it lacks is **emotional peak moments**. Three Explore passes (design-system, core screens,
motion) converged on the same verdict:
- The **recording state** — the app's hero moment — is *functional but flat*: small muted waveform,
  plain timer, no glow/energy on the active slot.
- **Completion** (SOAP ready, all-uploaded) is *silent*: just a status-badge color flip. No
  celebration of the user's work.
- The app uses the **system default font** (`expo-font` installed but unused) — the single biggest
  "generic vs premium" tell.
- **Consistency gaps**: form controls lack press feedback, `IconButton`/`Banner` CTAs lack
  haptics/shadow, some components bypass radius tokens, screen transitions are default, empty states
  are barren.

Goal: a **full sweep** that lifts perceived quality from ~6.5/10 to premium, focused first on the
hero/celebration peaks, then breadth. User approved new deps: **custom font**, **expo-linear-gradient**,
and a **celebration burst** (built dep-free with reanimated — see Phase 2).

**Crash-rule guardrails (CLAUDE.md):** font loading must not throw or block render (rules 1, 24);
every new haptic/animation callback stays `() => void` with `.catch(() => {})` (rules 2, 4); gradient
is a JS-safe Expo dep. Build-time font embed avoids any runtime-load splash risk.

---

## Phase 1 — Foundation: custom font + design tokens

Single highest-leverage change. Embed the font at **build time** via the expo-font config plugin
(synchronous, no runtime `useFonts`, no splash-gate change, no throw — satisfies rules 1/24).

1. **Bundle font** — add a variable/static family to `assets/fonts/` (recommend **Inter** or
   **Geist**: Regular/Medium/SemiBold/Bold `.ttf`). Free, neutral, excellent at small sizes for
   clinical density.
2. **Embed via plugin** — `app.config.ts`: add `['expo-font', { fonts: [...] }]` to `plugins`, listing
   **explicit** `.ttf` paths (the plugin does not expand globs), e.g.
   `['./assets/fonts/Inter-Regular.ttf', './assets/fonts/Inter-Medium.ttf', ...]` — or a single
   `Inter-Variable.ttf` on the variable path. Build-time embed → family available synchronously, no JS load.
3. **Wire tokens** — `tailwind.config.js` `fontFamily`: `sans: ['Inter', 'system-ui']` (one family;
   weights come from `font-medium`/`font-semibold` with a variable font). Add per-weight family tokens
   (`medium`, `semibold`) **only** on the static-`.ttf` path — see step 4. Keep the system font in the
   fallback stack so an old dev-client pre-embed degrades gracefully.
4. **Apply (global default)** — RN `<Text>` does **not** inherit `fontFamily` from a parent `View`/
   `ScrollView`, and the app renders raw `<Text>` everywhere, so setting `font-sans` on
   `ScreenContainer` will **not** cascade. Establish the family as the app-wide default instead, one of:
   (a) override `Text.defaultProps.style` once in `app/_layout.tsx` — smallest diff, but React 19
   deprecates function-component `defaultProps`; RN's host `Text` still honors it in 0.83, so **verify
   on device** before relying on it; or (b) a thin `AppText` wrapper (or set `font-sans` on the
   shared text-style helpers) — more diff, but React-19-safe. If (a) doesn't take, fall back to (b).
   **Use a variable font** (single `.ttf`) so the existing `font-medium`/`font-semibold`/
   `font-bold` classes keep working via `fontWeight`. If shipping static per-weight `.ttf`s instead,
   RN/Android won't synthesize weights — map each weight to its family token
   (`medium: ['Inter-Medium']`, etc.) and use those classes; bare `font-semibold` would render Regular.
5. **Token top-ups** (`tailwind.config.js`):
   - Add one `shadow-glow` token (brand-colored, e.g. `0 0 16px rgba(13,135,117,0.35)`) — powers the
     hero waveform / active slot / CTA. RN 0.83 supports the `boxShadow` style on both platforms, same
     as the existing `shadow-card`/`shadow-btn` boxShadow tokens. Skip an elevation scale (YAGNI — add
     a `shadow-lg` only if a specific surface later needs plain elevation).
   - `soap.subjective/objective/assessment/plan` tokens already exist **and are already used** as the
     section swatch `colorClass` in `SoapNoteView.tsx:23-26` (`bg-soap-*`) — Phase 3 extends that to
     left-border + bg-tint; no new tokens needed.

**Files:** `app.config.ts`, `tailwind.config.js`, `assets/fonts/` (new), `app/_layout.tsx`
(default-font mechanism, option a above).

---

## Phase 2 — Hero moment + celebration (the wow peaks)

### 2a. Active-recording "alive" state
Make the recording slot feel like it's capturing energy. All reanimated (installed), no new dep.
- **Bigger, glowing waveform** — `AudioWaveform.tsx`: raise height from the current `isWide ? 56 : 40`
  to ~80px phone / 120px tablet, add `shadow-glow`, add a slow **breathing outer ring**
  (`withRepeat` scale+opacity) gated on the existing `isActive && !isPaused` props (no `state` prop
  exists — drive from these).
- **Active slot emphasis** — `PatientSlotCard.tsx`: colored left border + subtle `shadow-glow` +
  ~1.02 scale when the card owns the recorder. Use the existing `isRecorderOwner` prop for "this is
  the hot slot"; distinguish red=recording vs amber=paused from `slot.audioState`
  (`'recording'`/`'paused'`). (`recorderBoundToSlotId` lives in parent session state, not on the card.)
- **Live timer presence** — `RecorderLiveReadout.tsx`: use `timer` type token, bold, faint glow while live.
- **Bigger status badge** — `StatusBadge.tsx`: bump the in-progress/recording badge size + add a soft
  glow on the pulsing dot so state reads at a glance (it's caption-sized today).
- **Haptic heartbeat** — light `impactAsync` every ~10s during live capture (interval cleared on
  pause/stop; wrapped `.catch(() => {})`, rule 4). Reuses the existing 250ms readout poll.

**Files:** `AudioWaveform.tsx`, `PatientSlotCard.tsx`, `RecorderLiveReadout.tsx`, `StatusBadge.tsx`.

### 2b. Completion celebration
When a recording reaches `completed` (SOAP ready) and when **all** slots finish uploading:
- New `src/components/CelebrationBurst.tsx` — ~50-line reanimated particle burst (SVG circles
  animated outward with `withTiming`+fade). **ponytail: built dep-free; swap in
  react-native-confetti-cannon only if a physics cannon is wanted later.**
- Fire **once** when status reaches `'completed'` in `recordings/[id].tsx` — guard with a
  `usePrevious`/ref so it triggers only on the `prev !== 'completed' && next === 'completed'`
  transition, not every render/poll (the screen refetches via react-query; `status` settles to
  `'completed'` per `recordings/[id].tsx:111`). Same guard at the final step of `ProcessingStepper.tsx`.
  Burst + `notificationAsync(Success)` + a 2s success toast ("SOAP note ready!"). New lightweight
  `Toast` (reuse `toast.bg/fg` tokens already in config).
- Per-slot upload toast in `UploadOverlay.tsx`: "<Patient> uploaded" as each slot confirms; animate
  the upload icon (pulse) + thicken the progress bar to ~6px.

**Files:** `CelebrationBurst.tsx` (new), `Toast.tsx` (new), `recordings/[id].tsx`, `ProcessingStepper.tsx`, `UploadOverlay.tsx`.

### 2c. Hero CTA
`index.tsx` "Record Appointment" button → `expo-linear-gradient` + `shadow-glow` for premium depth,
keeping the existing press-scale. `LinearGradient` takes raw color **values**, not Tailwind classes,
so pull stops from `useThemeColors()` (dark-mode-aware, dodges the color guard): `colors.brand500 →
colors.brand600` (both exist in `constants/colors.ts`, light + dark). If a brighter pop is wanted,
add a `brandTealLight` (`#0bb89a`) key to both theme objects in `constants/colors.ts` first — it is
**not** currently exported by `useThemeColors`.

**Dep:** `npx expo install expo-linear-gradient` (autolinks — no `app.config.ts` plugin entry).
**Files:** `index.tsx` (+ `src/constants/colors.ts` only if adding the brighter stop).

---

## Phase 3 — Breadth polish

- **SOAP color-coding** — `SoapNoteView.tsx`: today each section header shows a small `bg-soap-*`
  swatch (`SECTIONS`, line 23-26). Extend that to a colored **left border + faint bg tint** on the
  whole section + a section icon. High readability win, reuses the tokens already wired.
- **Tab active indicator** — `(tabs)/_layout.tsx` uses the default expo-router `Tabs` (brand active
  tint + haptics already wired; no custom `tabBar`). A bottom-tab underline/pill has no built-in slot,
  so either (a) low-effort: animate the active icon via a custom `tabBarIcon` reading `focused`
  (scale/weight on the brand color — no structural change), or (b) higher-effort: a custom
  `tabBar={(props) => …}` to draw a sliding indicator. Default to (a).
- **Screen transitions** — root + `(app)` `Stack` `screenOptions`: explicit `animation: 'slide_from_right'`
  (and keep `audio-editor` `gestureEnabled: false`, rule unchanged). Near-free intentional feel.
- **Consistency fixes** (cheap, do as one sweep):
  - `IconButton.tsx`: add `shadow-btn` (non-ghost) + `selectionAsync` haptic.
  - `Banner.tsx` CTAs: press-scale + `impactAsync(Light)`.
  - `SegmentedControl.tsx` / `Select.tsx`: press-scale (0.98) matching `ListItem`.
  - `Sheet.tsx`: replace hardcoded `rounded-t-2xl` → `rounded-card rounded-b-none`; `Skeleton.tsx`
    radius → token.
- **Empty states** — two different surfaces: the recordings **list** uses the shared `EmptyState`
  component (`recordings/index.tsx:367,386`); **home**'s empty state is an inline `<Card>` with plain
  text (`index.tsx:366`, "No recordings yet…"), **not** `EmptyState`. Give both a larger brand icon +
  warmer copy ("Your patients are waiting — tap Record to start"); optionally refactor home's inline
  card to reuse `EmptyState` for consistency. Skip custom illustration assets for now (defer until a
  designer provides art; icon+copy gets 80% of the lift). Don't remove home's `Recent patient` /
  `Read more` strings (joy-phase5 guard).
- **List stagger** — the recordings list already staggers rows via `FadeInRight.delay(index * 50)`
  (`recordings/index.tsx:335`); extend the same pattern to home sections.

**Files:** `SoapNoteView.tsx`, `(tabs)/_layout.tsx`, `app/_layout.tsx`, `(app)/_layout.tsx`,
`IconButton.tsx`, `Banner.tsx`, `SegmentedControl.tsx`, `Select.tsx`, `Sheet.tsx`, `Skeleton.tsx`,
`EmptyState.tsx`, `app/(app)/(tabs)/index.tsx` (home inline empty state), `recordings/index.tsx`.

---

## Explicitly skipped (YAGNI / low ROI)

- Live FFT spectrum meter — complex, marginal over the existing metering-driven bars.
- Waveform auto-pan / predictive playhead smoothing — editor is already the strongest surface;
  diminishing returns.
- Accent/secondary brand color, 6-level shadow scale — brand teal + 2 added shadows suffice.
- Lottie / Skia — reanimated + svg cover every animation here.
- Confetti **library** — reanimated burst covers it (note above).
- Custom illustration assets — needs a designer; icon+copy interim.

---

## Reusable utilities (don't re-build)

- Spring preset (`damping:15, stiffness:300`) — copy from `Button.tsx` for new press-states.
- `useThemeColors()` (`src/hooks/useThemeColors.ts`) — for any runtime/animated colors.
- Haptics pattern — always `Haptics.*Async().catch(() => {})` (rule 4); see `Button.tsx`.
- `toast.bg/fg`, `soap.*`, `status.*` tokens already in `tailwind.config.js`/`global.css`.
- Reanimated entry primitives (`FadeInUp`, `ZoomIn`, `LinearTransition`) already used across components.

---

## Test guards to respect (read before coding)

Two existing `tests/` suites constrain this work — design to them, don't fight them:

- **`dark-mode-guard.test.mjs`** counts hardcoded-color patterns in `app/` + `src/components/` and
  asserts each stays **0**: `text-stone-`, `bg-white`, `color="#`, `placeholderTextColor="#`.
  Implication for every new component (CelebrationBurst, Toast, gradient CTA, glow, icons):
  - Lucide/icon colors → `color={colors.x}` from `useThemeColors()`, **never** `color="#..."`.
  - Backgrounds → `bg-surface`/`bg-surface-raised` semantic classes, **never** `bg-white` or `text-stone-`.
  - Define color *values* only in `tailwind.config.js`/`global.css` (`.js`/`.css` — not scanned), e.g.
    the `shadow-glow` rgba and any gradient stop tokens; reference them by class/token in `.tsx`.
    (Note: `colors={['#…']}` arrays and `shadowColor="#…"` don't match the patterns, but routing
    through tokens keeps dark mode correct anyway.)
- **`joy-phase5.test.mjs`** is structural — preserve these anchors while editing:
  - `ProcessingStepper.tsx` stays an extracted component using `PawPrint` + `PROCESSING_WARMTH`
    (don't inline it back into `recordings/[id].tsx`).
  - Home keeps the `Recent patient` + `Read more` strings; the empty-state copy change must not
    remove them.

## Verification

End-to-end on the **Android emulator** (CLAUDE.md WSL2 setup), then a physical device for the items
the emulator hides (font rendering, haptics, single-word text clipping — UI Gotchas):

1. `npx expo install expo-linear-gradient` + add font files; `npm install --legacy-peer-deps`;
   `npx expo-doctor`; `npx expo start --clear` (Metro must re-inline embedded font + tokens).
2. **Font** — confirm every screen renders in Inter, not system font; verify weights
   (semibold buttons, bold sheet titles). Check no missing-glyph boxes.
3. **Hero** — start a recording: waveform large + glowing, breathing ring animates, active slot
   border/glow, timer prominent, ~10s haptic pulse fires; pause stops the pulse and flips amber.
4. **Celebration** — drive a recording to `completed` (or stub the status): burst + success
   haptic + toast appear once, no double-fire, no jank.
5. **CTA** — home "Record Appointment" shows gradient + glow; press-scale intact.
6. **Breadth** — SOAP sections color-coded; tab indicator animates; screen push slides; press-scale
   on segmented/select/banner; sheet/skeleton radius correct; empty states updated.
7. **Crash-rule regression** — cold start with no font yet embedded (old dev-client) must still
   render (system fallback, no throw); kill network mid-record — haptic interval + animations must
   not leak or crash (rules 1/4/24). Run `npm test` (`node --test tests/`) — both guards in the
   "Test guards" section above must stay green; no behavior change expected elsewhere.
8. Physical Android: re-verify text isn't clipped on glowing/scaled labels (UI Gotchas — emulator + iOS hide this).

**No store-version bump** (CLAUDE.md) — this is not itself a release; bump marketing version only
when an actual store build is cut.

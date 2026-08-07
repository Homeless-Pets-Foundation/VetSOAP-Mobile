# Text Truncation Fix — Badge/Status Labels (2026-06-23)

> **Correction (2026-08-07) — the cause below is wrong. The fixes are right.**
>
> The trigger is the OS **Bold text** accessibility setting
> (`Configuration.fontWeightAdjustment=300`), not flex measurement. Yoga measures the
> `<Text>` with the unadjusted font and fixes its box from that; Android then paints
> every glyph wider, and the overrun falls outside the already-fixed box.
>
> The three symptoms in this document are all **single-token** labels ("Exported",
> "Dismissed", "Accepted"), which is the *glyph-clip* variant — a 1-token label has no
> space to wrap at, so it clips at the box edge rather than losing a whole word. The
> more dangerous *vanish* variant needs ≥2 tokens; there the trailing word is laid out
> out of view with no ellipsis at all.
>
> Every fix in this document still stands: `flexShrink: 0` + `paddingRight: 2` + a
> trailing space buy **measured-width headroom** so the bold overrun cannot reach the
> box edge. What does not stand is the causal story in `## Cause` ("under-measures a
> single-word `<Text>` in a `flex-row`") and the `numberOfLines={1}` warning — on a
> ≥2-token label `numberOfLines={1}` is now the recommended **backstop**, because it
> makes residual overrun ellipsize visibly instead of vanishing. On a 1-token label
> like these three, the warning still holds.
>
> Proven on a physical Pixel 10 Pro XL with an otherwise identical build: renders in
> full at `adb shell settings put secure font_weight_adjustment 0`, clips at `300`.
> `adb shell uiautomator dump` is decisive — the node carries the complete string at
> ample `bounds` width while only part paints. Canonical rule: CLAUDE.md →
> **UI Gotchas**. Fix: PR #171 / commit `8388c69`.
>
> (`src/components/ReviewStatusChip.tsx`, named in the Sites-changed table below, has
> since been deleted with the review-status contract — CLAUDE.md → File Conventions.)

## Symptom

Single-word labels clipped on last glyph in Android UI:

- "Exported" → "Exporte" (ExportSheet badge)
- "Dismissed" → "Dismisse" (Suggested Tasks status)
- "Accepted" → "Accepte" (Suggested Tasks status)

## Cause

**Superseded — read the Correction at the top of this file before this section.**

Classic Android render bug (see CLAUDE.md → "UI Gotchas"). Android `TextView`
under-measures a single-word `<Text>` inside a `flex-row` parent and clips the
last glyph — no ellipsis, no warning. Triggered when the Text has no
`flexShrink: 0` and competes for row space with a sibling that has `flex-1`
(or sits in a pill/badge next to an icon).

Not a typo — the full words are spelled correctly in source.

## Fix

Add `style={{ flexShrink: 0, paddingRight: 2 }}` to each affected `<Text>`:

- `flexShrink: 0` — stops the label being squeezed by the competing sibling.
- `paddingRight: 2` — glyph breathing room so the final character renders fully.

Inline comment added at each site (the fix looks like lint debris otherwise).

## Sites changed

| File | Line | Label | Why at risk |
|---|---|---|---|
| `src/components/SuggestedTasksCard.tsx` | 131 | "Accepted" / "Dismissed" | sits opposite `flex-1` title in a `flex-row` row |
| `src/components/ExportSheet.tsx` | 101 | "Exported" | pill badge w/ icon sibling, no flexShrink |
| `src/components/ReviewStatusChip.tsx` | 54 | "Reviewed" | `self-end` flex-row chip + `numberOfLines={1}` + icon sibling — the exact combo CLAUDE.md flags ("Co..." class) |

ReviewStatusChip was found by a codebase-wide sweep, not in the original
report — same bug class, would have clipped identically.

## Checked, no fix needed

- `src/components/PatientTabStrip.tsx` — status indicator is an icon (`StatusDot`),
  not text. Tab label truncation is intentional (`shrink max-w-[180px]
  numberOfLines={1} ellipsizeMode="tail"`) with a real ellipsis.

Codebase-wide scan covered all `*.tsx` in `src/` + `app/`. These 3 were the
only at-risk single-word labels.

## Verification

- `npx tsc --noEmit` — clean for all 3 edited files.
- Visual confirmation required on a **physical Android device** — iOS and the
  emulator hide this render class (per CLAUDE.md).

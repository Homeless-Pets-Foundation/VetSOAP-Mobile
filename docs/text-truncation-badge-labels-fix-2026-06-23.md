# Text Truncation Fix — Badge/Status Labels (2026-06-23)

## Symptom

Single-word labels clipped on last glyph in Android UI:

- "Exported" → "Exporte" (ExportSheet badge)
- "Dismissed" → "Dismisse" (Suggested Tasks status)
- "Accepted" → "Accepte" (Suggested Tasks status)

## Cause

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

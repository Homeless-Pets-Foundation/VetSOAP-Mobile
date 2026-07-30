# Fix Clinic Quality card: clipped alert text, meaningless labels, empty rows

Date: 2026-07-29

## Context

On the Home tab, the **Clinic Quality** card (`src/components/QualityAnalyticsCard.tsx`) renders three visible defects, reported from a physical Android phone:

1. **Orange text reads `Reprocesse` and `Missing`.** These are not typos. The source strings are the full words `'Reprocessed'` and `'Missing details'` (`src/constants/strings.ts:347,349`). `issueLabels()` (`src/components/QualityAnalyticsCard.tsx:60-66`) pushes the **bare metric name** as an "alert badge", and each badge renders as a standalone `<Text>` inside a `flex-row flex-wrap` parent with no width constraint (`:137-145`, the `<Text>` itself at `:140-142`). Android's TextView under-measures an unconstrained `Text` in a wrapping row and clips the overflow with no ellipsis — the documented failure class in CLAUDE.md → *UI Gotchas* ("flex-row labels without `flex-1` truncate silently"). `'Reprocessed'` loses its last glyph; `'Missing details'` is measured at first-word width and loses ` details`.

   The diagnosis is not inference — this component contains its own A/B. In the same `BreakdownRow`, the group label `<Text className="… flex-1 pr-2">` (`:118`) rendered `Unknown model` **complete** in the very screenshot where the badge `<Text>` beneath it clipped. Same file, same row, same Android TextView, same font; the only difference is `flex-1`. That is what makes the cure below a known quantity rather than a guess.

2. **The alert says nothing.** Even rendered in full, a naked orange `Missing details` carries no number and no framing. The breakdown row shows metric tiles for Avg length / Reprocessed / Edited notes / 90% done by — but **not** for missing details, so the badge is the only surface for `missingMetadataRate` and it omits the value. A prior fix (`880f274` "fix: prevent quality metric text clipping") addressed layout only, never the copy — it touched `QualityAnalyticsCard.tsx` and the test file, not `strings.ts`.

3. **`Unknown model — 0 rec` with `n/a` everywhere renders as a full row.** `'Unknown model'` does not exist anywhere in this repo — it is a server-supplied `quality.byModel[].label` (`src/api/qualityAnalytics.ts:31`, `label: z.string()`), rendered raw. There is **no client filter or sort** before `items.slice(0, 5)` (`src/components/QualityAnalyticsCard.tsx:163`), so all-zero groups occupy visible slots and real groups past index 4 are silently dropped. `hasActivity()` (`:49-58`) already exists but is only wired as the card-level empty-state gate (`:208-214`), never per row. Related: `gemini-3.5-flash` was flagged `Reprocessed 100%` off a sample of **one** recording.

Note that both breakdown sections (`byModel`, `byAppointmentType`) were added by `083a18b` "feat: show clinic quality breakdowns" **after** `docs/clinic-quality-analytics-dashboard-plan.md` was written, without a plan update — which is why no `byModel` label contract or empty-group behavior was ever specified.

Intended outcome: every word renders in full on a physical Android phone at max font scale, each alert states its number in plain language, and rows too small or too empty to mean anything don't render at all.

## Decisions (confirmed with the owner, 2026-07-29)

- Alert shape: one wrapping line, warning icon + plain sentence with the number.
- Breakdown rows (Models, Appointment types): hide groups under **5** completed recordings. This subsumes the all-zero case.
  - Consequence to be clear about: when **no** group in a list clears 5, the whole section disappears — header included, since `BreakdownSection` bails on the empty visible list. A small clinic with 30 recordings spread thinly across 8 appointment types loses the entire "Appointment types" section. That is the intended reading of "rows too small to mean anything don't render at all", and it beats the current behavior (eight meaningless rows); the alternative — keeping the header with a "not enough data yet" line — is deliberately **not** taken here, but it is a copy-only change if the owner wants it later.
  - Open, not resolved by this change: the card still shows only the top 5 groups and gives no signal that more exist. The filter makes the *hidden* set the small ones rather than an arbitrary slice, which is the improvement — but CLAUDE.md's Attention Feed precedent is explicit that truncation must not read as completeness. The subtitle "30-day clinic signals" makes no exhaustiveness claim, so nothing here is actively misleading; adding a "top 5 by volume" qualifier is a separate copy decision, out of scope.
  - Known residual, accepted: `completedRecordings >= 5` bounds the sample behind **`reprocessRate` only** — that is the one rate whose denominator is `completedRecordings` (`docs/clinic-quality-analytics-dashboard-plan.md:80`). `missingMetadataRate` divides by `nonDraftRecordingCountInWindow` (`:84`) and `soapEditRate` by `soapNoteCountInWindow` (`:82`), and **neither denominator is in the response contract**, so the client cannot bound their sample size. A 5-recording group can therefore still show "100% missing patient details" off one non-draft recording. Surfacing the denominators is a Connect-side ask (see Follow-up), not something this change can fix.
- Providers section: **keep** zero-activity providers. `docs/clinic-quality-analytics-dashboard-plan.md:88` states `byProvider` deliberately includes users with zero quality activity so an owner can see who hasn't recorded — that list's purpose is the opposite of the breakdowns'.
- Reprocess alert uses **counts, not percent**. `reprocessRate` legitimately exceeds 1 (`docs/clinic-quality-analytics-dashboard-plan.md:67`: multiple reprocesses can happen for one recording; `tests/quality-analytics.test.mjs:73` already fixtures `reprocessRate: 2` → renders "200%"). A sentence reading "200% reprocessed" looks broken. Missing details and edited notes stay percentages because both **are** bounded at 1 — but not by `completedRecordings`: each numerator is a subset of its own denominator population (`missingMetadataCount` ⊆ non-draft non-replaced recordings, `soapEditedCount` ⊆ SOAP notes in window; definitions at `:81-84`). `reprocessCount` counts `audit_logs` reprocess *actions* (`:79`), which is why it alone is unbounded relative to its denominator. Note the schema does not enforce any of this: `QualityRateSchema` is `z.number().nonnegative().nullable()` (`src/api/qualityAnalytics.ts:4`), so the bound is a contract property, not a validated one.
  - **Open item this decision does not cover, and should:** the same `reprocessRate` still renders as a raw percentage in the **`Reprocessed` metric tile** — in `SummaryBlock` (`src/components/QualityAnalyticsCard.tsx:91`) and in `BreakdownRow` (`:130`), both via `formatRate`. So after this fix ships, a summary block can read `Reprocessed / 200%` while a breakdown alert below it reads `Reprocessed 6 times across 5 recordings`. `tests/quality-analytics.test.mjs:73` already fixtures the 200% case on `me` — i.e. the **You** block. If "200% reprocessed looks broken" in a sentence, it looks broken in a tile too. Two candidate resolutions, both cheap — swap the tile to the raw `reprocessCount` (relabel `Reprocesses`), or keep the rate and clamp the display — but this needs an owner call, so it is **flagged, not silently fixed**. Nothing else in this plan depends on the answer; the tile is untouched by every change above.

## Changes

### 1. `src/api/qualityAnalytics.ts` — pure derivation helpers (no schema change)

The response contract is correct; only presentation logic is wrong. Put the new logic here rather than in the component: this module is already transpiled and unit-tested for real in `tests/quality-analytics.test.mjs`, so the new rules get **behavioral** tests instead of the brittle source-regex assertions the card is currently fenced with.

- Move `hasActivity()` out of the card (it is a local function there today, `:49-58`, not an import) and export it here. Keep all five call sites in the card byte-identical (`:210-214` — `quality.org ? hasActivity(quality.org) : false`, `hasActivity(quality.me)`, and the three `?.some(hasActivity) ?? false` forms) so the existing regex assertions at `tests/quality-analytics.test.mjs:269-270` still pass; the only card-side change is deleting the local definition and adding a value import (§3).
- Export named constants, replacing the magic numbers inlined in `issueLabels`:
  ```ts
  export const QUALITY_BREAKDOWN_MIN_RECORDINGS = 5;
  export const QUALITY_BREAKDOWN_MAX_ROWS = 5;
  export const QUALITY_BREAKDOWN_MAX_ALERTS = 2;          // the existing .slice(0, 2)
  export const QUALITY_MISSING_DETAILS_ALERT_RATE = 0.2;  // was inline 0.2
  export const QUALITY_REPROCESS_ALERT_RATE = 0.2;        // was inline 0.2
  export const QUALITY_SOAP_EDIT_ALERT_RATE = 0.5;        // was inline 0.5
  ```
- `visibleBreakdownItems(items: QualityBreakdownSummary[]): QualityBreakdownSummary[]` — filter to `completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS`, then sort `completedRecordings` desc with `label.localeCompare` as tiebreak, then `slice(0, QUALITY_BREAKDOWN_MAX_ROWS)`. Sort the array returned by `filter` (already a copy) — never sort the prop in place. Three notes so none of it reads as an oversight in review:
  - The sort is **load-bearing, not cosmetic**. `byModel` and `byAppointmentType` appear nowhere in `docs/clinic-quality-analytics-dashboard-plan.md` (grep: zero hits), so unlike `byProvider` — which that doc pins at `completedRecordings` desc then `fullName` asc (`:88`) — these two arrays have **no documented server ordering**, and the client cannot assume the top 5 arrive first.
  - Argless `localeCompare` is already shipped on this Hermes build (`src/lib/draftStorage.ts:293`, `src/lib/ffmpeg.ts:973`). CLAUDE.md rule 11's Hermes/Intl warning is about `toLocaleDateString` **with options**, not this.
  - The tiebreak compares the **raw** `label`, not the display fallback from §3, so a `''`-labeled group sorts first among equal counts while rendering as "Not specified". That only reorders ties; threading the fallback into the sort is not worth it.
- `breakdownIssueAlerts(item: QualitySummary): QualityIssueAlert[]` — replaces `issueLabels`. Returns **structured descriptors, not copy**, so this module needs no `strings.ts` import and the test vm harness (which stubs only `./client`) keeps working:
  ```ts
  export type QualityIssueAlert =
    | { kind: 'missingDetails'; pct: number }
    | { kind: 'soapEdited'; pct: number }
    | { kind: 'reprocessed'; count: number; recordings: number };
  ```
  Preserve the existing `.slice(0, QUALITY_BREAKDOWN_MAX_ALERTS)` cap and the existing threshold order (missing details, reprocessed, edited notes). Two derivation details the copy depends on:
  - `pct` is rounded **in the derivation**, not the formatter: `pct: Math.round((rate ?? 0) * 100)`. That matches `formatRate`'s existing rounding and keeps the tests asserting whole numbers.
  - **Every** descriptor requires a non-zero numerator, not just a rate over threshold: `missingMetadataCount > 0`, `soapEditedCount > 0`, and `reprocessCount > 0 && completedRecordings > 0`. A rate at or above threshold with a zero numerator is impossible for well-formed data, so the guard only suppresses corrupt payloads — but without it the card asserts "20% missing patient details" or "Reprocessed 0 times across 0 recordings" as fact. The reprocess case is the likeliest to actually disagree, because `reprocessCount` is sourced from `audit_logs` reprocess actions while the denominator comes from the recording window (`docs/clinic-quality-analytics-dashboard-plan.md:79-80`). The min-5 row filter hides the `completedRecordings === 0` half of this in the card today, but `breakdownIssueAlerts` is exported and tested on its own, so the guard belongs in the function.

### 2. `src/constants/strings.ts` — alert copy in `QUALITY_ANALYTICS_COPY`

CLAUDE.md → *File Conventions* puts centralized UI labels here ("Add new labels here — one grep surfaces every site; i18n precursor"). Note that `tests/strings-catalog-guard.test.mjs` does **not** generally enforce this — it fences brand spelling, seven specific migrated dialog literals, the Recordings tab label, and the `Processing…` ellipsis; none of them touch this card. The catalog constraint that *does* bind here is `tests/ui-clip-guard.test.mjs` (below). Add an `issues` block of placeholder templates plus a label fallback (`label: z.string()` accepts `''`, which currently renders a blank row title):

```ts
issues: {
  missingDetails: '{pct}% missing patient details',
  soapEdited: '{pct}% of notes edited',
  reprocessedOnce: 'Reprocessed once across {recordings} recordings',
  reprocessedMany: 'Reprocessed {count} times across {recordings} recordings',
},
unlabeledGroup: 'Not specified',
```

Both go in as siblings of `metrics` inside `QUALITY_ANALYTICS_COPY` (`src/constants/strings.ts:330-352`); nothing under `metrics` changes — three of those labels are asserted verbatim at `tests/quality-analytics.test.mjs:280-282`, with `:283` fencing the older `Reprocess rate` / `SOAP edit rate` / `P90 processing` wordings out.

The reprocess templates are **capitalized**: each alert is now its own line rather than a badge in a bag, so a line opening on a lowercase "reprocessed" reads as a rendering fault — which is the whole class of bug this plan exists to remove. The other two open on a digit, so casing does not arise.

Constraint from `tests/ui-clip-guard.test.mjs:34-44`: the guard flags any `key: 'Word '` — a **single-token** value with one trailing space (regex `/:\s*(['"`])(\S+) \1/g`, minus `:`-suffixed label prefixes). Multi-word fragments are explicitly allowed by that test, and none of the five values added here is single-token, so all pass. The point stands regardless: the clip mitigation must not leak into the catalog — it belongs in layout (below) or in the shared `Button`/`Banner` primitives.

### 3. `src/components/QualityAnalyticsCard.tsx` — layout + wiring

- **Import shape.** The card currently imports from this module with a **type-only** statement (`import type { DashboardQualityEnvelope, … } from '../api/qualityAnalytics';`, `:15-20`). `hasActivity`/`visibleBreakdownItems`/`breakdownIssueAlerts`/the constants are values, so add a **second, ordinary** `import { … } from '../api/qualityAnalytics';` alongside it rather than stripping `type` off the existing one (`QualityIssueAlert` is a type and stays in the `import type` list).
- **`BreakdownSection`** — run `items` through `visibleBreakdownItems()` first; bail on the resulting empty list; compute `maxCompleted` over the **visible** items so bars scale to what's on screen. Delete the now-redundant `items.slice(0, 5)` at `:163` and map over the visible array instead — the cap lives in `visibleBreakdownItems` (`QUALITY_BREAKDOWN_MAX_ROWS`), and leaving a second literal `5` behind reintroduces the magic number this change removes. Keep the defensive `item.completedRecordings > 0` clause in `BreakdownRow`'s `barWidth` so `tests/quality-analytics.test.mjs:289` keeps passing. Also **keep** the two call-site gates `quality.byAppointmentType?.length` / `quality.byModel?.length` (`:266`, `:272`) even though the internal bail now makes them redundant — they are fenced at `tests/quality-analytics.test.mjs:287-288`, and deleting them as dead weight is the likeliest way to redden this suite.
- **Alert row — the actual clip fix.** In `BreakdownRow`, `const badges = issueLabels(item)` (`:113`) becomes `const alerts = breakdownIssueAlerts(item)`. Replace the `flex-row flex-wrap` bag of unconstrained `<Text>` children with one row per alert, keyed `key={alert.kind}` (kinds are unique — the three thresholds are checked once each, so no duplicate-key risk): a `flexShrink: 0` icon wrapper holding `AlertTriangle` (already imported) plus a single `<Text className="text-caption text-status-warning flex-1">` with **no `numberOfLines`**. `flex-1` gives the Text a real width constraint, which is the documented cure for this exact silent-truncation class; wrapping replaces clipping, and omitting `numberOfLines` means a sentence that needs three lines at 1.3x font scale gets three lines instead of an ellipsis. Icon color is `colors.statusWarningFg` — `global.css:94` maps `.text-status-warning` to `--status-warning-fg`, so icon and text stay in lockstep in both themes and `theme-token-guard`/`dark-mode-guard` stay satisfied (`AlertTriangle` + `colors.statusWarningFg` is the existing pairing in `src/components/DeviceRegistrationBanner.tsx:44`, which likewise adds no accessibility props — the sentence carries the meaning). Spell the container out, because leaving it unspecified is how the wrapping bag got built the first time:

  ```tsx
  {alerts.length ? (
    <View className="mt-2">
      {alerts.map((alert) => (
        <View key={alert.kind} className="flex-row items-start mt-1">
          <View className="mr-1.5 mt-0.5" style={{ flexShrink: 0 }}>
            <AlertTriangle color={colors.statusWarningFg} size={12} />
          </View>
          <Text className="text-caption text-status-warning flex-1">{formatIssueAlert(alert)}</Text>
        </View>
      ))}
    </View>
  ) : null}
  ```
  No `flexWrap` anywhere — each alert owns a row, and the `flex-1` Text wraps inside it. `items-start` + `mt-0.5` keeps the icon aligned to the first line of a sentence that wraps rather than centering it against a two-line block.
- **Alert formatting** — a local `formatIssueAlert(alert: QualityIssueAlert): string` maps each descriptor to the `QUALITY_ANALYTICS_COPY.issues` template via `.replace()` (string patterns; `{pct}`/`{count}`/`{recordings}` each appear once, and no template contains a `$`). Reprocess picks `reprocessedOnce` when `count === 1`, else `reprocessedMany`. Write it as an exhaustive `switch (alert.kind)` returning in every branch, so adding a fourth `QualityIssueAlert` kind fails `npm run typecheck` instead of silently rendering nothing.
- **Row label fallback** — render `item.label.trim() || QUALITY_ANALYTICS_COPY.unlabeledGroup`.
- **Section icons** — `Clock3` is currently the icon for both "Models"/"Appointment types" (`:158`) and "Providers" (`:278`). A clock next to a model list is meaningless. Use `BarChart3` for the breakdown sections and `Users` for Providers — both already imported (`:5`, `:9`). Leave `ProviderRow`'s per-row `Users` avatar (`:178`) alone; the header/avatar repeat is intentional and differs in size and token (14px `contentTertiary` vs. 16px `brand500`). Drop the now-unused `Clock3` import — `Clock3` appears in the repo only at `:7`, `:158`, `:278` (verified), and a stale import fails `npm run lint`.
- **Out of scope, deliberately unchanged.** The `hasData` gate (`:208-214`) keeps counting activity in *all* groups, including a 1–4-recording group that no longer renders a row. Its exact shape is fenced by `tests/quality-analytics.test.mjs:269-270`, and `org` is the full-organization aggregate (`docs/clinic-quality-analytics-dashboard-plan.md:88`), so any group with activity also puts real numbers in the Practice block — the card never renders as an all-zero shell. The Providers `.slice(0, 5)` (`:283`) also stays a literal: the provider cap is a different concern from the breakdown cap and must not be coupled to `QUALITY_BREAKDOWN_MAX_ROWS`.

### 4. `tests/quality-analytics.test.mjs`

Add behavioral tests through the existing vm harness (this is the payoff for putting the logic in `qualityAnalytics.ts`):

- `visibleBreakdownItems` drops a 1-recording group; drops an all-zero group; keeps a group at exactly `QUALITY_BREAKDOWN_MIN_RECORDINGS` (boundary is `>=`, not `>`); sorts desc by `completedRecordings` with label tiebreak; caps at 5; returns `[]` for an all-small list; does not mutate its argument (assert the input array's order is unchanged after the call).
- `breakdownIssueAlerts` emits `{kind:'missingDetails',pct:40}` at `missingMetadataRate: 0.4`; emits `{kind:'reprocessed',count:6,recordings:5}` for `reprocessRate: 1.2, reprocessCount: 6, completedRecordings: 5` (the >100% case — assert no percentage is produced); returns `[]` below every threshold; caps at 2 when all three thresholds trip, keeping missing details + reprocessed and dropping edited notes (this pins the order, not just the count — note the fixture must raise all three *rates* above threshold, since `summary()` defaults `soapEditRate: 0.25`, while leaving the default non-zero counts alone so the numerator guards don't mask the cap). Also cover `null` rates (`missingMetadataRate: null` → no descriptor, exercising the `?? 0` fallback the current `issueLabels` already relies on).
- The three zero-numerator guards, one test each: `missingMetadataRate: 0.4, missingMetadataCount: 0` → no `missingDetails`; `soapEditRate: 0.9, soapEditedCount: 0` → no `soapEdited`; `reprocessRate: 0.5, reprocessCount: 0` → no `reprocessed`. Plus `reprocessRate: 0.5, reprocessCount: 3, completedRecordings: 0` → no `reprocessed`.

Add source assertions for the clip fix. They must be **scoped to the alert `Text`** — `QualityAnalyticsCard.tsx` legitimately carries `numberOfLines` on six other `Text` elements (`:71`, `:74`, `:118`, `:121`, `:181`, `:184`), so a bare `assert.doesNotMatch(source, /numberOfLines/)` fails on arrival. Assert instead:

```js
assert.match(source, /className="text-caption text-status-warning flex-1"/);
assert.doesNotMatch(source, /text-caption text-status-warning flex-1"\s+numberOfLines/);
assert.match(source, /style=\{\{ flexShrink: 0 \}\}/);           // alert icon wrapper
assert.doesNotMatch(source, /flex-row flex-wrap mt-1/);          // old badge bag is gone
```

And **wiring** assertions, without which every behavioral test above can pass while the card never calls the new helpers — the four `visibleBreakdownItems` tests would be green against a card that still renders unfiltered rows:

```js
assert.match(source, /visibleBreakdownItems\(items\)/);          // filter is actually applied
assert.doesNotMatch(source, /items\.slice\(0, 5\)/);             // the second cap is gone
assert.match(source, /breakdownIssueAlerts\(item\)/);            // alerts replace issueLabels
assert.doesNotMatch(source, /function issueLabels/);             // and the old one is deleted
assert.doesNotMatch(source, /function hasActivity/);             // moved, not duplicated
assert.match(source, /item\.label\.trim\(\) \|\| QUALITY_ANALYTICS_COPY\.unlabeledGroup/);
assert.doesNotMatch(source, /Clock3/);                           // section icons swapped
assert.match(source, /quality\.byProvider\.slice\(0, 5\)\.map/); // providers path untouched
```

The existing `doesNotMatch` fences at `:295-296` target the old badge classNames (`text-caption text-content-tertiary mr-3 mb-1" numberOfLines={1}` and `text-caption text-warning-500 mr-2 mb-1" numberOfLines={1}`) and stay green — the new markup does not reintroduce them. `:297` (`<Metric label={QUALITY_ANALYTICS_COPY.metrics.averageLength}`) also stays green: the four `Metric` tiles in `BreakdownRow` are unchanged.

## Files

| File | Change |
|---|---|
| `src/api/qualityAnalytics.ts` | Add + export `hasActivity` (moved), `visibleBreakdownItems`, `breakdownIssueAlerts` (with the zero-numerator guards), `QualityIssueAlert`, and the six threshold/cap constants. No schema change. |
| `src/constants/strings.ts` | Add `QUALITY_ANALYTICS_COPY.issues` (4 templates) + `unlabeledGroup`, both as siblings of `metrics`. `metrics` itself untouched. |
| `src/components/QualityAnalyticsCard.tsx` | Delete local `hasActivity`/`issueLabels`; add the value import; filter+sort breakdowns and drop the second `slice(0, 5)`; `badges` → `alerts`; rebuild the alert row as one `flex-1` Text per alert; add `formatIssueAlert`; label fallback; `BarChart3`/`Users` section icons and drop `Clock3`. |
| `tests/quality-analytics.test.mjs` | New behavioral tests for both helpers + scoped clip-fix source assertions |

## Verification

1. `npm run typecheck` — clean.
2. `npm run lint` — clean; specifically catches the dropped `Clock3` import if the icon swap lands without it.
3. `node --test tests/quality-analytics.test.mjs` — new behavioral tests pass.
4. `node --test tests/strings-catalog-guard.test.mjs tests/ui-clip-guard.test.mjs tests/font-scaling-guard.test.mjs tests/theme-token-guard.test.mjs tests/dark-mode-guard.test.mjs` — guards green.
5. `npm test` — full suite, no collateral breakage. `tests/quality-analytics.test.mjs` is the only test file that reads any of the three changed sources (verified by grep), so a failure anywhere else is a real regression, not a fence needing an update. `tests/recording-query-cache.test.mjs` also touches `['dashboard','quality']`, but only as a query key.
6. **Physical Android phone, not the emulator.** CLAUDE.md → UI Gotchas: "Verify on physical Android; iOS + emulator hide this class." Sign in against prod, Home tab, scroll to Clinic Quality:
   - `Reprocessed` and the alert sentences render complete, no missing glyphs, wrapping to a second line where needed.
   - No `Unknown model` row, no `0 rec` row, no all-`n/a` row. (A surviving ≥5-recording group can still show `n/a` in the Edited notes and 90%-done-by tiles — both rates are `null` when their own denominator is empty — but never in all four, since `reprocessRate`'s denominator is `completedRecordings`.)
   - `gemini-3.5-flash` (1 rec) is gone. `glm-5.2` (531 rec) remains; whatever alert it carries renders as a full sentence with its number, and if the zero-numerator guard suppresses one, no orange line appears at all rather than a partial one.
   - Repeat at **max OS font scale** — the app caps at 1.3x (`app/_layout.tsx:49-75`, fenced by `font-scaling-guard`), and 1.3x is where this clipping bites hardest. The new alert `Text` sets no `maxFontSizeMultiplier`, so the render patch injects the 1.3 cap for it — that is the intended path, not something to override. The 12px `AlertTriangle` does not font-scale, so also check the icon still reads as aligned to the first text line at 1.3x.
   - Check light and dark theme for the icon/text amber pairing.
   - If this org has no appointment type or model clearing 5 recordings, confirm the whole section (header included) is gone rather than a bare header sitting over nothing — that is the intended behavior per Decisions, and it is the one outcome a reviewer is most likely to mistake for a bug.
7. Confirm the breakdown filter did not leak into the Providers section. This is covered **in source** by the `quality.byProvider.slice(0, 5).map` assertion in §4, not on-device. An on-device check is not a reliable signal — the server sorts `byProvider` by `completedRecordings` desc then `fullName` asc (`docs/clinic-quality-analytics-dashboard-plan.md:88`) and the card slices to 5, so a 0-recording provider is only *visible* when the org has fewer than 5 active providers. If this test org does, also eyeball that the 0-recording provider is still listed.

## Post-review amendments (2026-07-30, PR #160)

Three changes landed after the plan was written. The first is an owner decision, the second and third came out of Codex review and self-review on the PR.

1. **`Reprocessed` metric tile resolved** — the open item flagged under Decisions is closed. The tile now renders the raw `reprocessCount` relabeled `Reprocesses` (`QUALITY_ANALYTICS_COPY.metrics.reprocesses`) in both `SummaryBlock` and `BreakdownRow`, so tile and alert both speak counts and a `200%` tile can no longer sit above a count-based sentence. The denominator stays on screen via the `Completed` tile and the `N rec` row header. Consequence: `reprocessRate` is now displayed nowhere and only drives the alert threshold.

2. **Breakdown retention widened beyond `completedRecordings` (Codex P2).** Filtering rows on the completion sample alone hid groups with real count-based problems: an appointment type with 20 failed uploads and zero completions vanished from the breakdown while the org aggregate still reported the failures. `visibleBreakdownItems` now keeps a group when `completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS` **or** `hasDisplayableIssueCounts(item)`.

   Codex's suggested remedy on its own would have regressed defect 3, because `BreakdownRow` had no tile for `failedUploadAttempts` or `silentAudioEvents` — a retained group would have rendered as exactly the empty `0 rec` / `n/a`-everywhere shell this plan exists to remove. So the retention half is paired with two additions:
   - `BreakdownRow` gains `Upload issues` and `Silent audio` tiles (labels already existed in `metrics`, same order as `SummaryBlock`), giving a retained group a surface that states why it is on screen.
   - Rate-based alerts (`missingDetails`, `soapEdited`) additionally require `completedRecordings >= QUALITY_BREAKDOWN_MIN_RECORDINGS`, so a group retained on counts alone cannot assert "100% of notes edited" off two recordings. Count-based alerts keep no such gate — "6 reprocesses" is true at any sample size. Groups that already cleared the minimum are unaffected.

   `hasDisplayableIssueCounts` deliberately excludes `missingMetadataCount` and `soapEditedCount`: the row surfaces those only as rates, and those rates are now suppressed below the minimum, so retaining a group for them alone would put back the empty row.

   **Residual, accepted:** the row cap is still applied by completion volume, so a zero-completion problem group can be cut when more than `QUALITY_BREAKDOWN_MAX_ROWS` groups qualify. Reserving slots for problem groups is a product decision and is deliberately not taken as a silent default — it belongs with the existing "top 5 with no signal that more exist" open item under Decisions.

3. **Test gaps closed, found by mutation testing.** Two fences were verified by breaking the code and confirming the suite goes red:
   - `formatIssueAlert`'s placeholder fills are pinned **per switch branch**. The first version searched for each placeholder anywhere in the file, and a mutant that broke `{pct}` in the `missingDetails` branch survived it — the `soapEdited` branch's own `{pct}` fill satisfied the match.
   - `hasActivity` had **no behavioral test** despite driving the card's empty-state gate; mutating it to always-true passed the whole suite. It now has one covering each counter individually, the all-zero case, and that a stale rate with no counts behind it is not activity.

   Note for anyone repeating this: the `hasActivity` and `hasDisplayableIssueCounts` bodies share a substring, so a first-occurrence source mutation aimed at one silently rewrites the other. Anchor on the function signature and diff against the pre-mutation file, not against `HEAD`.

## Follow-up (out of scope here)

Two Connect-side asks, both out of scope here:

1. `docs/clinic-quality-analytics-dashboard-plan.md` never documented the `byModel` / `byAppointmentType` contract that `083a18b` shipped — neither name appears in that file at all, so there is no label contract (what to emit for a null/legacy `ai_model`), no ordering contract, and no empty-group behavior. The server's `'Unknown model'` fallback group is what surfaced defect 3, and hiding it client-side is a mitigation, not a contract fix.
2. The response exposes rate numerators but not the denominators behind `missingMetadataRate` (`nonDraftRecordingCountInWindow`) or `soapEditRate` (`soapNoteCountInWindow`). Without them no client can suppress a small-sample "100%" for those two rates — see the accepted residual under Decisions. Emitting the two denominators (or a per-rate sample size) would let the min-5 rule apply uniformly instead of only to `reprocessRate`.

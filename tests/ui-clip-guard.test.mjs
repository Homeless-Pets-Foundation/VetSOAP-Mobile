// The Android "Bold text" clipping fence (CLAUDE.md > UI Gotchas).
//
// Root cause, proven on a physical Pixel 10 Pro XL (PR #171 / 8388c69): the OS
// "Bold text" setting sets Configuration.fontWeightAdjustment=300. Yoga measures
// the <Text> with the UNADJUSTED font and fixes its box from that; Android then
// paints every glyph wider and the overrun falls outside the box. With ≥2 tokens
// the run wraps at a space and the trailing word is laid out out of view with no
// ellipsis; with one token it clips at the edge. NOT a flex-shrink bug — a
// flex-1/flexShrink fix was built, installed, and had no effect before the real
// cause was found. It reproduces on neither the emulator nor iOS (both run
// fontWeightAdjustment=0), so a source fence is the only thing standing between
// a fixed label and its silent return.
//
// Four layers, in descending confidence:
//   1. Primitives (Button / Banner / StatusBadge / Badge) bake the mitigation in,
//      so screens have no incentive to hand-roll it — the original WP10 fence.
//   2. `strings.ts` stays clean: the trailing space belongs at the JSX site, never
//      in the copy catalog where a caller then has to .trim() it back out.
//   3. Per-site cases for every swept label (SWEPT below), each device-walked or
//      explicitly recorded as shape-equivalent.
//   4. A per-file ratchet over everything still exposed. That one counts a layout
//      SHAPE, not a proven bug — read its failure message before acting on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readBaseline, scanRepo, SCAN_ROOTS } from './ui-clip-guard-scan.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/** Every .ts/.tsx under the scanner's roots — used by the repo-wide fences below. */
async function listSourceFiles(dir = null) {
  if (dir === null) {
    const nested = await Promise.all(SCAN_ROOTS.map((r) => listSourceFiles(r)));
    return nested.flat();
  }
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(rel)));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The mitigation is spelled once, in ui/styles.ts. Asserting the named helpers
// rather than the literal `style={{ flexShrink: 0, paddingRight: 2 }}` is what makes
// these fences survive a Prettier reflow — the old regex matched the object
// character-for-character, so any line-splitting would have "broken" a healthy file.
test('ui/styles.ts owns the single definition of the clipping mitigation', async () => {
  const src = await read('src/components/ui/styles.ts');
  assert.match(src, /export const CLIP_SAFE = \{ flexShrink: 0, paddingRight: 2 \} as const;/);
  assert.match(src, /export function clipSafe\(label: string\)/);
  assert.match(src, /return `\$\{label\} `;/, 'clipSafe must append the load-bearing space');
});

test('Button bakes in the clipping mitigation', async () => {
  const src = await read('src/components/ui/Button.tsx');
  assert.match(src, /import \{ CLIP_SAFE, clipSafe,[^}]*\} from '\.\/styles';/);
  assert.match(src, /style=\{CLIP_SAFE\}/);
  assert.match(src, /\{clipSafe\(children\)\}/);
  // Icon wrapper must not shrink either.
  assert.match(src, /className="mr-2" style=\{\{ flexShrink: 0 \}\}/);
  // The screen-reader label stays un-padded.
  assert.match(src, /accessibilityLabel=\{accessibilityLabel \|\| children\}/);
});

test('Banner CTA bakes in the mitigation and uses shared HIT_SLOP', async () => {
  const src = await read('src/components/ui/Banner.tsx');
  assert.match(src, /import \{ CLIP_SAFE, clipSafe, HIT_SLOP \} from '\.\/styles';/);
  assert.match(src, /style=\{CLIP_SAFE\}/);
  assert.match(src, /\{clipSafe\(cta\.label\)\}/);
  assert.match(src, /accessibilityLabel=\{cta\.label\}/, 'CTA a11y label stays unpadded');
  assert.ok(!/hitSlop=\{8\}/.test(src), 'Banner touch targets use HIT_SLOP, not ad-hoc 8');
});

test('StatusBadge bakes in the mitigation and scopes numberOfLines to multi-token labels', async () => {
  const src = await read('src/components/StatusBadge.tsx');
  assert.match(src, /import \{ CLIP_SAFE, clipSafe \} from '\.\/ui\/styles';/);
  assert.match(src, /style=\{CLIP_SAFE\}/);
  assert.match(src, /\{clipSafe\(config\.label\)\}/);
  // A 1-token status ("Completed") must NOT get numberOfLines — it cannot wrap, so
  // the prop could only turn a full render into "Complete…". A 2-token status
  // ("Not Submitted") must, so its trailing word ellipsizes instead of vanishing.
  assert.match(src, /numberOfLines=\{config\.label\.includes\(' '\) \? 1 : undefined\}/);
  assert.match(src, /accessibilityLabel=\{`Status: \$\{config\.label\}`\}/);
});

test('no single-word strings.ts value carries a trailing clip-hack space', async () => {
  const src = await read('src/constants/strings.ts');
  // The dead hack shape was `confirm: 'Reprocess '` — a single word + one
  // trailing space that a call site then had to .trim() for Alerts. Multi-word
  // sentence fragments ending in a space (line-wrap concatenation) are fine.
  const offenders = [...src.matchAll(/:\s*(['"`])(\S+) \1/g)]
    .map((m) => m[2])
    // "Details: " style label prefixes concatenate with a value — not the hack.
    .filter((word) => !word.endsWith(':'));
  assert.deepEqual(offenders, [], `single-word trailing-space values found: ${JSON.stringify(offenders)}`);
});

// Both fences below cover clipping verified on a physical Pixel 10 Pro XL
// (2026-08-07, build 1.13.19). Neither reproduces on the emulator or iOS, so a
// source fence is the only thing that keeps them from silently coming back.

test('login subtitle claims full row width so Android cannot clip its last word', async () => {
  const src = await read('app/(auth)/login.tsx');
  const subtitle = src.match(/<Text[^>]*?>\s*Sign in to your account\s*<\/Text>/s);
  assert.ok(subtitle, 'login subtitle Text not found');
  // Inside an items-center parent the Text shrink-wraps and Android drops
  // "account" with no ellipsis. w-full makes it measure against the container.
  assert.match(
    subtitle[0],
    /className="[^"]*\bw-full\b[^"]*"/,
    'login subtitle must carry w-full (rendered as "Sign in to your" without it)',
  );
});

test('device capacity status labels carry bold-text overrun headroom', async () => {
  const src = await read('app/(app)/devices.tsx');
  const row = src.match(/<View className="flex-row items-baseline justify-between mb-2">.*?<\/View>/s);
  assert.ok(row, 'device capacity header row not found');

  // Left label absorbs the shortfall so the status label keeps its width.
  const leftLabel = row[0].match(/<Text className="([^"]*)"[^>]*>\s*\{capacity\.count\}/);
  assert.ok(leftLabel, 'capacity count Text not found');
  assert.match(leftLabel[1], /\bflex-1\b/, 'capacity count label must be flex-1');

  // All three status branches share the slot and the same failure mode, so all
  // three need the mitigation — not just the branch that happened to render.
  const branches = [
    "{clipSafe('Limit reached')}",
    "{clipSafe('Approaching limit')}",
    '{clipSafe(`${capacity.remaining} remaining`)}',
  ];
  for (const label of branches) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const branch = row[0].match(new RegExp(`<Text[^>]*?>\\s*${escaped}\\s*<\\/Text>`, 's'));
    assert.ok(branch, `status branch not found (clipSafe is load-bearing): ${label}`);
    assert.match(
      branch[0],
      /style=\{CLIP_SAFE\}/,
      `status branch ${label} must carry CLIP_SAFE`,
    );
    assert.match(
      branch[0],
      /numberOfLines=\{1\}/,
      `status branch ${label} must set numberOfLines={1} so overrun ellipsizes instead of vanishing`,
    );
  }
});

// ---------------------------------------------------------------------------
// The swept sites.
//
// Per-site rather than ratcheted, because these are the ones a device session
// actually walked at font_weight_adjustment=300. A count cannot encode "seen
// rendering correctly on a Pixel 10 Pro XL on 2026-08-07", and it cannot tell a
// redesign apart from a style prop — someone could "fix" the patient status pill
// by adding flex-1, satisfy the ratchet, and keep printing `pending_metadata`.
//
// Anchored on the label literal or the container className, never on a line
// number: these files churn, and a line-pinned fence rots into noise.
//
// `mitigation` values:
//   'width'    — flex-1 / w-full: the box gets real width, so no overrun at all
//   'headroom' — clipSafe + CLIP_SAFE: it must shrink-wrap, so buy slack instead
// `multiToken: true` additionally requires numberOfLines={1} — with a space to
// wrap at, the trailing word would otherwise be laid out out of view. On a
// single-token label the prop can only downgrade a full render to an ellipsis,
// so it is deliberately NOT required (and should not be added).
const SWEPT = [
  // -- tier 1: misreading changes a clinical or destructive decision -----------
  { file: 'app/(auth)/mfa.tsx', anchor: 'Setup key', mitigation: 'width', multiToken: false,
    why: 'mislabels the TOTP secret rendered directly beneath it' },
  { file: 'app/(auth)/mfa.tsx', anchor: '{enrollment.secret}', mitigation: 'width', multiToken: false,
    why: 'a mistranscribed secret locks the account; this client has no unenrol route' },
  { file: 'src/components/SubmitPanel.tsx', anchor: 'patients recorded', mitigation: 'width', multiToken: false,
    why: 'gates a batch submit; the tail turns a completion count into a selection' },
  { file: 'src/components/WaveformEditor.tsx', anchor: 'Keep {formatTime(keepDuration)}', mitigation: 'width', multiToken: true,
    why: 'hides how much audio an irreversible trim destroys' },
  { file: 'app/(app)/delete-account.tsx', anchor: '{DELETE_ACCOUNT_COPY.title}', mitigation: 'width', multiToken: true,
    why: 'header of the screen that destroys on-device work' },
  { file: 'app/(app)/(tabs)/recordings/[id].tsx', anchor: '{deleteDraftBlockedReason}', mitigation: 'width', multiToken: false,
    why: 'the only explanation for why a destructive action is unavailable' },

  // -- tier 2: misleads about system state ------------------------------------
  { file: 'src/components/UploadOverlay.tsx', anchor: 'UPLOAD_OVERLAY_COPY.titleMulti', mitigation: 'width', multiToken: false,
    why: 'without the tail the batch title equals the single-recording title' },
  { file: 'src/components/UploadOverlay.tsx', anchor: 'Recording {Math.min(currentUploadIndex, totalSlotsToUpload)} of', mitigation: 'width', multiToken: false,
    why: 'hides how much of the batch is left' },
  { file: 'src/components/UploadOverlay.tsx', anchor: '{phaseText}', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/(tabs)/record.tsx', anchor: '{paginationText}', mitigation: 'width', multiToken: false,
    why: 'position within a multi-patient session' },
  { file: 'src/components/PatientSlotCard.tsx', anchor: "clipSafe('Record')", mitigation: 'headroom', multiToken: false },
  { file: 'src/components/PatientSlotCard.tsx', anchor: 'Saving recording...', mitigation: 'width', multiToken: false },
  { file: 'src/components/SoapNoteView.tsx', anchor: 'Edited ${editedLabel}', mitigation: 'headroom', multiToken: true },
  { file: 'src/components/AttentionFeedSection.tsx', anchor: 'ATTENTION_FEED_COPY.sectionTitle', mitigation: 'width', multiToken: true },
  { file: 'src/components/AttentionFeedSection.tsx', anchor: 'ATTENTION_FEED_COPY.acrossPracticeSummary(acrossPracticeCount)', mitigation: 'width', multiToken: false,
    why: 'practice-wide count' },
  { file: 'app/(app)/(tabs)/index.tsx', anchor: 'more alert', mitigation: 'width', multiToken: false },
  { file: 'app/(app)/(tabs)/index.tsx', anchor: '>Not Submitted<', mitigation: 'width', multiToken: true,
    why: 'section heading over un-uploaded work; the lost word inverts it' },

  // -- tier 3: visible-but-recoverable ----------------------------------------
  { file: 'app/(app)/(tabs)/index.tsx', anchor: 'Recent Recordings', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/audio-editor.tsx', anchor: "clipSafe(isPlayingAll ? 'Stop' : 'Play All')", mitigation: 'headroom', multiToken: true },
  { file: 'app/(app)/audio-editor.tsx', anchor: 'Seg ${label}', mitigation: 'headroom', multiToken: true },
  { file: 'app/(app)/audio-editor.tsx', anchor: "Nudge ${nudgeTarget === 'start' ? 'start' : 'end'}:", mitigation: 'headroom', multiToken: true },
  { file: 'src/components/SoapNoteView.tsx', anchor: 'SOAP Note', mitigation: 'width', multiToken: true },
  { file: 'src/components/SoapNoteView.tsx', anchor: 'clipSafe(label)', mitigation: 'headroom', multiToken: false },
  { file: 'src/components/ExportSheet.tsx', anchor: 'EXPORT_COPY.title', mitigation: 'headroom', multiToken: false },
  { file: 'app/(app)/devices.tsx', anchor: 'Manage Devices', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/settings.tsx', anchor: 'Settings', mitigation: 'width', multiToken: false },
  { file: 'app/(app)/profile.tsx', anchor: '{PROFILE_COPY.title}', mitigation: 'width', multiToken: false },
  { file: 'app/(app)/subscription.tsx', anchor: '{SUBSCRIPTION_COPY.title}', mitigation: 'width', multiToken: false },
  { file: 'app/(app)/(tabs)/patient/[id].tsx', anchor: 'AI Patient Summary', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/(tabs)/patient/[id].tsx', anchor: 'Patient Details', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/(tabs)/patient/[id].tsx', anchor: 'Edit Profile', mitigation: 'width', multiToken: true },
  { file: 'app/(app)/(tabs)/patient/[id].tsx', anchor: '{recordingsData?.pagination?.total} visits', mitigation: 'width', multiToken: false },
  { file: 'app/(app)/(tabs)/patient/[id].tsx', anchor: "clipSafe('Outdated')", mitigation: 'headroom', multiToken: false },
  { file: 'app/(auth)/login.tsx', anchor: 'LOGIN_COPY.orContinueWith', mitigation: 'headroom', multiToken: true },
  { file: 'app/(auth)/login.tsx', anchor: 'LOGIN_COPY.forgotPassword', mitigation: 'headroom', multiToken: true },

  // -- primitives: one edit each, many call sites -----------------------------
  { file: 'src/components/ui/EmptyState.tsx', anchor: '{title}', mitigation: 'width', multiToken: false },
  { file: 'src/components/ui/EmptyState.tsx', anchor: '{description}', mitigation: 'width', multiToken: false },
  { file: 'src/components/Toast.tsx', anchor: 'clipSafe(message)', mitigation: 'headroom', multiToken: false },
  { file: 'src/components/ui/CopiedToast.tsx', anchor: 'clipSafe(label)', mitigation: 'headroom', multiToken: false },
];

const WIDTH = /className="[^"]*\b(?:flex-1|w-full)\b[^"]*"/;
const HEADROOM_STYLE = /style=\{CLIP_SAFE\}/;
const HEADROOM_LABEL = /\{clipSafe\(/;

/** The <Text> element containing `anchor`, or null. Non-greedy so it stops at the first close. */
function textElementContaining(src, anchor) {
  let from = 0;
  for (;;) {
    const at = src.indexOf(anchor, from);
    if (at < 0) return null;
    const open = src.lastIndexOf('<Text', at);
    const close = src.indexOf('</Text>', at);
    if (open >= 0 && close > at) {
      const el = src.slice(open, close + 7);
      // Reject a match that actually sits inside a nested element between them.
      if (!el.slice(1).includes('<Text')) return el;
    }
    from = at + anchor.length;
  }
}

test('every swept label keeps its bold-text mitigation', async () => {
  const offenders = [];
  const sources = new Map();

  for (const site of SWEPT) {
    if (!sources.has(site.file)) sources.set(site.file, await read(site.file));
    const el = textElementContaining(sources.get(site.file), site.anchor);
    const at = `${site.file} :: ${site.anchor}`;

    if (!el) {
      offenders.push(`${at} — Text not found (anchor moved? update the anchor, do not delete the case)`);
      continue;
    }
    if (site.mitigation === 'width' && !WIDTH.test(el)) {
      offenders.push(`${at} — lost flex-1/w-full${site.why ? ` (${site.why})` : ''}`);
    }
    if (site.mitigation === 'headroom' && !(HEADROOM_STYLE.test(el) && HEADROOM_LABEL.test(el))) {
      offenders.push(`${at} — lost clipSafe + CLIP_SAFE${site.why ? ` (${site.why})` : ''}`);
    }
    if (site.multiToken && !/numberOfLines=\{[12]\}/.test(el)) {
      offenders.push(`${at} — multi-token label lost its numberOfLines backstop`);
    }
  }

  assert.deepEqual(offenders, [], `swept labels regressed:\n  ${offenders.join('\n  ')}`);
});

// --- structural fences -----------------------------------------------------

test('patient visit rows render StatusBadge, not a hand-rolled status pill', async () => {
  const src = await read('app/(app)/(tabs)/patient/[id].tsx');
  // The pill both printed the wire value (`pending_metadata`) and clipped it to
  // "pending", so a note blocked on the vet's input read as queued. A style prop
  // would satisfy a shape ratchet while keeping the wrong copy — hence a fence on
  // the redesign itself.
  assert.match(src, /<StatusBadge status=\{recording\.status\} \/>/);
  assert.doesNotMatch(
    src,
    /<Text[^>]*>\s*\{recording\.status\}\s*<\/Text>/s,
    'raw recording.status must never render in a Text — StatusBadge owns the copy',
  );
});

test('the mitigation has exactly one spelling, and it lives in ui/styles', async () => {
  const files = await listSourceFiles();
  const raw = [];
  for (const file of files) {
    if (file === 'src/components/ui/styles.ts') continue;
    if (/flexShrink: 0, paddingRight: 2/.test(await read(file))) raw.push(file);
  }
  assert.deepEqual(
    raw,
    [],
    `hand-written mitigation literal found — import CLIP_SAFE from ui/styles instead: ${raw.join(', ')}`,
  );
});

test('no accessibilityLabel is fed a padded string', async () => {
  // The trailing space is a LAYOUT measurement, not content. Screen readers must
  // get the unpadded label — Button/Banner/Badge/StatusBadge all keep them split.
  const offenders = [];
  for (const file of await listSourceFiles()) {
    const src = await read(file);
    if (/accessibilityLabel=\{clipSafe\(/.test(src)) offenders.push(file);
    if (/accessibilityLabel=\{`[^`]*\} `\}/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `padded accessibilityLabel found: ${offenders.join(', ')}`);
});

// --- ratchet ---------------------------------------------------------------

test('shrink-wrapped Text count does not grow', async () => {
  // Counts a layout SHAPE, not a proven bug. See tests/ui-clip-guard-scan.mjs:
  // whether a word actually vanishes depends on runtime content and is
  // undecidable here, and most of these labels render dynamic values. A failure
  // means "a new shrink-wrapped label appeared" — judge it on the merits and
  // regenerate the baseline if it is fine, do not reflexively add a trailing
  // space to a label that never needed one.
  //
  // Per-file, not one total, so a new offender in record.tsx cannot be laundered
  // against a fix in audio-editor.tsx.
  const [baseline, counts] = await Promise.all([readBaseline(), scanRepo()]);
  const offenders = [];

  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.files[file] ?? 0;
    if (count > allowed) offenders.push(`${file}: ${count} > ${allowed}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `new shrink-wrapped Text shapes:\n  ${offenders.join('\n  ')}\n` +
      'Give the label width (flex-1 / w-full) or headroom (clipSafe + CLIP_SAFE), ' +
      'or regenerate: node tests/ui-clip-guard-scan.mjs --write',
  );

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(total <= baseline.total, `total ${total} exceeds baseline ${baseline.total}`);
});

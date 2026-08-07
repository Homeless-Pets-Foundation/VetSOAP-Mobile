// WP10 — the Android bold-text clipping mitigation (CLAUDE.md UI Gotchas)
// must live INSIDE the shared Button and Banner primitives. Screens used to
// bypass Button with raw Pressables (or ship trailing-space strings in the
// copy catalog) specifically to apply it; centralizing it removes that
// incentive. This fence keeps the mitigation in place and the catalog clean.
//
// Root cause (proven on device, PR #171 / 8388c69): the OS "Bold text" setting
// sets Configuration.fontWeightAdjustment=300. Yoga measures the <Text> with
// the UNADJUSTED font and fixes its box from that; Android then paints every
// glyph wider and the overrun falls outside the box — with ≥2 tokens the run
// wraps and the trailing word is laid out out of view (no ellipsis), with one
// token it clips at the edge. The trailing space + flexShrink:0 + paddingRight
// buy measured-width headroom. NOT a flex-shrink bug — a flex-1/flexShrink fix
// was built, installed, and had no effect before the real cause was found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

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

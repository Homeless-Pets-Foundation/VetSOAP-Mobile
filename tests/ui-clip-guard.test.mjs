// WP10 — the Android single-word clipping mitigation (CLAUDE.md UI Gotchas)
// must live INSIDE the shared Button and Banner primitives. Screens used to
// bypass Button with raw Pressables (or ship trailing-space strings in the
// copy catalog) specifically to apply it; centralizing it removes that
// incentive. This fence keeps the mitigation in place and the catalog clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('Button bakes in the single-word clipping mitigation', async () => {
  const src = await read('src/components/ui/Button.tsx');
  // Label renders with trailing space + flexShrink:0 + paddingRight.
  assert.match(src, /\{`\$\{children\} `\}/);
  assert.match(src, /style=\{\{ flexShrink: 0, paddingRight: 2 \}\}/);
  // Icon wrapper must not shrink either.
  assert.match(src, /className="mr-2" style=\{\{ flexShrink: 0 \}\}/);
  // The screen-reader label stays un-padded.
  assert.match(src, /accessibilityLabel=\{accessibilityLabel \|\| children\}/);
});

test('Banner CTA bakes in the mitigation and uses shared HIT_SLOP', async () => {
  const src = await read('src/components/ui/Banner.tsx');
  assert.match(src, /\{`\$\{cta\.label\} `\}/);
  assert.match(src, /style=\{\{ flexShrink: 0, paddingRight: 2 \}\}/);
  assert.match(src, /import \{ HIT_SLOP \} from '\.\/styles';/);
  assert.ok(!/hitSlop=\{8\}/.test(src), 'Banner touch targets use HIT_SLOP, not ad-hoc 8');
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
    "{'Limit reached '}",
    "{'Approaching limit '}",
    '{`${capacity.remaining} remaining `}',
  ];
  for (const label of branches) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const branch = row[0].match(new RegExp(`<Text[^>]*?>\\s*${escaped}\\s*<\\/Text>`, 's'));
    assert.ok(branch, `status branch not found (trailing space is load-bearing): ${label}`);
    assert.match(
      branch[0],
      /style=\{\{ flexShrink: 0, paddingRight: 2 \}\}/,
      `status branch ${label} must set flexShrink: 0 + paddingRight: 2`,
    );
    assert.match(
      branch[0],
      /numberOfLines=\{1\}/,
      `status branch ${label} must set numberOfLines={1} so overrun ellipsizes instead of vanishing`,
    );
  }
});

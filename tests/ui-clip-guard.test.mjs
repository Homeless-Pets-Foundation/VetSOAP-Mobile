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

// WP11 — OS text scaling is capped at 1.3x, never disabled. Disabling scaling
// froze 12–15px text for low-vision users on exactly the dense screens (SOAP
// actions, audio player, status badges) where they most need it. Per-element
// SMALLER caps are allowed; disabling is not, and neither is exceeding 1.3x.
//
// This guard used to assert only that three source strings existed in
// app/_layout.tsx. That patched `Text.render` / `TextInput.render`, and RN 0.83
// exports both as plain function components with no `.render` static — so the
// patch never ran and the cap was never applied. A physical-device measurement
// on 2026-08-25 found text scaling 3.58x against a declared 1.3x cap while this
// test was green. A source grep cannot observe that the code it fences never
// executes, so the guard is now two things that can actually fail:
//
//   1. the cap resolver is EXECUTED, not grepped;
//   2. an import fence proves every call site routes through the wrapper that
//      applies it, so a new file cannot silently opt out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The single file allowed to import Text/TextInput from react-native. */
const WRAPPER = 'src/components/ui/Text.tsx';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

test('no allowFontScaling={false} anywhere in app/ or src/', async () => {
  const offenders = [];
  for (const dir of ['app', 'src']) {
    for await (const file of walk(path.join(root, dir))) {
      const src = await readFile(file, 'utf8');
      if (src.includes('allowFontScaling={false}')) {
        offenders.push(path.relative(root, file));
      }
    }
  }
  assert.deepEqual(offenders, [], `allowFontScaling={false} found in: ${offenders.join(', ')}`);
});

test('the cap resolver defaults to 1.3x', async () => {
  const { resolveMaxFontSizeMultiplier, GLOBAL_MAX_FONT_SIZE_MULTIPLIER } =
    await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(GLOBAL_MAX_FONT_SIZE_MULTIPLIER, 1.3);
  assert.equal(resolveMaxFontSizeMultiplier(undefined), 1.3);
});

test('the cap resolver honours a smaller per-element cap', async () => {
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(resolveMaxFontSizeMultiplier(1.1), 1.1);
});

test('the cap resolver clamps a larger per-element cap to the global cap', async () => {
  // A per-element value above 1.3 is the overflow this cap exists to prevent
  // (the Home device-capacity banner ran off its card at 3.58x). Smaller wins;
  // larger does not.
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(resolveMaxFontSizeMultiplier(2), 1.3);
});

test('the cap resolver rejects disabling scaling via a nonsense cap', async () => {
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveMaxFontSizeMultiplier(bad), 1.3, `bad cap ${bad} should fall back to 1.3`);
  }
});

test('only the ui/Text wrapper imports Text or TextInput from react-native', async () => {
  // The fence. Without it the wrapper is advisory: one new file importing Text
  // straight from react-native silently opts 1.3x out again, exactly the way
  // the old render patch failed.
  const offenders = [];
  for (const dir of ['app', 'src']) {
    for await (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === WRAPPER) continue;
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native'/g)) {
        const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        if (named.includes('Text') || named.includes('TextInput')) offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `Text/TextInput imported from react-native outside ${WRAPPER}: ${[...new Set(offenders)].sort().join(', ')}`,
  );
});

test('the wrapper applies the resolved cap to both Text and TextInput', async () => {
  const src = await readFile(path.join(root, WRAPPER), 'utf8');
  // Both components must be wrapped, and the cap must be resolved per call
  // rather than hardcoded, so a smaller per-element cap still wins.
  assert.match(src, /export function Text\b/);
  assert.match(src, /export const TextInput = React\.forwardRef/);
  // `useRef<TextInput>` in app/(auth)/login.tsx needs TextInput in the TYPE
  // namespace too; without this alias the fence would force that call site back
  // to importing from react-native.
  assert.match(src, /export type TextInput = RNTextInput/);
  const applied = src.match(/maxFontSizeMultiplier=\{resolveMaxFontSizeMultiplier\(maxFontSizeMultiplier\)\}/g);
  assert.equal(applied?.length, 2, 'both Text and TextInput must apply the resolved cap');
});

test('the dead Text.render patch is gone from app/_layout.tsx', async () => {
  // RN 0.83 has no .render static on Text/TextInput; the patch silently no-oped.
  // Keeping it would leave a second, non-functioning source of truth for the cap.
  const src = await readFile(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.doesNotMatch(src, /__interApplied/);
  assert.doesNotMatch(src, /GLOBAL_MAX_FONT_SIZE_MULTIPLIER/);
  assert.doesNotMatch(src, /target\.render/);
});

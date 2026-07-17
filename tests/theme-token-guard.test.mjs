// WP12 — theme-token guards:
// 1. Light/dark CSS var parity: global.css light (:root) and dark (.dark:root)
//    blocks must define the same variable names, and the hand-mirrored
//    src/constants/colors.ts must stay in sync (the triple-maintained theme
//    had no drift check).
// 2. Status-color fence: screens must use the AA-checked status-* utilities
//    (or fg tokens for indicator dots), not the static single-hue palettes
//    (text-warning-500 measured 2.15:1 on white).
// 3. The light content-tertiary token stays at an AA-compliant value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

function extractVarNames(block) {
  return new Set([...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
}

async function getCssBlocks() {
  const css = await read('global.css');
  const lightStart = css.indexOf(':root');
  const darkStart = css.indexOf('.dark:root');
  assert.ok(lightStart >= 0 && darkStart > lightStart, 'expected :root then .dark:root in global.css');
  const utilitiesStart = css.indexOf('@layer utilities');
  return {
    light: css.slice(lightStart, darkStart),
    dark: css.slice(darkStart, utilitiesStart > 0 ? utilitiesStart : undefined),
  };
}

test('light and dark CSS var sets match', async () => {
  const { light, dark } = await getCssBlocks();
  const lightVars = extractVarNames(light);
  const darkVars = extractVarNames(dark);
  const onlyLight = [...lightVars].filter((v) => !darkVars.has(v));
  const onlyDark = [...darkVars].filter((v) => !lightVars.has(v));
  assert.deepEqual(onlyLight, [], `vars defined only in light block: ${onlyLight.join(', ')}`);
  assert.deepEqual(onlyDark, [], `vars defined only in dark block: ${onlyDark.join(', ')}`);
});

test('colors.ts light/dark mirrors carry the same keys', async () => {
  const src = await read('src/constants/colors.ts');
  const extractKeys = (marker) => {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} not found`);
    const end = src.indexOf('} as const', start);
    const block = src.slice(start, end);
    return new Set([...block.matchAll(/^\s{2}([a-zA-Z0-9]+):/gm)].map((m) => m[1]));
  };
  const light = extractKeys('export const LIGHT_THEME_COLORS');
  const dark = extractKeys('export const DARK_THEME_COLORS');
  const onlyLight = [...light].filter((k) => !dark.has(k));
  const onlyDark = [...dark].filter((k) => !light.has(k));
  assert.deepEqual(onlyLight, [], `keys only in LIGHT_THEME_COLORS: ${onlyLight.join(', ')}`);
  assert.deepEqual(onlyDark, [], `keys only in DARK_THEME_COLORS: ${onlyDark.join(', ')}`);
});

test('light content-tertiary token stays AA-compliant (stone-500, not stone-400)', async () => {
  const { light } = await getCssBlocks();
  assert.match(light, /--color-content-tertiary: 120 113 108/);
  const colors = await read('src/constants/colors.ts');
  // Light block mirror must match; the dark value (#a8a29e) passes on dark surfaces.
  assert.match(colors, /contentTertiary: '#78716c'/);
});

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.tsx$/.test(entry.name)) {
      yield full;
    }
  }
}

test('no static single-hue status classes outside ui/ (use status-* tokens)', async () => {
  const offenders = [];
  const pattern = /\b(?:text|bg|border)-(?:success|warning|danger|info)-[0-9]{2,3}\b/;
  for (const dir of ['app', 'src/components', 'src/hooks']) {
    for await (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file);
      if (rel.startsWith(path.join('src', 'components', 'ui') + path.sep)) continue;
      const src = await readFile(file, 'utf8');
      const m = src.match(pattern);
      if (m) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `static status-hue classes found: ${offenders.join('; ')}`);
});

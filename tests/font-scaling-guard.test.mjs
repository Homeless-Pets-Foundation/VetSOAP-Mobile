// WP11 — font scaling is capped globally (maxFontSizeMultiplier 1.3 injected
// via the Text/TextInput render patch in app/_layout.tsx), never disabled.
// Disabling scaling froze 12–15px text for low-vision users on exactly the
// dense screens (SOAP actions, audio player, status badges) where they most
// need it. Per-element SMALLER caps are allowed; disabling is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('the global maxFontSizeMultiplier cap is injected by the render patch', async () => {
  const src = await readFile(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.match(src, /const GLOBAL_MAX_FONT_SIZE_MULTIPLIER = 1\.3;/);
  assert.match(src, /element\.props\.maxFontSizeMultiplier === undefined/);
  assert.match(src, /maxFontSizeMultiplier: GLOBAL_MAX_FONT_SIZE_MULTIPLIER/);
});

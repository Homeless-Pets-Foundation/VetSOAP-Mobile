// WP15 — copy-catalog + terminology fences (2026-07 audit theme C):
// - one brand spelling ("Captivet", never "CaptiVet")
// - migrated alert copy lives only in src/constants/strings.ts
// - user-facing vocabulary for un-submitted work is "Saved sessions" (stash)
//   and "Not Submitted" (drafts) — the tab is "Recordings", not "Records"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

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

test('brand is spelled Captivet everywhere in source', async () => {
  const offenders = [];
  for (const dir of ['app', 'src']) {
    for await (const file of walk(path.join(root, dir))) {
      const src = await readFile(file, 'utf8');
      if (src.includes('CaptiVet')) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], `"CaptiVet" misspelling found in: ${offenders.join(', ')}`);
});

test('migrated dialog copy exists only in the strings catalog', async () => {
  // Literals that used to be inline in record.tsx / useStashedSessions.ts.
  const forbidden = [
    "'Replace Current Session?'",
    "'Discard Recordings?'",
    "'Session Saved'",
    "'Delete Saved Session?'",
    "'Some Audio Missing'",
    "'Resume Failed'",
    "'Save for Later?'",
  ];
  const offenders = [];
  for (const dir of ['app', 'src/components', 'src/hooks']) {
    for await (const file of walk(path.join(root, dir))) {
      const src = await readFile(file, 'utf8');
      for (const literal of forbidden) {
        if (src.includes(literal)) offenders.push(`${path.relative(root, file)}: ${literal}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `inline dialog literals found: ${offenders.join('; ')}`);
});

test('recordings tab is labeled Recordings and stash limit is single-sourced', async () => {
  const tabs = await read('app/(app)/(tabs)/_layout.tssx'.replace('.tssx', '.tsx'));
  assert.match(tabs, /title: 'Recordings'/);
  assert.ok(!tabs.includes("title: 'Records'"), 'tab label must match the screens ("Recordings")');

  const stashStorage = await read('src/lib/stashStorage.ts');
  assert.match(stashStorage, /export const MAX_STASHES = 5;/);
  const hook = await read('src/hooks/useStashedSessions.ts');
  assert.match(hook, /allStashes\.length >= MAX_STASHES/);
});

test('detail-screen processing copy comes from the catalog with a single ellipsis', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /processingTitle: 'Processing…'/);
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.ok(!detail.includes('Processing...'), 'no ASCII three-dot Processing literal in the detail screen');
  assert.match(detail, /RECORDING_DETAIL_COPY\.processingTitle/);
});

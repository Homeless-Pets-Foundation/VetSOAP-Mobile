import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const baseline = JSON.parse(
  await readFile(new URL('dark-mode-guard-baseline.json', import.meta.url), 'utf8')
);
const patterns = Object.keys(baseline.patterns);

async function collectFiles(relativeDir) {
  const dir = new URL(`${relativeDir}/`, root);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(relativePath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function countOccurrences(source, pattern) {
  return source.split(pattern).length - 1;
}

test('dark-mode hardcoded color guard does not regress', async () => {
  const counts = Object.fromEntries(patterns.map((pattern) => [pattern, 0]));
  const files = (await Promise.all(baseline.roots.map(collectFiles))).flat();

  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const pattern of patterns) {
      counts[pattern] += countOccurrences(source, pattern);
    }
  }

  for (const pattern of patterns) {
    assert.ok(
      counts[pattern] <= baseline.patterns[pattern],
      `${pattern} count ${counts[pattern]} exceeds baseline ${baseline.patterns[pattern]}`
    );
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  assert.ok(total <= baseline.total, `total count ${total} exceeds baseline ${baseline.total}`);
});

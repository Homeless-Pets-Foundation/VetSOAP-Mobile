// Regression for finding O6: countUnsentRecordings under-reported unsent work
// because it excluded RESUMED stashes. A resumed-but-unsubmitted stash is unsent
// work that nothing else represents (its draft was deleted at stash time and not
// recreated on resume), so it MUST be counted — otherwise the sign-out /
// delete-account warning shows a generic prompt with no count.
//
// Self-contained loader (transpile the pure .ts with the `typescript` devDep +
// run in a vm) so this test does not depend on any shared test helper that may
// live only on another branch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

function loadPureTs(relPath) {
  const abs = fileURLToPath(new URL(relPath, import.meta.url));
  const compiled = ts.transpileModule(readFileSync(abs, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleObj = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: moduleObj.exports,
    module: moduleObj,
    require: createRequire(abs), // unsentCount.ts imports only an erased type, so require is unused
  });
  return moduleObj.exports;
}

const { countUnsentStashSessions } = loadPureTs('../src/lib/unsentCount.ts');

test('countUnsentStashSessions counts resumed stashes as unsent (O6)', () => {
  const sessions = [
    { id: 'a', resumedAt: '2026-07-01T00:00:00.000Z' }, // resumed, not yet submitted
    { id: 'b', resumedAt: null }, // never resumed
    { id: 'c' }, // resumedAt absent
  ];
  // Was 1 (only the un-resumed) before the fix — the resumed stash is now included.
  assert.equal(countUnsentStashSessions(sessions), 3);
});

test('countUnsentStashSessions returns 0 for no sessions', () => {
  assert.equal(countUnsentStashSessions([]), 0);
});

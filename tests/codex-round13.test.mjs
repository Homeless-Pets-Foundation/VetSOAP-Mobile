// Codex round-13 regressions (PR #143): metadata edits must be frozen during
// a Submit All batch (the upload loop holds a pre-edit snapshot and the
// post-batch reset discards edits), and DOB validation errors must reset when
// a patient edit session is reopened or cancelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('handleUpdateForm is frozen during a Submit All batch', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  const start = src.indexOf('const handleUpdateForm = useCallback');
  assert.ok(start > -1);
  const body = src.slice(start, start + 700);
  // The guard runs BEFORE dispatching the update.
  assert.match(
    body,
    /if \(\s*isSubmittingAllRef\.current \|\|\s*uploadRestartSlotIdsRef\.current\.has\(slotId\)\s*\) \{\s*return;\s*\}\s*updateForm\(slotId, field, value\);/,
  );
  // The ref is declared before handleUpdateForm (no TDZ) and refreshed after
  // the isSubmittingAll state.
  const refDecl = src.indexOf('const isSubmittingAllRef = useRef(false);');
  assert.ok(refDecl > -1 && refDecl < start, 'isSubmittingAllRef must be declared before handleUpdateForm');
  assert.match(src, /isSubmittingAllRef\.current = isSubmittingAll;/);
});

test('patient DOB validation error resets on opening and cancelling an edit', async () => {
  const src = await read('app/(app)/(tabs)/patient/[id].tsx');
  // startEdit clears the stale error before reloading saved values.
  const startEdit = src.indexOf('const startEdit = useCallback');
  assert.ok(startEdit > -1);
  assert.match(src.slice(startEdit, startEdit + 500), /setDobError\(null\);/);
  // Cancel also clears it.
  assert.match(src, /onPress=\{\(\) => \{ setEditMode\(false\); setDobError\(null\); \}\}/);
});

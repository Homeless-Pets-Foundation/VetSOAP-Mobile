// WP6 — UploadOverlay progress must be scoped to the current submit batch.
// Counting every session slot with uploadStatus === 'success' inflated
// progress when Submit All followed a single submit (started at 50%,
// showed "Recording 2 of 2" while the first of two was uploading).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

// Pure re-implementation mirror of countBatchCompleted — keep in sync with
// src/components/UploadOverlay.tsx (asserted structurally below).
function countBatchCompleted(slots, batchSlotIds) {
  if (batchSlotIds.length === 0) return 0;
  const batch = new Set(batchSlotIds);
  return slots.filter((s) => batch.has(s.id) && s.uploadStatus === 'success').length;
}

const slot = (id, uploadStatus) => ({ id, uploadStatus });

test('pre-batch successes are excluded from batch progress', () => {
  const slots = [slot('a', 'success'), slot('b', 'uploading'), slot('c', 'pending')];
  // 'a' was uploaded in an earlier single submit; the new batch is b+c.
  assert.equal(countBatchCompleted(slots, ['b', 'c']), 0);
});

test('batch successes are counted', () => {
  const slots = [slot('a', 'success'), slot('b', 'success'), slot('c', 'uploading')];
  assert.equal(countBatchCompleted(slots, ['b', 'c']), 1);
});

test('empty batch counts zero', () => {
  assert.equal(countBatchCompleted([slot('a', 'success')], []), 0);
});

test('UploadOverlay uses batch-scoped counting and seeds the toast set on open', async () => {
  const src = await read('src/components/UploadOverlay.tsx');
  assert.match(src, /export function countBatchCompleted\(slots: PatientSlot\[\], batchSlotIds: string\[\]\): number \{\s*\n\s*if \(batchSlotIds\.length === 0\) return 0;\s*\n\s*const batch = new Set\(batchSlotIds\);\s*\n\s*return slots\.filter\(\(s\) => batch\.has\(s\.id\) && s\.uploadStatus === 'success'\)\.length;/);
  // Seeding on open prevents stale "<old patient> uploaded" toasts.
  assert.match(src, /const justOpened = !prevVisibleRef\.current;/);
  assert.match(src, /if \(!justOpened\) \{/);
  // The assertive live-region label must not embed the live percentage.
  assert.ok(!/accessibilityLabel=\{`Upload in progress\. \$\{phaseText\} \$\{overallProgress\}%`\}/.test(src));
});

test('Toast dismissal timer survives parent re-renders (Codex P2 round 5)', async () => {
  const toast = await read('src/components/Toast.tsx');
  // Inline onHide closures change identity on every parent render (upload
  // progress ticks) — the timer effect must read the callback through a ref,
  // not restart on identity change, or success toasts never auto-dismiss.
  assert.match(toast, /const onHideRef = useRef\(onHide\);/);
  assert.match(toast, /setTimeout\(\(\) => onHideRef\.current\(\), effectiveDuration\)/);
  assert.match(toast, /\}, \[visible, effectiveDuration\]\);/);
});

test('record.tsx passes the batch slot ids and offers Hide', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /batchSlotIds=\{batchSlotIds\}/);
  assert.match(rec, /setBatchSlotIds\(\[slotId\]\)/);
  assert.match(rec, /setBatchSlotIds\(slotIdsToUpload\)/);
  assert.match(rec, /onHide=\{\(\) => setUploadOverlayHidden\(true\)\}/);
});

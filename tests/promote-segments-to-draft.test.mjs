import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('multiPatient.ts SessionAction adds PROMOTE_SEGMENTS_TO_DRAFT using AudioSegment[]', async () => {
  const src = await read('src/types/multiPatient.ts');

  // The new action carries the durable-draft segment array as AudioSegment[]
  // (not an inlined shape) so a future field on AudioSegment flows through.
  assert.match(
    src,
    /\|\s*\{\s*type:\s*'PROMOTE_SEGMENTS_TO_DRAFT';\s*slotId:\s*string;\s*segments:\s*AudioSegment\[\]\s*\}/
  );
});

test('useMultiPatientSession reducer handles PROMOTE_SEGMENTS_TO_DRAFT URI-only', async () => {
  const src = await read('src/hooks/useMultiPatientSession.ts');

  assert.match(src, /case 'PROMOTE_SEGMENTS_TO_DRAFT':/);
  // Length-guard with __DEV__ warn so a partial-success saveDraft can't slip
  // through and leave the slot in a mixed durable+temp URI state.
  assert.match(src, /segments\.length !== action\.segments\.length/);
  // Per-segment duration check rejects array swaps that happen to match length.
  assert.match(src, /durationsMatch/);
  // URI-only: the case returns a spread that ONLY overwrites segments. We
  // grep for the spread + a single segments assignment, and verify that no
  // other PatientSlot field is reassigned inside the case body.
  const caseMatch = src.match(
    /case 'PROMOTE_SEGMENTS_TO_DRAFT':\s*\{([\s\S]*?)\n\s{4}\}/
  );
  assert.ok(caseMatch, 'PROMOTE_SEGMENTS_TO_DRAFT case body must be findable');
  const body = caseMatch[1];
  // Only one property assignment overriding slot fields — `segments:`.
  // (Other "X:" matches inside __DEV__ object literals or function calls
  // are allowed; we only care about the slot-update spread.)
  assert.match(body, /\{\s*\.\.\.slot,\s*segments:\s*action\.segments\s*\}/);
  // Defense check: no audioState / recorderBoundToSlotId / uploadStatus
  // / serverDraftId / draftSlotId / pendingConfirm reassignment.
  assert.doesNotMatch(body, /audioState:\s*[^]/);
  assert.doesNotMatch(body, /recorderBoundToSlotId:\s*[^]/);
  assert.doesNotMatch(body, /uploadStatus:\s*[^]/);
  assert.doesNotMatch(body, /serverDraftId:\s*[^]/);
  assert.doesNotMatch(body, /pendingConfirm:\s*[^]/);
});

test('draftStorage.saveDraft returns { draftSlotId, promotedSegments } shape', async () => {
  const src = await read('src/lib/draftStorage.ts');

  assert.match(
    src,
    /async saveDraft\(\s*slot: PatientSlot,\s*options: DraftSaveOptions = \{\},\s*\): Promise<\{ draftSlotId: string; promotedSegments: AudioSegment\[\] \}>/
  );
  // The promoted array is derived from draftSegments (the on-disk durable
  // entries assembled during the copy loop), not from slot.segments — that's
  // the whole point of the change.
  assert.match(
    src,
    /const promotedSegments:\s*AudioSegment\[\]\s*=\s*draftSegments\.map/
  );
  assert.match(src, /return \{ draftSlotId: slot\.id, promotedSegments \};/);
});

test('record.tsx autoSaveDraft dispatches PROMOTE_SEGMENTS_TO_DRAFT before SET_DRAFT_IDS', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // Destructure the new return shape.
  assert.match(
    src,
    /const \{ draftSlotId, promotedSegments \} = await draftStorage\.saveDraft\(slot\);/
  );
  // Length-gated PROMOTE dispatch — partial-success saveDraft must not promote.
  assert.match(
    src,
    /if \(promotedSegments\.length === slot\.segments\.length\) \{\s*dispatch\(\{\s*type: 'PROMOTE_SEGMENTS_TO_DRAFT',/
  );
  // PROMOTE happens before SET_DRAFT_IDS so any sessionRef read after either
  // dispatch sees the new URIs first.
  const promoteIdx = src.search(/type: 'PROMOTE_SEGMENTS_TO_DRAFT'/);
  const setIdsIdx = src.indexOf("type: 'SET_DRAFT_IDS'", promoteIdx);
  assert.ok(promoteIdx > 0, 'PROMOTE_SEGMENTS_TO_DRAFT dispatch must appear in record.tsx');
  assert.ok(setIdsIdx > promoteIdx, 'PROMOTE_SEGMENTS_TO_DRAFT must dispatch before the immediately-following SET_DRAFT_IDS');
});

test('record.tsx discard / record-again / remove paths skip draft-owned URIs', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // The helper exists and matches under documentDirectory/drafts/.
  assert.match(src, /function isDraftOwnedUri\(uri: string\): boolean \{[\s\S]*?return uri\.includes\('\/drafts\/'\);[\s\S]*?\}/);
  // Every discard-path safeDeleteFile(seg.uri) is gated. The only exempt
  // callsite is the post-upload cleanup loop (uploadSlot success), because
  // draftStorage.deleteDraft() runs the same dir cleanup afterwards and the
  // audio is no longer needed once it's on R2.
  const gatedCount = (src.match(/if \(!isDraftOwnedUri\(seg\.uri\)\) \{\s*safeDeleteFile\(seg\.uri\);\s*\}/g) || []).length;
  assert.ok(gatedCount >= 3, `expected >= 3 gated safeDeleteFile callsites, found ${gatedCount}`);
  // Audio-editor result handler also gates.
  assert.match(
    src,
    /if \(!newUris\.has\(seg\.uri\) && !isDraftOwnedUri\(seg\.uri\)\) \{\s*\/\/[^}]*safeDeleteFile\(seg\.uri\);\s*\}/
  );
});

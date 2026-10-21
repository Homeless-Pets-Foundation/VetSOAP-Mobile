// UX-H3 (UI/UX audit 2026-10-21): Save for Later deletes a slot's local draft
// but keeps its server draft row, so "not in draftStorage" is NOT "not on this
// device". These tests EXECUTE the pure classifier behind the detail screen's
// draft card and the RecordingCard "Saved session" chip, then fence the wiring.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const {
  classifyServerDraftLocation,
  draftLocationAllowsDelete,
  buildSavedSessionDraftMap,
  savedSessionIdForDraft,
} = await loadTsModule('src/lib/draftLocation.ts');

test('a resumable local draft wins and keeps its delete', () => {
  const loc = classifyServerDraftLocation({
    draftResolved: true,
    draftLocalSlotId: 'slot-1',
    anchor: null,
  });
  assert.deepEqual({ ...loc }, { kind: 'local_draft', draftSlotId: 'slot-1' });
  assert.equal(draftLocationAllowsDelete(loc), true);
});

test('a saved session holding the draft is on this device, with no delete', () => {
  const loc = classifyServerDraftLocation({
    draftResolved: true,
    draftLocalSlotId: null,
    anchor: { kind: 'saved_session', stashSessionId: 'stash-1' },
  });
  assert.deepEqual({ ...loc }, { kind: 'saved_session', stashSessionId: 'stash-1' });
  assert.equal(draftLocationAllowsDelete(loc), false);
});

test('recoveries and strict-scan drafts are on this device, with no delete', () => {
  for (const [anchor, expected] of [
    [{ kind: 'durable_recovery', durableRecordingId: 'd1' }, { kind: 'recovery', source: 'durable' }],
    [{ kind: 'support_recovery', vaultItemId: 'v1' }, { kind: 'recovery', source: 'support' }],
    [{ kind: 'draft', draftSlotId: 's9' }, { kind: 'resumable_draft', draftSlotId: 's9' }],
  ]) {
    const loc = classifyServerDraftLocation({ draftResolved: true, draftLocalSlotId: null, anchor });
    assert.deepEqual({ ...loc }, expected);
    assert.equal(draftLocationAllowsDelete(loc), false, `${anchor.kind} must not offer delete`);
  }
});

test('only a proven absence is "not on this device" and unlocks delete', () => {
  const loc = classifyServerDraftLocation({
    draftResolved: true,
    draftLocalSlotId: null,
    anchor: { kind: 'none' },
  });
  assert.deepEqual({ ...loc }, { kind: 'not_on_device' });
  assert.equal(draftLocationAllowsDelete(loc), true);
});

test('an unfinished or ambiguous check never offers delete', () => {
  const cases = [
    { draftResolved: false, draftLocalSlotId: null, anchor: null },
    { draftResolved: true, draftLocalSlotId: null, anchor: null },
    { draftResolved: false, draftLocalSlotId: null, anchor: { kind: 'none' } },
    { draftResolved: true, draftLocalSlotId: null, anchor: { kind: 'unknown' } },
    { draftResolved: true, draftLocalSlotId: null, anchor: { kind: 'something_new' } },
  ];
  for (const input of cases) {
    const loc = classifyServerDraftLocation(input);
    assert.ok(loc.kind === 'checking' || loc.kind === 'unknown', JSON.stringify(input));
    assert.equal(draftLocationAllowsDelete(loc), false, JSON.stringify(input));
  }
});

test('saved-session map indexes every slot server draft id, normalized', () => {
  const map = buildSavedSessionDraftMap([
    { id: 'stash-a', slots: [{ serverDraftId: 'ABC-1' }, { serverDraftId: null }, {}] },
    { id: 'stash-b', slots: [{ serverDraftId: ' def-2 ' }, { serverDraftId: 'abc-1' }] },
    { id: 'stash-c', slots: null },
  ]);
  assert.deepEqual({ ...map }, { 'abc-1': 'stash-a', 'def-2': 'stash-b' });
  assert.equal(savedSessionIdForDraft(map, 'abc-1'), 'stash-a');
  assert.equal(savedSessionIdForDraft(map, 'DEF-2'), 'stash-b');
  assert.equal(savedSessionIdForDraft(map, 'missing'), undefined);
  assert.equal(savedSessionIdForDraft(map, undefined), undefined);
  // Inherited names are never a hit.
  assert.equal(savedSessionIdForDraft(map, 'constructor'), undefined);
  assert.equal(savedSessionIdForDraft(map, '__proto__'), undefined);
  assert.deepEqual({ ...buildSavedSessionDraftMap(undefined) }, {});
});

test('detail screen runs the strict anchor scan for non-local drafts and gates delete on it', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(
    detail,
    /recording\.status === 'draft'\s*\?\s*draftResolved && !draftLocalSlotId\s*:\s*retryPresentation === 'audio_unavailable'/,
  );
  assert.match(detail, /classifyServerDraftLocation\(\{\s*draftResolved,\s*draftLocalSlotId,\s*anchor: localAnchor,\s*\}\)/);
  assert.match(detail, /recordingPermissions\.canDelete && draftLocationAllowsDelete\(draftLocation\)/);
  assert.match(detail, /router\.navigate\('\/record\?showSavedSessions=1' as never\)/);
});

test('cards route saved-session drafts to the Record tab, which reveals the list', async () => {
  const card = await read('src/components/RecordingCard.tsx');
  assert.match(card, /recording\.status === 'draft' && inSavedSession[\s\S]*?showSavedSessions=1/);
  assert.match(card, /prev\.inSavedSession === next\.inSavedSession/);
  const record = await read('app/(app)/(tabs)/record.tsx');
  // The 30-day notice may also reveal the list (unsent-expiry-notice test).
  assert.match(record, /\(!hasUnsavedRecordings \|\| forceShowStashList(?: \|\| expiryNoticeCoversSavedSessions)?\)/);
  assert.match(record, /showSavedSessions !== '1'/);
  assert.match(record, /navigation\.addListener\('blur', \(\) => setForceShowStashList\(false\)\)/);
  const hook = await read('src/hooks/useLocalDraftRecordings.ts');
  // Nested under the draft-list key so every existing invalidation refreshes it.
  assert.match(hook, /queryKey: \['local-drafts', userId, 'saved-sessions'\]/);
});

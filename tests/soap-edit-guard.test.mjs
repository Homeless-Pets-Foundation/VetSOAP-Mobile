// UX-H5 (UI/UX audit 2026-10-21): a SOAP section edit lived only in the
// section's local state, and no back path on the recording detail screen
// guarded it — Back, Android hardware back or an iOS swipe silently threw away
// typed clinical text. The dirty tracker is executed; the .tsx wiring (not
// loadable by loadTs) is fenced by source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const DETAIL = 'app/(app)/(tabs)/recordings/[id].tsx';

test('a section is dirty only while editing AND changed from the saved text', async () => {
  const { isSoapSectionDirty } = await loadTsModule('src/lib/soapEditDirty.ts');
  assert.equal(isSoapSectionDirty(false, 'changed', 'saved'), false, 'not editing');
  assert.equal(isSoapSectionDirty(true, 'saved', 'saved'), false, 'editing, unchanged');
  assert.equal(isSoapSectionDirty(true, 'changed', 'saved'), true);
  assert.equal(isSoapSectionDirty(true, '', null), false, 'null content reads as empty');
  assert.equal(isSoapSectionDirty(true, 'x', undefined), true);
});

test('the tracker reports only any-dirty transitions, across sections', async () => {
  const { createSoapDirtyTracker } = await loadTsModule('src/lib/soapEditDirty.ts');
  const seen = [];
  const t = createSoapDirtyTracker((v) => seen.push(v));
  t.set('subjective', true);
  t.set('subjective', true); // repeated keystroke-level reports: no event
  t.set('plan', true); // still dirty overall: no event
  t.set('subjective', false); // plan still dirty: no event
  assert.equal(t.isDirty(), true);
  t.set('plan', false);
  t.set('plan', false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(t.isDirty(), false);
});

test('SoapNoteView reports dirty transitions upward and clears on unmount', async () => {
  const src = await read('src/components/SoapNoteView.tsx');
  assert.match(src, /onDirtyChange\?: \(dirty: boolean\) => void;/);
  assert.match(src, /const isDirty = isSoapSectionDirty\(isEditing, draft, content\);/);
  assert.match(
    src,
    /React\.useEffect\(\(\) => \{\s*onDirtyChange\(sectionKey, isDirty\);\s*\}, \[isDirty, sectionKey, onDirtyChange\]\);/,
    'keyed on the boolean, not the draft, so it does not fire per keystroke',
  );
  assert.match(src, /React\.useEffect\(\(\) => \(\) => onDirtyChange\(sectionKey, false\)/);
  assert.match(src, /createSoapDirtyTracker\(/);
});

test('the detail screen guards navigation removal with usePreventRemove', async () => {
  const src = await read(DETAIL);
  assert.match(src, /onDirtyChange=\{setSoapEditDirty\}/);
  assert.match(src, /usePreventRemove\(soapEditDirty \|\| soapSaving, \(\{ data \}\) => \{/);
  assert.match(src, /navigation\.dispatch\(data\.action\)/);
});

test('the explicit back control and the attention BackHandler go through the same confirm', async () => {
  const src = await read(DETAIL);
  assert.doesNotMatch(src, /onPress=\{goBack\}/, 'every back button uses guardedGoBack');
  assert.match(src, /onPress=\{guardedGoBack\}/);
  assert.match(src, /const guardedGoBack = useCallback\(\(\) => \{\s*leaveGuarded\(goBack\);/);
  assert.match(
    src,
    /hardwareBackPress', \(\) => \{\s*leaveGuarded\(\(\) => router\.replace\('\/recordings\/attention' as never\)\);\s*return true;/,
    'Android back keeps its route and only gains the guard',
  );
  assert.match(src, /if \(soapEditDirtyRef\.current && !discardingEditsRef\.current\) \{\s*confirmDiscardSoapEdits\(leave\);/);
});

test('a confirmed discard passes the removal guard without a second prompt, and re-arms on focus', async () => {
  const src = await read(DETAIL);
  assert.match(src, /if \(discardingEditsRef\.current\) \{\s*navigation\.dispatch\(data\.action\);\s*return;/);
  assert.match(src, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*discardingEditsRef\.current = false;/);
});

// Codex review on PR #252: Discard while a save is in flight navigated away
// but could not recall the request, so the "discarded" text still persisted.
test('a save in flight blocks every exit instead of offering a discard it cannot honor', async () => {
  const view = await read('src/components/SoapNoteView.tsx');
  assert.match(view, /onSavingChange\?: \(saving: boolean\) => void;/);
  assert.match(
    view,
    /React\.useEffect\(\(\) => \{\s*onSavingChange\(sectionKey, isSaving\);\s*\}, \[isSaving, sectionKey, onSavingChange\]\);/,
  );
  assert.match(view, /React\.useEffect\(\(\) => \(\) => onSavingChange\(sectionKey, false\)/);
  assert.match(view, /onSavingChange=\{handleSectionSaving\}/);

  const src = await read(DETAIL);
  assert.match(src, /onSavingChange=\{setSoapSaving\}/);
  // Checked FIRST on both paths, ahead of the discard confirm and the
  // already-discarding pass-through.
  assert.match(
    src,
    /usePreventRemove\(soapEditDirty \|\| soapSaving, \(\{ data \}\) => \{\s*if \(soapSavingRef\.current\) \{\s*alertSoapStillSaving\(\);\s*return;\s*\}\s*if \(discardingEditsRef\.current\)/,
  );
  assert.match(
    src,
    /\(leave: \(\) => void\) => \{\s*if \(soapSavingRef\.current\) \{\s*alertSoapStillSaving\(\);\s*return;\s*\}\s*if \(soapEditDirtyRef\.current/,
  );
  assert.match(src, /Alert\.alert\(SOAP_EDIT_DISCARD_COPY\.savingTitle, SOAP_EDIT_DISCARD_COPY\.savingBody\)/);
});

test('discard copy lives in the strings catalog', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /export const SOAP_EDIT_DISCARD_COPY = \{/);
  const src = await read(DETAIL);
  assert.match(src, /Alert\.alert\(SOAP_EDIT_DISCARD_COPY\.title, SOAP_EDIT_DISCARD_COPY\.body/);
});

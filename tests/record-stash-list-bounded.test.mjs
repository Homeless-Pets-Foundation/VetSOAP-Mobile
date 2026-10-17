import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The Saved Sessions list renders above the patient pager, and the pager
// (`flex: 1`) only gets the height left over. Unbounded, four saved sessions
// on a Galaxy Tab A7 Lite (800x1340) left the pager ~10px and hid the Record
// button (tablet test 2026-10-16). Structural fence: the list must scroll
// inside a bounded share of the window.

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('saved sessions scroll inside a bounded share of the window', async () => {
  const record = stripComments(await read('app/(app)/(tabs)/record.tsx'));

  const ratio = record.match(/const STASH_LIST_MAX_HEIGHT_RATIO = ([0-9.]+);/);
  assert.ok(ratio, 'STASH_LIST_MAX_HEIGHT_RATIO must be defined');
  const value = Number(ratio[1]);
  assert.ok(value > 0 && value <= 0.4, `ratio ${value} must leave the pager most of the screen`);

  assert.match(record, /const \{ width: screenWidth, height: windowHeight \} = useWindowDimensions\(\);/);

  const start = record.indexOf('{showStashList && (');
  assert.notEqual(start, -1, 'saved sessions block not found');
  const block = record.slice(start, record.indexOf('{showOverlay && uploadOverlayHidden && ('));

  assert.match(block, /<ScrollView[\s\S]*?maxHeight: windowHeight \* STASH_LIST_MAX_HEIGHT_RATIO/);
  assert.match(block, /nestedScrollEnabled/);
  // The cards render inside the bounded ScrollView, not beside it.
  const scroll = block.slice(block.indexOf('<ScrollView'), block.indexOf('</ScrollView>'));
  assert.match(scroll, /stashes\.map\(\(stash\) => \(\s*<StashedSessionCard/);
  assert.equal((block.match(/<StashedSessionCard/g) ?? []).length, 1);
});

test('the patient pager keeps the remaining height', async () => {
  const record = stripComments(await read('app/(app)/(tabs)/record.tsx'));
  const pager = record.slice(record.indexOf('<FlatList\n        ref={pagerRef}'));
  assert.match(pager.slice(0, 800), /style=\{\{ flex: 1 \}\}/);
});

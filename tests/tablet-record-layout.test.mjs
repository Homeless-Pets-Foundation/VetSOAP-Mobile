// Record screen on tablets. The "portrait lock" the layout assumed doesn't
// hold: iPad gets every orientation + Split View (Expo adds them whenever
// supportsTablet is set), and Android 16 ignores orientation locks on
// sw>=600dp for targetSdk 36. Two consequences are fenced here:
//  1. After a width change the horizontal patient pager kept its old pixel
//     offset and could rest between two patients — a vet could type into the
//     wrong patient's form. It must snap to the active page.
//  2. The Record content stretched edge to edge (800–1366dp) while every
//     other tab is centered at CONTENT_MAX_WIDTH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('the patient pager re-aligns to the active page when the width changes', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  const m = src.match(/const pagerWidthRef = useRef\(screenWidth\);[\s\S]*?\}, \[screenWidth\]\);/);
  assert.ok(m, 'a width-keyed pager effect exists');
  assert.match(m[0], /scrollToOffset\(\{\s*offset: sessionRef\.current\.activeIndex \* screenWidth,\s*animated: false,/);
});

test('pager pages stay full-width so paging math holds', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /length: screenWidth,\s*offset: screenWidth \* index,/);
});

test('Record header/banners/tab strip and slot content use the content column', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(record, /const RECORD_COLUMN_STYLE = \{[\s\S]*?maxWidth: CONTENT_MAX_WIDTH \+ 40,[\s\S]*?\} as const;/);
  assert.match(record, /<View style=\{RECORD_COLUMN_STYLE\}>/);
  const card = await read('src/components/PatientSlotCard.tsx');
  assert.match(card, /contentContainerStyle=\{\{[\s\S]*?maxWidth: CONTENT_MAX_WIDTH \+ 40,[\s\S]*?alignSelf: 'center',/);
  const panel = await read('src/components/SubmitPanel.tsx');
  assert.match(panel, /maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center'/);
});

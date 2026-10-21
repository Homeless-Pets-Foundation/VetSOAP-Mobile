// After Finish, nothing is sent or processed until Submit. The shipped screen
// said the opposite: a green "Recording Complete" badge, a primary-large
// "Continue Recording" competing with Submit, and a "syncing to server…"
// banner that read as auto-upload + processing (UX-H6, 2026-10-21 audit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('a stopped, unsubmitted slot is badged amber "Not Submitted", not green "complete"', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  assert.doesNotMatch(card, /<Badge variant="success">Recording Complete<\/Badge>/);
  assert.match(
    card,
    /slot\.uploadStatus === 'success' \? \(\s*<Badge variant="success">Submitted<\/Badge>\s*\) : \(\s*<Badge variant="warning">Not Submitted<\/Badge>\s*\)/,
  );
});

test('Continue Recording after Finish is secondary, leaving Submit the one primary action', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  // The post-Finish buttons put the label on its own line; the paused-elsewhere
  // one-liner (where Continue IS the main action) is deliberately not matched.
  const stoppedContinue = card.match(/<Button [^\n]*onPress=\{handleContinueRecording\}[^\n]*\n\s*Continue Recording\n/g) ?? [];
  assert.equal(stoppedContinue.length, 2, 'the segment and durable post-Finish branches');
  for (const b of stoppedContinue) {
    assert.match(b, /variant="secondary"/);
    assert.doesNotMatch(b, /size="lg"/);
  }
  assert.match(card, /Submit & Generate SOAP Note/);
});

test('the pending-draft banner says "not submitted", never "syncing"', async () => {
  const strings = await read('src/constants/strings.ts');
  const block = strings.slice(strings.indexOf('export const RECORD_BANNERS'));
  const online = block.match(/pendingDraftOnline: '([^']*)'/)?.[1] ?? '';
  const offline = block.match(/pendingDraftOffline: '([^']*)'/)?.[1] ?? '';
  for (const line of [online, offline]) {
    assert.match(line, /not submitted/i);
    assert.doesNotMatch(line, /sync/i);
  }
});

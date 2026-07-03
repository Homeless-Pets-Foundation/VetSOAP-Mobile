import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('recording detail passes server duration into player fallback without enabling scrub early', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(
    detail,
    /<RecordingAudioPlayer[\s\S]*?recordingId=\{id\}[\s\S]*?initialDurationSeconds=\{recording\.audioDurationSeconds\}[\s\S]*?\/>/
  );
  assert.match(player, /initialDurationSeconds\?: number \| null/);
  assert.match(player, /const sanitizedInitialDuration =/);
  assert.match(player, /const displayDuration = duration > 0 \? duration : sanitizedInitialDuration/);
  assert.match(player, /if \(!enabled\) return;/);

  const seekBarBlock = player.match(/<SeekBar[\s\S]*?\/>/);
  assert.ok(seekBarBlock, 'SeekBar render should exist');
  assert.match(seekBarBlock[0], /duration=\{displayDuration\}/);
  assert.match(seekBarBlock[0], /enabled=\{phase === 'ready'\}/);
});

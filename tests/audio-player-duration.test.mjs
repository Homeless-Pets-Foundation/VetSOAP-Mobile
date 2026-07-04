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
  assert.match(player, /const canSeek = phase === 'ready' && duration > 0/);
  assert.match(player, /if \(!enabled\) return;/);

  const seekBarBlock = player.match(/<SeekBar[\s\S]*?\/>/);
  assert.ok(seekBarBlock, 'SeekBar render should exist');
  assert.match(seekBarBlock[0], /duration=\{displayDuration\}/);
  assert.match(seekBarBlock[0], /enabled=\{canSeek\}/);
  assert.match(player, /disabled=\{!canSeek\}/);
});

test('skip seek updates paused UI state before native seek resolves', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');
  const match = player.match(/const handleSeek = useCallback\([\s\S]*?\n  \);/);
  assert.ok(match, 'handleSeek callback should exist');
  const block = match[0];

  assert.match(block, /if \(phase !== 'ready' \|\| duration <= 0\) return/);
  assert.match(block, /const target = Math\.min\(duration, Math\.max\(0, \(currentTimeRef\.current \?\? 0\) \+ deltaSeconds\)\)/);
  assert.match(block, /setDisplayTime\(target\)/);
  assert.match(block, /currentTimeSV\.value = target/);
  assert.match(block, /currentTimeRef\.current = target/);
  assert.match(block, /playback\.seekTo\(target\)\.catch\(\(\) => \{\}\)/);
});

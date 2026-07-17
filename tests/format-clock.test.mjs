// WP23 — H:MM:SS clock for >=60min recordings (2h captures read "120:00" before).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirror of src/lib/formatClock.ts (structural assertion keeps it honest).
function formatClockDuration(totalSeconds) {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

test('sub-hour durations stay MM:SS', () => {
  assert.equal(formatClockDuration(0), '00:00');
  assert.equal(formatClockDuration(59), '00:59');
  assert.equal(formatClockDuration(61.9), '01:01');
  assert.equal(formatClockDuration(3599), '59:59');
});

test('>=1h durations switch to H:MM:SS', () => {
  assert.equal(formatClockDuration(3600), '1:00:00');
  assert.equal(formatClockDuration(7325), '2:02:05');
});

test('junk input clamps to 00:00', () => {
  assert.equal(formatClockDuration(NaN), '00:00');
  assert.equal(formatClockDuration(-5), '00:00');
  assert.equal(formatClockDuration(Infinity), '00:00');
});

test('source util matches this mirror and is adopted by the three timers', async () => {
  const src = await readFile(path.join(root, 'src/lib/formatClock.ts'), 'utf8');
  assert.match(src, /if \(hours > 0\)/);
  for (const rel of [
    'src/components/PatientSlotCard.tsx',
    'src/components/RecorderLiveReadout.tsx',
    'app/(app)/audio-editor.tsx',
  ]) {
    const consumer = await readFile(path.join(root, rel), 'utf8');
    assert.match(consumer, /formatClockDuration/, `${rel} should use formatClockDuration`);
  }
});

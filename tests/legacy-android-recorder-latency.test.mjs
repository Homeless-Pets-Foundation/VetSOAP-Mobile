import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('legacy recorder times latency phases and prepares service binding concurrently', async () => {
  const [record, recorder, patch] = await Promise.all([
    read('app/(app)/(tabs)/record.tsx'),
    read('src/hooks/useAudioRecorder.ts'),
    read('patches/expo-audio+55.0.16.patch'),
  ]);

  assert.match(record, /measurePhase\('record_floor_hydration', undefined, async \(\) => \{\s*await ensureFloorHydrated\(\);\s*\}, \{ warningThresholdMs: null \}/);
  for (const phase of ['recorder_audio_prepare', 'recorder_native_start', 'recorder_native_pause', 'recorder_native_resume']) {
    assert.match(recorder, new RegExp(`measurePhase\\('${phase}'`), phase);
  }
  assert.equal((recorder.match(/warningThresholdMs: NATIVE_RECORDER_PHASE_WARNING_MS/g) ?? []).length, 4);

  const bind = patch.indexOf('async(start = CoroutineStart.UNDISPATCHED) { serviceConnection.bindWithService() }');
  const prepare = patch.indexOf('mediaRecorder.prepare()');
  const awaitBind = patch.indexOf('serviceBinding?.await()');
  const prepared = patch.indexOf('isPrepared = true');
  assert.ok(bind >= 0 && bind < prepare && prepare < awaitBind && awaitBind < prepared);
  assert.match(patch, /coroutineScope \{/);
  assert.match(patch, /isPrepared = true\s+\} catch \(e: Exception\) \{\s+mediaRecorder\.release\(\)/);
});

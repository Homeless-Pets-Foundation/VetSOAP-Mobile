import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('legacy recorder times latency phases and ships concurrent service binding', async () => {
  const [record, recorder, audioRecorder, audioModule, serviceConnection] = await Promise.all([
    read('app/(app)/(tabs)/record.tsx'),
    read('src/hooks/useAudioRecorder.ts'),
    read('node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioRecorder.kt'),
    read('node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt'),
    read('node_modules/expo-audio/android/src/main/java/expo/modules/audio/service/AudioRecordingServiceConnection.kt'),
  ]);

  assert.match(record, /measurePhase\('record_floor_hydration', undefined, async \(\) => \{\s*await ensureFloorHydrated\(\);\s*\}, \{ warningThresholdMs: null \}/);
  // `recorder_durable_start` observes the native durable start() the same way
  // (a >1 s start on a legacy device is what prod should page on); the count
  // below is one per measured native phase.
  for (const phase of ['recorder_audio_prepare', 'recorder_native_start', 'recorder_native_pause', 'recorder_native_resume', 'recorder_durable_start']) {
    assert.match(recorder, new RegExp(`measurePhase\\('${phase}'`), phase);
  }
  assert.equal((recorder.match(/warningThresholdMs: NATIVE_RECORDER_PHASE_WARNING_MS/g) ?? []).length, 5);

  const bind = audioRecorder.indexOf('async(start = CoroutineStart.UNDISPATCHED) { serviceConnection.bindWithService() }');
  const prepare = audioRecorder.indexOf('mediaRecorder.prepare()');
  const awaitBind = audioRecorder.indexOf('serviceBinding?.await()');
  const prepared = audioRecorder.indexOf('isPrepared = true');
  assert.ok(bind >= 0 && bind < prepare && prepare < awaitBind && awaitBind < prepared);
  assert.match(audioRecorder, /coroutineScope \{/);
  assert.match(audioRecorder, /isPrepared = true\s+\} catch \(e: Exception\) \{\s+mediaRecorder\.release\(\)/);
  assert.match(audioModule, /AsyncFunction\("prepareToRecordAsync"\) Coroutine \{[\s\S]*recorder\.prepareRecording\(options\)/);
  assert.doesNotMatch(audioModule.slice(audioModule.indexOf('AsyncFunction("prepareToRecordAsync")'), audioModule.indexOf('Function("record")')), /runOnQueue\(Queues\.MAIN\)/);
  const binder = serviceConnection.indexOf('recordingServiceBinder = serviceBinder');
  const appContext = serviceConnection.indexOf('serviceBinder.service.appContext = appContext');
  const resume = serviceConnection.indexOf('bindingContinuation?.resume(Unit)');
  assert.ok(binder >= 0 && binder < appContext && appContext < resume);
});

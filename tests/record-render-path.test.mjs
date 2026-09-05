/**
 * Record-screen render-path fences (older-Android responsiveness).
 *
 * Symptom these pin: a stuttering elapsed-time counter and late-arriving
 * controls on low-end Android tablets while a recording is live. Each
 * assertion names the regression it prevents:
 *
 *  - The live waveform used to fan ONE metering sample into 24–36 per-bar
 *    `withTiming` animations on `height` (a layout prop → a Yoga relayout every
 *    animation frame) via React state at 4 Hz. Bars now derive their scale from
 *    ONE SharedValue inside `useAnimatedStyle` on the UI thread, and React only
 *    commits once per second for the timer text.
 *  - `useAudioRecorder` used to `setState` two values nobody read on every
 *    durable commit tick (2 s), re-rendering the 7k-line record screen.
 *  - The hook returned a fresh object every render, so `React.memo` on the
 *    1,000-line slot card never short-circuited.
 *  - The readout polled a synchronous native `getStatus()` 4×/s on top of the
 *    hook's own 500 ms sampler.
 *  - `useNetInfo()` re-rendered the whole screen on every connectivity detail
 *    change although only `isConnected` is read.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('waveform bars derive their scale from one SharedValue on the UI thread', async () => {
  const waveform = await read('src/components/AudioWaveform.tsx');
  assert.match(waveform, /export const AudioWaveform = React\.memo\(function AudioWaveform/);
  assert.match(waveform, /level\?: SharedValue<number>/);
  assert.doesNotMatch(waveform, /metering\?: number/);
  assert.doesNotMatch(waveform, /targetHeight/);

  const barStart = waveform.indexOf('const WaveBar = React.memo(');
  const barEnd = waveform.indexOf('function BreathingRing(');
  assert.ok(barStart > 0 && barEnd > barStart, 'WaveBar / BreathingRing not found');
  const bar = waveform.slice(barStart, barEnd);
  assert.doesNotMatch(bar, /useEffect\(/, 'bars must not run a per-sample effect');
  assert.match(bar, /useAnimatedStyle\(\(\) => \(\{\s*transform: \[\{ scaleY:[\s\S]*?level\.value/);
  assert.doesNotMatch(bar, /withTiming\(/, 'bars must not start their own animations');
  assert.doesNotMatch(bar, /height: height\.value/, 'bars must not animate layout');
  // The glow stays on the container: iOS draws legacy shadows from content
  // alpha, so moving it to an empty sibling silently removed it there.
  assert.match(waveform, /\$\{live \? 'shadow-glow' : ''\}/);
});

test('readout drives the waveform through a SharedValue and re-renders only for the timer', async () => {
  const readout = await read('src/components/RecorderLiveReadout.tsx');
  assert.match(readout, /const level = useSharedValue\(0\)/);
  assert.match(readout, /level\.value = withTiming\(normalizeMeteringDb\(next\.meteringDb\)/);
  assert.match(readout, /setDurationSeconds\(\(prev\) =>\s*\(?\s*prev === next\.durationSeconds \? prev : next\.durationSeconds/);
  assert.doesNotMatch(readout, /meteringDb === next\.meteringDb/);
  assert.doesNotMatch(readout, /setStats\(/);
  assert.match(readout, /<AudioWaveform[\s\S]*?level=\{level\}/);
  assert.match(readout, /formatClockDuration/);
});

test('normalizeMeteringDb maps the metering range to 0..1 and fails closed', async () => {
  const mod = await loadTsModule('src/lib/metering.ts', {});
  assert.equal(mod.normalizeMeteringDb(-160), 0);
  assert.equal(mod.normalizeMeteringDb(-60), 0);
  assert.equal(mod.normalizeMeteringDb(0), 1);
  assert.equal(mod.normalizeMeteringDb(20), 1);
  assert.equal(mod.normalizeMeteringDb(-30), 0.5);
  assert.equal(mod.normalizeMeteringDb(Number.NaN), 0);
  assert.equal(mod.normalizeMeteringDb(undefined), 0);
});

test('useAudioRecorder keeps durable commit progress in refs and returns a memoized object', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  assert.doesNotMatch(hook, /setCommittedThroughMs|setCompleteFrameBytes/);
  assert.match(hook, /committedThroughMsRef\.current = e\.committedThroughMs;/);
  assert.match(hook, /completeFrameBytesRef\.current = e\.completeFrameBytes;/);
  assert.match(hook, /getCommitSnapshot/);
  assert.match(hook, /return useMemo<UseAudioRecorderReturn>\(/);
  assert.match(hook, /const getPersistableSnapshot = useCallback\(/);
  // The 500 ms / 2000 ms sampler cadence is rule 6 and must survive.
  assert.match(hook, /appActiveRef\.current \? 500 : 2000/);

  // The readout's 250 ms poll must read the hook's cached sample, not hit the
  // synchronous native bridge a second time.
  const liveStart = hook.indexOf('const getLiveStats = useCallback(');
  const liveEnd = hook.indexOf('const resetDurableState = useCallback(');
  assert.ok(liveStart > 0 && liveEnd > liveStart, 'getLiveStats not found');
  const live = hook.slice(liveStart, liveEnd);
  assert.doesNotMatch(live, /getNativeDurationSeconds\(\)/);
  assert.match(live, /getPolledDurationSeconds\(\)/);
  assert.match(hook, /const getPolledDurationSeconds = useCallback\(/);
  // The polled sample is dropped at every expo start: the readout's first
  // tick runs before the sampler effect, so a stale sample would show the
  // previous segment's duration for one tick.
  assert.match(hook, /lastStatusRef\.current = null;\s*startElapsedClock\(\);/);
});

test('record.tsx and PatientSlotCard exchange primitives, not the recorder object', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  assert.doesNotMatch(record, /recorder=\{recorder\}/);
  assert.match(record, /recorderState=\{isRecorderOwner \? recorder\.state : 'idle'\}/);
  assert.match(record, /recorderDuration=\{isRecorderOwner \? recorder\.duration : 0\}/);
  assert.match(record, /getLiveStats=\{recorder\.getLiveStats\}/);
  assert.doesNotMatch(record, /recorder\.(committedThroughMs|completeFrameBytes|lastCommitAt)\b/);

  assert.match(card, /recorderState: RecordingState/);
  assert.match(card, /recorderDuration: number/);
  assert.doesNotMatch(card, /recorder: UseAudioRecorderReturn/);
  assert.doesNotMatch(card, /\brecorder\./);

  // Hot control rows: no mount animation between native start and the
  // pause/finish buttons appearing.
  const controls = card.slice(card.indexOf('{/* Controls */}'), card.indexOf('{/* Paused but not recorder owner'));
  assert.ok(controls.length > 0, 'control region not found');
  assert.doesNotMatch(controls, /entering=/);
});

test('record.tsx subscribes to connectivity through isConnected only', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.doesNotMatch(record, /import NetInfo, \{ useNetInfo \}/);
  assert.doesNotMatch(record, /= useNetInfo\(/);
  // The ref stays a component-level useRef so exhaustive-deps keeps treating
  // it as stable inside the pinned upload callbacks (a ref returned from a
  // custom hook is opaque to the rule and re-introduces a lint warning).
  assert.match(record, /const netInfoRef = useRef<NetInfoState \| null>\(null\);\s*const isConnected = useConnectivity\(netInfoRef\);/);

  const hook = await read('src/hooks/useConnectivity.ts');
  assert.match(hook, /NetInfo\.addEventListener\(/);
  assert.match(hook, /if \(mirrorRef\) mirrorRef\.current = next;/);
  assert.match(hook, /prev === next\.isConnected \? prev : next\.isConnected/);
});

test('useResponsive returns a referentially stable object', async () => {
  const responsive = await read('src/hooks/useResponsive.ts');
  assert.match(responsive, /return useMemo\(/);
});

test('blurred non-record tabs freeze; the record tab and the stack never do', async () => {
  const layout = await read('app/(app)/(tabs)/_layout.tsx');
  const screen = (name) => {
    const start = layout.indexOf(`name="${name}"`);
    assert.ok(start > 0, `Tabs.Screen ${name} not found`);
    const end = layout.indexOf('<Tabs.Screen', start + 1);
    return layout.slice(start, end === -1 ? undefined : end);
  };
  for (const name of ['index', 'patient']) {
    assert.match(screen(name), /freezeOnBlur: true/, `${name} must freeze on blur`);
  }
  assert.doesNotMatch(screen('record'), /freezeOnBlur/);
  // The recordings tab hosts RecordingAudioPlayer. Freezing it makes the
  // recordingActivity update unrenderable, so the native player is never
  // released and playback continues under a live recorder (Codex round 20).
  assert.doesNotMatch(screen('recordings'), /freezeOnBlur/);
  const screenOptions = layout.slice(layout.indexOf('screenOptions={{'), layout.indexOf('screenListeners='));
  assert.doesNotMatch(screenOptions, /freezeOnBlur/);

  for (const rel of ['app/_layout.tsx', 'app/(app)/_layout.tsx', layout]) {
    const src = rel === layout ? layout : await read(rel);
    assert.doesNotMatch(src, /enableFreeze\(/);
  }
});

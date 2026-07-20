import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('recording detail duration enables single-part idle positioning without autoplay', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(
    detail,
    /<RecordingAudioPlayer[\s\S]*?recordingId=\{id\}[\s\S]*?initialDurationSeconds=\{recording\.audioDurationSeconds\}[\s\S]*?\/>/
  );
  assert.match(player, /initialDurationSeconds\?: number \| null/);
  assert.match(player, /const sanitizedInitialDuration =/);
  assert.match(player, /const displayDuration = duration > 0 \? duration : sanitizedInitialDuration/);
  assert.match(
    player,
    /const canSeek =\s*\(phase === 'idle' && sanitizedInitialDuration > 0\) \|\|\s*\(phase === 'ready' && duration > 0\)/
  );

  const coordinator = player.match(/const coordinateSeek = useCallback\([\s\S]*?\n  \);/);
  assert.ok(coordinator, 'one seek coordinator should exist');
  assert.match(coordinator[0], /phase === 'idle'\s*\? sanitizedInitialDuration/);
  assert.match(coordinator[0], /pendingSeekRef\.current = request/);
  assert.match(coordinator[0], /pendingPlayRef\.current = false/);
  assert.match(coordinator[0], /startLoadingAudio\(\)/);
  assert.match(coordinator[0], /commitSeek\(request\)\.catch\(\(\) => \{\}\)/);
});

test('multi-part discovery cancels an unmappable total-duration idle seek', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  const startLoading = player.match(/const startLoadingAudio = useCallback\([\s\S]*?\n  \);/);
  assert.ok(startLoading, 'audio loading coordinator should exist');
  assert.match(startLoading[0], /result\.segmentUrls\.length > 1 && pendingSeekRef\.current/);
  assert.match(startLoading[0], /pendingSeekRef\.current = null/);
  assert.match(startLoading[0], /currentTimeSV\.value = 0/);
  assert.match(startLoading[0], /setDisplayTime\(0\)/);

  const clearIndex = startLoading[0].indexOf('pendingSeekRef.current = null');
  const loadIndex = startLoading[0].indexOf('loadSegment(result.segmentUrls, 0)');
  assert.ok(clearIndex < loadIndex, 'multi-part total seek must be cleared before part 1 loads');
  assert.match(player, /segmentUrls\.length > 1 && \(/);
});

test('audio hook returns native-duration-clamped seek position and rejects failures', async () => {
  const hook = await read('src/hooks/useAudioPlayback.ts');

  assert.match(hook, /seekTo: \(seconds: number\) => Promise<number>/);
  const seek = hook.match(/const seekTo = useCallback\([\s\S]*?\n  \);/);
  assert.ok(seek, 'seekTo callback should exist');
  assert.match(seek[0], /const clamped = Math\.max\(0, Math\.min\(seconds, durationRef\.current \|\| 0\)\)/);
  assert.match(seek[0], /await player\.seekTo\(clamped\)/);
  assert.match(seek[0], /currentTimeRef\.current = clamped/);
  assert.match(seek[0], /return clamped/);
  assert.match(seek[0], /throw error/);
});

test('idle seek fetches once, survives loading, and clears on every failure path', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(player, /const pendingSeekRef = useRef<PendingSeek \| null>\(null\)/);
  assert.match(player, /if \(loadRequestInFlightRef\.current\) return/);
  assert.match(player, /loadRequestInFlightRef\.current = true/);
  assert.match(player, /const pendingSeek = pendingSeekRef\.current/);
  assert.match(player, /commitSeek\(pendingSeek\)/);
  assert.match(player, /\.catch\(\(\) => failPlayback\('seek_failed'\)\)/);

  const failure = player.match(/const failPlayback = useCallback\([\s\S]*?\n  \);/);
  assert.ok(failure, 'playback failure handler should exist');
  assert.match(failure[0], /pendingPlayRef\.current = false/);
  assert.match(failure[0], /pendingSeekRef\.current = null/);
  assert.match(failure[0], /loadRequestInFlightRef\.current = false/);

  const commit = player.match(/const commitSeek = useCallback\([\s\S]*?\n  \);/);
  assert.ok(commit, 'native seek commit should exist');
  assert.match(commit[0], /pendingSeekRef\.current = null/);
  assert.match(commit[0], /const restored = currentTimeRef\.current \?\? 0/);
  assert.match(commit[0], /throw error/);
});

test('every segment source swap resets its handled-load guard synchronously', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  const loadSegmentStart = player.indexOf('const loadSegment = useCallback');
  const startLoadingStart = player.indexOf('const startLoadingAudio = useCallback');
  assert.notEqual(loadSegmentStart, -1, 'segment loader should exist');
  assert.notEqual(startLoadingStart, -1, 'loading coordinator should follow segment loader');

  const loadSegment = player.slice(loadSegmentStart, startLoadingStart);
  assert.match(loadSegment, /loadedStatusHandledRef\.current = false/);
  assert.match(loadSegment, /await loadSource\(uri\)/);
  assert.ok(
    loadSegment.indexOf('loadedStatusHandledRef.current = false') <
      loadSegment.indexOf('await loadSource(uri)'),
    'handled-load guard must reset before native source replacement'
  );
});

test('timeline is full width and races tap against a 6dp horizontal pan', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(player, /\.activeOffsetX\(\[-6, 6\]\)/);
  assert.match(player, /\.failOffsetY\(\[-12, 12\]\)/);
  assert.match(player, /\.maxDistance\(6\)/);
  assert.match(player, /Gesture\.Race\(pan, tap\)/);
  assert.match(player, /<View className="w-full">/);
  assert.doesNotMatch(player, /className="flex-1 ml-3"/);

  const render = player.slice(player.indexOf("      ) : ("), player.indexOf('{segmentUrls.length > 1'));
  const seekBarIndex = render.indexOf('<SeekBar');
  const controlsIndex = render.indexOf('<View className="flex-row items-center justify-center mt-2">');
  assert.notEqual(seekBarIndex, -1, 'full-width timeline should render');
  assert.notEqual(controlsIndex, -1, 'separate controls row should render');
  assert.ok(seekBarIndex < controlsIndex, 'timeline should be outside and above the controls row');
});

test('tap, drag, skip, and accessibility actions share the seek coordinator', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(player, /onSeekTo\(target\)/);
  assert.match(player, /coordinateSeek\(seconds\)/);
  assert.match(player, /coordinateSeek\(seconds, resumeAfterSeek\)/);
  assert.match(player, /coordinateSeek\(target\)/);
  assert.match(player, /onPress=\{\(\) => handleSeek\(-SEEK_STEP_SECONDS\)\}/);
  assert.match(player, /onPress=\{\(\) => handleSeek\(SEEK_STEP_SECONDS\)\}/);
  assert.match(player, /accessibilityLabel="Rewind 15 seconds"/);
  assert.match(player, /accessibilityLabel="Skip ahead 15 seconds"/);
  assert.match(player, /accessibilityRole="adjustable"/);
  assert.match(player, /accessibilityActions=\{\[\{ name: 'increment' \}, \{ name: 'decrement' \}\]\}/);
});

test('scrubbing resumes only after a successful non-EOF native seek', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');
  const commit = player.match(/const commitSeek = useCallback\([\s\S]*?\n  \);/);
  assert.ok(commit, 'native seek commit should exist');

  assert.match(commit[0], /const landed = await seekTo\(request\.seconds\)/);
  assert.match(commit[0], /request\.resumeAfterSeek/);
  assert.match(commit[0], /landed >= duration - 0\.05/);
  assert.match(commit[0], /play\(\)/);
  assert.doesNotMatch(commit[0], /\.finally\(/);

  const scrubStart = player.match(/const handleScrubStart = useCallback\([\s\S]*?\n  \);/);
  assert.ok(scrubStart, 'scrub start should exist');
  assert.match(scrubStart[0], /wasPlayingBeforeScrubRef\.current = isPlaying/);
  assert.match(scrubStart[0], /if \(isPlaying\) pause\(\)/);

  const coordinator = player.match(/const coordinateSeek = useCallback\([\s\S]*?\n  \);/);
  assert.ok(coordinator, 'seek coordinator should exist');
  assert.match(coordinator[0], /setDisplayTime\(target\)/);
  assert.match(coordinator[0], /currentTimeSV\.value = target/);
  assert.doesNotMatch(coordinator[0], /currentTimeRef\.current = target/);
});

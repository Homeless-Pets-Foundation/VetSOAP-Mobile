import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const { getRecordingRetryPresentation } = await loadTsModule(
  'src/lib/recordingRetryState.ts',
);

for (const status of ['failed', 'retry_scheduled']) {
  test(`${status} offers Retry only while audio exists`, () => {
    assert.equal(
      getRecordingRetryPresentation({
        status,
        audioFileUrl: 'recordings/example/audio.m4a',
        isPollingStale: false,
        audioMissingError: false,
      }),
      'retry',
    );
    assert.equal(
      getRecordingRetryPresentation({
        status,
        audioFileUrl: null,
        isPollingStale: false,
        audioMissingError: false,
      }),
      'audio_unavailable',
    );
  });
}

test('stale processing offers Retry with audio and Start New Recording without it', () => {
  assert.equal(
    getRecordingRetryPresentation({
      status: 'generating',
      audioFileUrl: 'recordings/example/audio.m4a',
      isPollingStale: true,
      audioMissingError: false,
    }),
    'retry',
  );
  assert.equal(
    getRecordingRetryPresentation({
      status: 'generating',
      audioFileUrl: null,
      isPollingStale: true,
      audioMissingError: false,
    }),
    'audio_unavailable',
  );
});

test('typed missing-audio race overrides a stale cached audio URL', () => {
  assert.equal(
    getRecordingRetryPresentation({
      status: 'failed',
      audioFileUrl: 'recordings/example/audio.m4a',
      isPollingStale: false,
      audioMissingError: true,
    }),
    'audio_unavailable',
  );
});

test('non-retry state stays hidden even without audio', () => {
  assert.equal(
    getRecordingRetryPresentation({
      status: 'completed',
      audioFileUrl: null,
      isPollingStale: false,
      audioMissingError: false,
    }),
    'hidden',
  );
});

test('detail retry handles only the typed 409 as expected and renders the non-retry action', async () => {
  const root = new URL('../', import.meta.url);
  const [api, detail] = await Promise.all([
    readFile(new URL('src/api/recordings.ts', root), 'utf8'),
    readFile(new URL('app/(app)/(tabs)/recordings/[id].tsx', root), 'utf8'),
  ]);
  assert.match(
    api,
    /error instanceof ApiError &&\s*error\.status === 409 &&\s*error\.code === RECORDING_AUDIO_MISSING_CODE/,
  );
  const reviewMutation = detail.slice(
    detail.indexOf('const reviewMutation = useMutation({'),
    detail.indexOf('const retryMutation = useMutation({'),
  );
  const retryMutation = detail.slice(
    detail.indexOf('const retryMutation = useMutation({'),
    detail.indexOf('const regenerateMutation = useMutation({'),
  );
  assert.doesNotMatch(reviewMutation, /isRecordingAudioMissingError/);
  assert.match(retryMutation, /if \(isRecordingAudioMissingError\(error\)\) \{/);
  assert.match(retryMutation, /setRetryAudioMissing\(true\)/);
  assert.match(retryMutation, /onSuccess:[\s\S]*setRetryAudioMissing\(false\)/);
  assert.match(detail, /Audio unavailable/);
  assert.match(detail, /Start New Recording/);
  const routeResetEffect = detail.slice(
    detail.indexOf('useEffect(() => {', detail.indexOf('const [retryAudioMissing')),
    detail.indexOf('// Completion celebration'),
  );
  assert.match(routeResetEffect, /pollingStartedAtRef\.current = null/);
  assert.match(
    detail,
    /!!recording\.audioFileUrl &&\s*retryPresentation !== 'audio_unavailable' &&\s*aiModels/,
  );
  const expectedBranch = retryMutation.slice(
    retryMutation.indexOf('if (isRecordingAudioMissingError(error))'),
    retryMutation.indexOf("if (error instanceof ApiError && error.code === 'MFA_REQUIRED')"),
  );
  assert.doesNotMatch(expectedBranch, /captureException|reportClientError/);
});

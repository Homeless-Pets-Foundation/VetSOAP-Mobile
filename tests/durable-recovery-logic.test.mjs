import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const MOD = 'src/lib/durableAudio/recoveryLogic.ts';

function m(over = {}) {
  return {
    schemaVersion: 3,
    recordingId: 'rec1',
    userId: 'user1',
    slotId: 'slot1',
    state: 'stopped',
    startedAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:01:00.000Z',
    container: 'adts',
    codec: 'aac_lc',
    bitrate: 48000,
    sampleRate: 16000,
    channels: 1,
    adtsFrameCount: 50,
    durationMs: 3200,
    capturedDurationMs: 3200,
    audioFile: { uri: 'file:///a.aac', committedBytes: 100, completeFrameBytes: 90 },
    peakDb: -10,
    appVersion: '1.0.0',
    buildNumber: '1',
    ...over,
  };
}

const EMPTY = new Set();

test('offers a clean recoverable recording', async () => {
  const { selectRecoverableSessions } = await loadTsModule(MOD);
  const r = selectRecoverableSessions({ manifests: [m()], draftRecordingIds: EMPTY, stashRecordingIds: EMPTY });
  assert.equal(r.offer.length, 1);
  assert.equal(r.selfHeal.length, 0);
  assert.equal(r.suppressed.length, 0);
});

test('confirmed-uploaded -> selfHeal, never offered', async () => {
  const { selectRecoverableSessions } = await loadTsModule(MOD);
  const r = selectRecoverableSessions({
    manifests: [m({ state: 'uploaded', confirmedUploadAt: 'x' }), m({ recordingId: 'rec2', confirmedUploadAt: 'y' })],
    draftRecordingIds: EMPTY,
    stashRecordingIds: EMPTY,
  });
  assert.equal(r.offer.length, 0);
  assert.equal(r.selfHeal.length, 2);
});

test('suppressed when referenced by a draft OR a stash (by recordingId)', async () => {
  const { selectRecoverableSessions } = await loadTsModule(MOD);
  const r = selectRecoverableSessions({
    manifests: [m({ recordingId: 'd1' }), m({ recordingId: 's1' }), m({ recordingId: 'free' })],
    draftRecordingIds: new Set(['d1']),
    stashRecordingIds: new Set(['s1']),
  });
  assert.equal(r.offer.map((x) => x.recordingId).join(','), 'free');
  assert.equal(r.suppressed.length, 2);
});

test('idle / zero-frame manifests are neither offered nor suppressed', async () => {
  const { selectRecoverableSessions } = await loadTsModule(MOD);
  const r = selectRecoverableSessions({
    manifests: [m({ state: 'idle' }), m({ recordingId: 'z', adtsFrameCount: 0 })],
    draftRecordingIds: EMPTY,
    stashRecordingIds: EMPTY,
  });
  assert.equal(r.offer.length, 0);
  assert.equal(r.suppressed.length, 0);
  assert.equal(r.selfHeal.length, 0);
});

test('offer sorted by updatedAt desc', async () => {
  const { selectRecoverableSessions } = await loadTsModule(MOD);
  const r = selectRecoverableSessions({
    manifests: [
      m({ recordingId: 'old', updatedAt: '2026-06-30T00:00:00.000Z' }),
      m({ recordingId: 'new', updatedAt: '2026-06-30T05:00:00.000Z' }),
      m({ recordingId: 'mid', updatedAt: '2026-06-30T02:00:00.000Z' }),
    ],
    draftRecordingIds: EMPTY,
    stashRecordingIds: EMPTY,
  });
  assert.equal(r.offer.map((x) => x.recordingId).join(','), 'new,mid,old');
});

test('needsServerReconcile: serverRecordingId set + not confirmed', async () => {
  const { needsServerReconcile } = await loadTsModule(MOD);
  assert.equal(needsServerReconcile(m({ serverRecordingId: 'srv1' })), true);
  assert.equal(needsServerReconcile(m()), false);
  assert.equal(needsServerReconcile(m({ serverRecordingId: 'srv1', state: 'uploaded', confirmedUploadAt: 'x' })), false);
});

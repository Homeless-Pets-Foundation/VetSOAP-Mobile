import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const MOD = 'src/lib/durableAudio/manifest.ts';

function validManifest(over = {}) {
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
    adtsFrameCount: 100,
    durationMs: 6400,
    capturedDurationMs: 6400,
    audioFile: { uri: 'file:///data/audio.aac', committedBytes: 5000, completeFrameBytes: 4800 },
    peakDb: -12.5,
    appVersion: '1.13.0',
    buildNumber: '42',
    ...over,
  };
}

test('accepts a well-formed manifest', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  const r = validateManifestObject(validManifest());
  assert.equal(r.ok, true);
  assert.equal(r.manifest.recordingId, 'rec1');
});

test('rejects malformed JSON via parseManifest', async () => {
  const { parseManifest } = await loadTsModule(MOD);
  assert.equal(parseManifest('{not json'), null);
  assert.equal(parseManifest(''), null);
});

test('rejects unsupported schema version', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  assert.equal(validateManifestObject(validManifest({ schemaVersion: 2 })).ok, false);
  assert.equal(validateManifestObject(validManifest({ schemaVersion: 4 })).ok, false);
});

test('rejects path-traversal / invalid ids', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  assert.equal(validateManifestObject(validManifest({ recordingId: '../x' })).ok, false);
  assert.equal(validateManifestObject(validManifest({ userId: 'a/b' })).ok, false);
  assert.equal(validateManifestObject(validManifest({ slotId: '' })).ok, false);
});

test('rejects wrong user id when expectedUserId given', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  assert.equal(validateManifestObject(validManifest(), { expectedUserId: 'user1' }).ok, true);
  assert.equal(validateManifestObject(validManifest(), { expectedUserId: 'other' }).ok, false);
});

test('rejects non-local (remote) audio uri', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  assert.equal(
    validateManifestObject(validManifest({ audioFile: { uri: 'https://evil/a.aac', committedBytes: 1, completeFrameBytes: 1 } })).ok,
    false,
  );
  assert.equal(
    validateManifestObject(validManifest({ audioFile: { uri: 'content://x/a.aac', committedBytes: 1, completeFrameBytes: 1 } })).ok,
    false,
  );
});

test('rejects out-of-range codec/profile fields', async () => {
  const { validateManifestObject } = await loadTsModule(MOD);
  assert.equal(validateManifestObject(validManifest({ container: 'mp4' })).ok, false);
  assert.equal(validateManifestObject(validManifest({ codec: 'he_aac' })).ok, false);
  assert.equal(validateManifestObject(validManifest({ bitrate: 96000 })).ok, false);
  assert.equal(validateManifestObject(validManifest({ sampleRate: 44100 })).ok, false);
  assert.equal(validateManifestObject(validManifest({ channels: 2 })).ok, false);
});

test('isConfirmedUploaded: state uploaded OR confirmedUploadAt', async () => {
  const { isConfirmedUploaded } = await loadTsModule(MOD);
  assert.equal(isConfirmedUploaded(validManifest({ state: 'uploaded' })), true);
  assert.equal(isConfirmedUploaded(validManifest({ confirmedUploadAt: '2026-06-30T00:02:00Z' })), true);
  assert.equal(isConfirmedUploaded(validManifest({ state: 'stopped' })), false);
});

test('shouldOfferRecovery: excludes uploaded + confirmedUploadAt, NOT serverRecordingId alone', async () => {
  const { shouldOfferRecovery } = await loadTsModule(MOD);
  // recoverable: stopped with frames, no confirm
  assert.equal(shouldOfferRecovery(validManifest({ state: 'stopped' })), true);
  // created-but-unconfirmed (serverRecordingId set, no confirmedUploadAt) => still recoverable
  assert.equal(shouldOfferRecovery(validManifest({ state: 'stopped', serverRecordingId: 'srv1' })), true);
  // confirmed-uploaded => excluded
  assert.equal(shouldOfferRecovery(validManifest({ state: 'uploaded', confirmedUploadAt: 'x', serverRecordingId: 'srv1' })), false);
  assert.equal(shouldOfferRecovery(validManifest({ state: 'stopped', confirmedUploadAt: 'x' })), false);
  // idle / zero frames => not recoverable
  assert.equal(shouldOfferRecovery(validManifest({ state: 'idle' })), false);
  assert.equal(shouldOfferRecovery(validManifest({ state: 'stopped', adtsFrameCount: 0 })), false);
});

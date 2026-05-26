import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('record screen checkpoints active recordings through the stopped-state save path', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  assert.match(src, /const RECORDING_CHECKPOINT_MS = 5 \* 60 \* 1000;/);
  assert.match(src, /const BACKGROUND_FLUSH_MIN_MS = 30_000;/);
  assert.match(src, /type RecordingCheckpointReason = 'interval' \| 'background_transition';/);
  assert.match(src, /const requestRecordingCheckpoint = useCallback/);
  assert.match(src, /requestRecordingCheckpoint\('interval'\)/);
  assert.match(src, /requestRecordingCheckpoint\('background_transition'\)/);
  assert.match(src, /checkpointRestartSlotIdRef\.current === slotId/);
  assert.match(src, /saveAudio\(\s*slotId,\s*audioUri,/);
  assert.match(src, /recorderSnapshotRef\.current\(\)/);
  assert.match(src, /checkpoint_saved_direct/);
  assert.match(src, /startRecordingRef\.current\(slotId\);/);
  assert.match(src, /RECORDING_KEEP_AWAKE_TAG/);
});

test('record screen persists PHI-free recovery intent after local draft save and clears it with draft deletion', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  assert.match(src, /recoveryIntent, type RecoveryIntentReason/);
  assert.match(src, /pendingDraftRecoveryReasonRef/);
  assert.match(src, /reason: recoveryReason/);
  assert.match(src, /recoveryIntent\.save\(\{/);
  assert.match(src, /recoveryReason === 'checkpoint' \|\| recoveryReason === 'background_flush'/);
  assert.match(src, /recoveryIntent\.clearForDraftSlot\(draftSlotId\)/);
  assert.match(src, /userId: user\?\.id/);
  assert.match(src, /recoveryIntent\.clearForDraftSlot\(slot\.id\)/);
  assert.match(src, /recoveryIntent\.clearForDraftSlot\(slotId\)/);
});

test('recoveryIntent stores only route and IDs, never draft form data', async () => {
  const src = await read('src/lib/recoveryIntent.ts');

  assert.match(src, /export interface RecoveryIntent/);
  assert.match(src, /userId: string;/);
  assert.match(src, /draftSlotId: string;/);
  assert.match(src, /route: '\/\(tabs\)\/record';/);
  assert.match(src, /reason: RecoveryIntentReason;/);
  assert.doesNotMatch(src, /formData/);
  assert.doesNotMatch(src, /patientName/);
  assert.doesNotMatch(src, /clientName/);
  assert.doesNotMatch(src, /segments/);
  assert.doesNotMatch(src, /SecureStore/);
});

test('auth gates recovered draft routing until local recovery scan completes', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  const appLayout = await read('app/(app)/_layout.tsx');
  const mfaScreen = await read('app/(auth)/mfa.tsx');

  assert.match(provider, /type LocalRecoveryState = 'idle' \| 'scanning' \| 'ready' \| 'error';/);
  assert.match(provider, /const LOCAL_RECOVERY_SCAN_TIMEOUT_MS = 5_000;/);
  assert.match(provider, /scanLocalRecoveryIntent/);
  assert.match(provider, /local_recovery_scan_watchdog_fired/);
  assert.match(provider, /setLocalRecoveryState\('ready'\)/);
  assert.match(provider, /recoveryIntent\.getForUser\(userId\)/);
  assert.match(provider, /draftStorage\.getDraft\(intent\.draftSlotId\)/);
  assert.match(provider, /pendingRecoveryDraftSlotId/);
  assert.match(provider, /consumePendingRecoveryDraftSlotId/);
  assert.match(appLayout, /localRecoveryState === 'scanning'/);
  assert.match(appLayout, /pathname: '\/\(tabs\)\/record'/);
  assert.match(appLayout, /params: \{ draftSlotId \}/);
  assert.match(mfaScreen, /pendingRecoveryDraftSlotId/);
  assert.match(mfaScreen, /consumePendingRecoveryDraftSlotId/);
});

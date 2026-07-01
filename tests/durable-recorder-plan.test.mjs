// Source-invariant guards for the durable-recorder plan
// (docs/prevent-unsaved-recording-loss-plan.md). These lock in the load-bearing
// wiring that unit tests can't exercise on-device.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('native module: package + config + no-throw lazy bridge', async () => {
  const cfg = JSON.parse(await read('modules/captivet-durable-recorder/expo-module.config.json'));
  assert.equal(cfg.android.modules[0], 'expo.modules.captivetdurablerecorder.CaptivetDurableRecorderModule');
  assert.equal(cfg.ios.modules[0], 'CaptivetDurableRecorderModule');
  const index = await read('modules/captivet-durable-recorder/index.ts');
  // Lazy require + graceful degrade (Rule 1/19).
  assert.match(index, /requireOptionalNativeModule/);
  assert.match(index, /class DurableRecorderUnavailableError/);
  // Read ops degrade to null/[] when unavailable (no throw).
  assert.match(index, /export async function listRecoverableSessions/);
});

test('Android module declares a microphone foreground service', async () => {
  const manifest = await read('modules/captivet-durable-recorder/android/src/main/AndroidManifest.xml');
  assert.match(manifest, /foregroundServiceType="microphone"/);
});

test('native encoder failures are not silently swallowed (invariant 12/13)', async () => {
  // Android: drain loop escalates a mid-recording encoder failure instead of
  // leaving mic/wakelock/FGS held with no frames + no JS error.
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.match(kt, /if \(running\) handleFatalWorker\(DurableErrors\.ENCODER/);
  // iOS: consecutive AAC encode errors escalate to a graceful stop (frames kept).
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(swift, /encoderErrorStreak \+= 1/);
  assert.match(swift, /gracefulStopLocked\(reason: "error", errorCode: "encoder_failed"\)/);
  // iOS: resume never drifts the locked sample rate (fail-visibly, no 24 kHz splice).
  assert.match(swift, /buildConverters\(rate: self\.sampleRate, bits: self\.bitrate, allowFallback: false\)/);
  assert.match(swift, /rate == 16000 && allowFallback/);
});

test('recordings.createWithFile: explicit/derived filename, not hardcoded m4a', async () => {
  const src = await read('src/api/recordings.ts');
  // The presign call must not hardcode the filename (it derives it instead).
  assert.doesNotMatch(src, /getUploadUrl\(\s*recording\.id,\s*'recording\.m4a'/);
  assert.match(src, /function deriveUploadFileName/);
  assert.match(src, /options\?\.fileName \?\? deriveUploadFileName/);
  assert.match(src, /'audio\/aac': 'aac'/);
  // create() accepts a deterministic idempotency key; onRecordingCreated fires
  // BEFORE the R2 PUT to anchor serverRecordingId.
  assert.match(src, /idempotencyKey\?: string/);
  assert.match(src, /options\?\.idempotencyKey \?\? generateIdempotencyKey\(\)/);
  assert.match(src, /onRecordingCreated\?/);
});

test('client.ts: 426 is a dedicated terminal-non-auth branch (no refresh/retry)', async () => {
  const src = await read('src/api/client.ts');
  assert.match(src, /response\.status === 426/);
  assert.match(src, /UPGRADE_REQUIRED/);
  // caches min-version + durable flag from response headers
  assert.match(src, /x-minimum-app-version/);
  assert.match(src, /x-durable-capture-enabled/);
});

test('durable capture flag is server-driven, default off', async () => {
  const src = await read('src/lib/durableFlag.ts');
  assert.match(src, /let captureEnabled = false/);
  assert.match(src, /export function isDurableCaptureEnabled/);
});

test('uploadSlot durable order: markUploaded -> deleteDraft -> purge+tombstone', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Upload the truncated complete-frame prefix (durableUploadUri), NOT the raw file.
  assert.match(src, /createWithFile\(\s*slot\.formData,\s*durableUploadUri,\s*'audio\/aac'/);
  assert.match(src, /idempotencyKey: `durable-\$\{durable\.recordingId\}`/);
  assert.match(src, /setServerRecordingId\(\{ userId: uid, recordingId: durable\.recordingId/);
  // markUploaded appears before deleteDraft which appears before purgeAfterUpload.
  const iMark = src.indexOf('.markUploaded({ userId: uid, recordingId: durable.recordingId, confirmedUploadAt');
  const iDelete = src.indexOf('await draftStorage.deleteDraft(slot.id);', iMark);
  const iPurge = src.indexOf('.purgeAfterUpload({ userId: uid, recordingId: durable.recordingId })', iDelete);
  assert.ok(iMark > 0 && iDelete > iMark && iPurge > iDelete, 'durable post-upload order must hold');
  assert.match(src, /durableTombstone\.add\(durable\.recordingId\)/);
  // durable upload bypasses maybeSplitForUpload (that path is for legacy segments).
  assert.match(src, /if \(slot\.durable\) \{/);
});

test('uploadSlot durable: upload only the complete-ADTS-frame prefix', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Truncate to completeFrameBytes only when the file is longer (torn crash tail).
  assert.match(src, /const completeFrameBytes = manifest\?\.audioFile\.completeFrameBytes \?\? 0/);
  assert.match(src, /completeFrameBytes > 0 && completeFrameBytes < durableSizeBytes/);
  assert.match(src, /writeFilePrefix\(durableUri, tempUri, completeFrameBytes\)/);
  // The temp prefix is cleaned up on both success and failure.
  assert.match(src, /if \(durablePrefixTempUri\) safeDeleteFile\(durablePrefixTempUri\)/);
  // fileOps exposes the streaming prefix copy.
  const fileOps = await read('src/lib/fileOps.ts');
  assert.match(fileOps, /export function writeFilePrefix\(sourceUri: string, destUri: string, byteCount: number\): boolean/);
});

test('uploadSlot durable: dirty metadata is patched before promoting the draft', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // The durable branch flushes edited formData to the server draft before promote,
  // mirroring the legacy segment path (finding: stale metadata promoted otherwise).
  const iDurableBranch = src.indexOf('if (slot.durable) {');
  const iPatch = src.indexOf('patchDraftMetadataWithRetry(slot.serverDraftId, slot.formData)', iDurableBranch);
  const iCreateWithFile = src.indexOf("'audio/aac'", iDurableBranch);
  assert.ok(iPatch > iDurableBranch && iPatch < iCreateWithFile,
    'durable branch must patch dirty metadata before createWithFile');
  assert.match(src, /if \(slot\.serverDraftId && slot\.draftMetadataDirty\) \{/);
});

test('draftStorage: durable-aware orphan/audio checks + metadata-only save', async () => {
  const src = await read('src/lib/draftStorage.ts');
  assert.match(src, /if \(slot\.durable\) \{/); // metadata-only durable save branch
  assert.match(src, /meta\.durable && isValidDurableId\(meta\.durable\.recordingId\)/); // draftHasLocalAudio
  // cleanupOrphaned: durable skip-unless-purged + getStatus reconcile + fail closed
  assert.match(src, /const durableId =/);
  assert.match(src, /if \(!getStatus \|\| !isOnline \|\| !draft\.serverDraftId\) \{/);
  assert.match(src, /status === null\) continue; \/\/ unverifiable -> defer/);
});

test('stash round-trip: durable through all 3 Rule 20 sites', async () => {
  const stashTypes = await read('src/types/stash.ts');
  assert.match(stashTypes, /durable\?: DurableSlotRef \| null/); // site 1
  const audioMgr = await read('src/lib/stashAudioManager.ts');
  assert.match(audioMgr, /durable: slot\.durable \?\? null/); // site 2 (write)
  const useStash = await read('src/hooks/useStashedSessions.ts');
  assert.match(useStash, /const durable = slot\.durable \?\? null/); // site 3 (read)
});

test('vault preserves durable manifests as audio', async () => {
  const src = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(src, /function buildSlotHasDurable/);
  assert.match(src, /buildSlotHasDurable\(slot\.durable\)/); // itemHasAudio / filters
  assert.match(src, /durable: draft\.durable \?\? null/);
});

test('AuthProvider runs the durable recovery scan in the post-setUserId one-shot', async () => {
  const src = await read('src/auth/AuthProvider.tsx');
  assert.match(src, /durableTombstone\.setUserId\(scopedUserId\)/);
  assert.match(src, /durableActiveStore\.setUserId\(scopedUserId\)/);
  assert.match(src, /runDurableRecoveryScan\(scopedUserId\)/);
  // scope reset on both sign-out paths (data preserved, only scope cleared)
  const resets = src.match(/durableRecoveryStore\.clear\(\)/g) ?? [];
  assert.ok(resets.length >= 2, `expected >=2 durableRecoveryStore.clear(), found ${resets.length}`);
});

test('record.tsx durable capture: ctx+watchdog, silent-guard peak, Continue blocked, focus skip', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /withDurableOpWatchdog\(\s*recorder\.start\(\{ userId: user\.id, slotId, recordingId \}\)/);
  assert.match(src, /slot\.durable\.peakDb <= SILENT_METERING_THRESHOLD_DB/); // synthetic silent guard
  assert.match(src, /if \(slot\?\.durable\) \{[\s\S]*?Recording Complete/); // Continue blocked
  assert.match(src, /if \(durableActiveRef\.current\) return; \/\/ durable module owns this/);
});

test('analytics defines the durable event catalog', async () => {
  const src = await read('src/lib/analytics.ts');
  for (const name of [
    'durable_recorder_started',
    'durable_process_recovered',
    'durable_recovery_available',
    'durable_upload_confirmed',
    'durable_recorder_op_watchdog',
    'durable_low_space_stop',
    'durable_capture_drop',
    'durable_recorder_unavailable',
  ]) {
    assert.match(src, new RegExp(`name: '${name}'`), name);
  }
});

test('secureStorage.clearAll preserves durable keys (allowlist delete, not wildcard)', async () => {
  const src = await read('src/lib/secureStorage.ts');
  // clearAll must not touch the durable_* prefixes.
  assert.doesNotMatch(src, /captivet_durable_/);
});

test('app.config keeps FGS microphone + wakelock + iOS background audio', async () => {
  const src = await read('app.config.ts');
  assert.match(src, /FOREGROUND_SERVICE_MICROPHONE/);
  assert.match(src, /WAKE_LOCK/);
  assert.match(src, /UIBackgroundModes: \['audio'\]/);
});

test('durable-blind read gates are durable-aware (CRITICAL reachability sweep)', async () => {
  // isDraftResumable + recording-detail resume + recovery-intent scan must treat
  // a valid durable pointer (empty segments) as local audio.
  const draftRec = await read('src/lib/draftRecordings.ts');
  assert.match(draftRec, /if \(draft\.durable && isValidDurableId\(draft\.durable\.recordingId\)\) return true/);
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /durableResumable/);
  assert.match(detail, /isValidDurableId\(match\.durable\.recordingId\)/);
  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /durableIntentAlive/);
  assert.match(auth, /draft\.segments\.length > 0 \|\| durableIntentAlive/);
  // SubmitPanel counts durable-only slots or Submit All hides for durable sessions.
  const panel = await read('src/components/SubmitPanel.tsx');
  assert.match(panel, /s\.segments\.length > 0 \|\| s\.durable !== null/);
  // Stash orphan recovery keeps a durable-only stash dir.
  const stashMgr = await read('src/lib/stashAudioManager.ts');
  assert.match(stashMgr, /s\.segments\.length > 0 \|\| s\.durable != null/);
});

test('durable free-space gate + hook start timeout are wired', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // Pre-record 500/250 MiB gate is actually CALLED (was dead code).
  assert.match(rec, /const spaceGate = checkPreRecordFreeSpace\(\)/);
  assert.match(rec, /if \(spaceGate === 'block'\)/);
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // Hook-internal durable start timeout (unwinds isStartingRef on a hung native start).
  assert.match(hook, /DURABLE_START_TIMEOUT_MS/);
  // The native start is captured then raced against the timeout, so a LATE-
  // resolving start (after we fell back to expo) can be discarded to release the
  // mic/foreground service instead of orphaning the capture.
  assert.match(hook, /const startPromise = durableRecorder\.start\(/);
  assert.match(hook, /Promise\.race\(\[\s*startPromise/);
  assert.match(hook, /durableStartTimedOut = true/);
  assert.match(hook, /if \(durableStartTimedOut\) \{[\s\S]*?durableRecorder\s*\.discard\(/);
});

test('support-staff vault preserves durable BYTES + cross-user recovered upload', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  // Durable audio.aac is COPIED into the neutral vault dir (not just the pointer).
  assert.match(vault, /function copyDurableAudioToRecovery/);
  assert.match(vault, /recoveredAudioUri: copiedUri/);
  // countScoped is durable-aware.
  assert.match(vault, /buildSlotHasDurable\(draft\.durable\)/);
  // record.tsx uploads the recovered copy when there is no native manifest.
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /const hasNativeManifest = !!manifest/);
  assert.match(rec, /durable\.recoveredAudioUri/);
  assert.match(rec, /if \(hasNativeManifest\) \{[\s\S]*?markUploaded/);
});

// ── Codex-review regression guards (durable submit-reachability + recovery) ──

test('durable-only slots are submit-reachable (per-patient + Submit All)', async () => {
  // PatientSlotCard: the Submit card must show for a durable slot with empty segments.
  const card = await read('src/components/PatientSlotCard.tsx');
  assert.match(card, /const hasCapturedAudio = hasSegments \|\| !!slot\.durable/);
  assert.match(card, /showSubmitCard = \(recordFirstEnabled \|\| hasRequiredFields\) && hasCapturedAudio/);
  // SubmitPanel already counts durable audio.
  const panel = await read('src/components/SubmitPanel.tsx');
  assert.match(panel, /s\.segments\.length > 0 \|\| s\.durable !== null/);
  // Submit All + post-single-submit "others remaining" both include durable slots.
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /\(s\.segments\.length > 0 \|\| !!s\.durable\) &&\s*\n\s*s\.uploadStatus !== 'success'/);
  assert.match(rec, /s\.segments\.length > 0 \|\| !!s\.durable \|\| s\.audioState === 'recording'/);
});

test('interrupted durable capture attributes committed duration (not 0)', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // committedThroughMs is mirrored into a ref and folded into the durable duration
  // on interruption so a finish taken from the snapshot never saves durationMs=0.
  assert.match(hook, /committedThroughMsRef\.current = e\.committedThroughMs/);
  assert.match(hook, /durableDurationMsRef\.current = Math\.max\(\s*durableDurationMsRef\.current,\s*committedThroughMsRef\.current,?\s*\)/);
});

test('record start is gated by the server min-version floor', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /import \{ getRecordStartGate \} from '\.\.\/\.\.\/\.\.\/src\/lib\/minVersion'/);
  // Gate consulted at the single mic-start funnel (fresh + Resume→Continue).
  const iFn = rec.indexOf('const startRecordingForSlot = useCallback(');
  const iGate = rec.indexOf("getRecordStartGate() === 'block'", iFn);
  const iInFlight = rec.indexOf('startInFlightRef.current = true;', iFn);
  assert.ok(iGate > iFn && iGate < iInFlight, 'min-version gate must run before start proceeds');
});

test('recovered durable draft preserves the death-surviving server anchor', async () => {
  const draft = await read('src/lib/draftStorage.ts');
  // saveDraft falls back to slot.serverDraftId when no local draft exists yet.
  assert.match(draft, /const resolvedServerDraftId = existingDurable\?\.serverDraftId \?\? slot\.serverDraftId \?\? null/);
  assert.match(draft, /serverDraftId: resolvedServerDraftId/);
  assert.match(draft, /pendingSync: existingDurable\?\.serverDraftId\s*\?\s*existingDurable\.pendingSync\s*:\s*!resolvedServerDraftId/);
});

test('native self-heal scan returns confirmed-uploaded-but-not-purged manifests', async () => {
  // JS routes confirmed-uploaded manifests to the selfHeal bucket (never offer).
  const logic = await read('src/lib/durableAudio/recoveryLogic.ts');
  assert.match(logic, /if \(isConfirmedUploaded\(manifest\)\) \{[\s\S]*?selfHeal\.push\(manifest\)/);
  // Android: return the uploaded manifest instead of dropping it (was `return null`).
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.match(kt, /if \(m\.state == DurableState\.UPLOADED \|\| !m\.confirmedUploadAt\.isNullOrEmpty\(\)\) \{[\s\S]*?return m\.toMap\(\)/);
  // iOS: return the uploaded manifest instead of `continue`.
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(swift, /if manifest\.isConfirmedUploaded \{[\s\S]*?results\.append\(manifest\.toDictionary\(\)\)/);
});

test('iOS benign route change does not emit a fatal interruption', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  // The default (non-oldDeviceUnavailable) route-change branch fsyncs but must NOT
  // emit "interruption" (JS treats every interruption as fatal → orphaned capture).
  const iDefault = swift.indexOf('// Non-fatal route change (new device available, category change)');
  assert.ok(iDefault > 0, 'benign route-change branch must exist');
  const iMediaReset = swift.indexOf('@objc private func handleMediaReset', iDefault);
  const branch = swift.slice(iDefault, iMediaReset);
  assert.doesNotMatch(branch, /emit\("interruption"/);
});

test('recovered slot ids are unique (no constant "recovered" collision)', async () => {
  // JS derives the draft/slot id from the unique recordingId, not manifest.slotId.
  const screen = await read('app/(app)/durable-recovery.tsx');
  assert.match(screen, /const slotId = m\.recordingId/);
  assert.match(screen, /draftSlotId: slotId/);
  assert.match(screen, /params: \{ draftSlotId: m\.recordingId \}/);
  // Android orphan synthesis uses recordingId as slotId (iOS parity), not "recovered".
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.doesNotMatch(kt, /slotId = "recovered"/);
});
